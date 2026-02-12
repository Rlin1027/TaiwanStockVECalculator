// ── Model E: EV/EBITDA 估值模型 ──
// 機構投資人常用指標，消除資本結構和折舊政策的影響
// 使用歷史 EV/EBITDA 分布判斷目前估值水位，反推合理價

import {
  aggregateAnnualFinancials,
  extractAnnualCashFlow,
  estimateSharesOutstanding,
  round,
  mean,
  stddev,
} from './utils.js';

/**
 * 從資產負債表取得指定類別的最新值
 * 嘗試多個可能的 type 名稱
 */
function getBalanceSheetValue(balanceSheet, typeNames) {
  const sorted = [...balanceSheet].sort(
    (a, b) => new Date(b.date) - new Date(a.date),
  );
  for (const type of typeNames) {
    const record = sorted.find(d => d.type === type);
    if (record) {
      const val = parseFloat(record.value);
      if (!isNaN(val)) return val;
    }
  }
  return null;
}

/**
 * 從資產負債表取得某年度指定類別的值
 */
function getBalanceSheetValueByYear(balanceSheet, typeNames, year) {
  const yearRecords = balanceSheet.filter(d => d.date.startsWith(year));
  const sorted = yearRecords.sort(
    (a, b) => new Date(b.date) - new Date(a.date),
  );
  for (const type of typeNames) {
    const record = sorted.find(d => d.type === type);
    if (record) {
      const val = parseFloat(record.value);
      if (!isNaN(val)) return val;
    }
  }
  return null;
}

// 資產負債表欄位候選名稱
const LIABILITY_TYPES = [
  'TotalLiabilities',
  'Liabilities',
  'TotalNonCurrentLiabilities',
  'NonCurrentLiabilities',
];
const CASH_TYPES = [
  'CashAndCashEquivalents',
  'Cash',
  'CashCashEquivalentsAndShortTermInvestments',
];

/**
 * EV/EBITDA 估值分析
 *
 * FinMind 財報數據可能以「千元」為單位。estimateSharesOutstanding 回傳的
 * method 包含「千元」時，表示原始數值需乘以 1000 才是實際 NTD。
 * 本模型透過 unitMultiplier 統一將所有財報金額轉為 NTD，確保與
 * marketCap（= price × shares）的單位一致。
 *
 * @param {object} params
 * @param {string} params.ticker - 股票代號
 * @param {Array}  params.financials - TaiwanStockFinancialStatements 原始數據
 * @param {Array}  params.cashFlows  - TaiwanStockCashFlowsStatement 原始數據
 * @param {Array}  params.balanceSheet - TaiwanStockBalanceSheet 原始數據
 * @param {number} params.currentPrice - 目前股價
 * @returns {object} EVEBITDAResult
 */
export function analyzeEVEBITDA({
  ticker,
  financials,
  cashFlows,
  balanceSheet,
  currentPrice,
}) {
  // ── 1. 估算流通股數 ──
  const sharesResult = estimateSharesOutstanding(financials);
  if (!sharesResult) {
    return {
      ticker,
      available: false,
      reason: '無法估算流通股數，EV/EBITDA 模型不適用',
    };
  }
  const sharesOutstanding = sharesResult.shares;

  // 若 shares 是透過千元修正路徑計算的，財報原始值為千元，需 ×1000 轉 NTD
  const unitMultiplier = sharesResult.method.includes('千元') ? 1000 : 1;

  // ── 2. 計算年度 EBITDA ──
  const annualOpIncome = aggregateAnnualFinancials(
    financials,
    'OperatingIncome',
  );

  if (annualOpIncome.length === 0) {
    return {
      ticker,
      available: false,
      reason: '無營業利益數據，EV/EBITDA 模型不適用',
    };
  }

  // 折舊攤銷：嘗試多個可能的 type 名稱
  const depreciationTypes = [
    'Depreciation',
    'DepreciationExpense',
    'DepreciationAndAmortization',
    'DepreciationAmortisation',
  ];

  let annualDepreciation = [];
  for (const depType of depreciationTypes) {
    annualDepreciation = extractAnnualCashFlow(cashFlows, depType);
    if (annualDepreciation.length > 0) break;
  }

  // 計算各年度 EBITDA（轉為 NTD）
  const annualEBITDA = [];
  for (const opEntry of annualOpIncome) {
    if (opEntry.quarters < 4) continue; // 只用完整年度

    const depEntry = annualDepreciation.find(d => d.year === opEntry.year);
    let ebitdaRaw;
    if (depEntry) {
      ebitdaRaw = opEntry.value + Math.abs(depEntry.value);
    } else {
      // 無折舊數據時，用營業利益的 1.35 倍近似
      ebitdaRaw = opEntry.value * 1.35;
    }

    const ebitda = ebitdaRaw * unitMultiplier;
    if (ebitda > 0) {
      annualEBITDA.push({ year: opEntry.year, value: ebitda });
    }
  }

  if (annualEBITDA.length === 0) {
    return {
      ticker,
      available: false,
      reason: 'EBITDA 為負或數據不足',
    };
  }

  // 最近完整年度
  const currentEBITDA = annualEBITDA[0].value;

  // ── 3. 從資產負債表取得負債與現金（轉為 NTD） ──
  let totalDebtRaw = getBalanceSheetValue(balanceSheet, LIABILITY_TYPES);
  let cashRaw = getBalanceSheetValue(balanceSheet, CASH_TYPES);

  if (totalDebtRaw === null) {
    return {
      ticker,
      available: false,
      reason: '無法取得負債數據',
    };
  }
  if (cashRaw === null) cashRaw = 0;

  const totalDebt = totalDebtRaw * unitMultiplier;
  const cash = cashRaw * unitMultiplier;

  // ── 4. 計算當前 EV 與 EV/EBITDA ──
  const marketCap = currentPrice * sharesOutstanding;
  const ev = marketCap + totalDebt - cash;
  const currentEVEBITDA = ev / currentEBITDA;

  // ── 5. 計算歷史 EV/EBITDA（近 5 年） ──
  const historicalRatios = [];
  const recentYears = annualEBITDA.slice(0, 5);

  for (const ebitdaEntry of recentYears) {
    const yearDebtRaw = getBalanceSheetValueByYear(
      balanceSheet,
      LIABILITY_TYPES,
      ebitdaEntry.year,
    );
    const yearCashRaw = getBalanceSheetValueByYear(
      balanceSheet,
      CASH_TYPES,
      ebitdaEntry.year,
    );

    if (yearDebtRaw !== null) {
      const yearDebt = yearDebtRaw * unitMultiplier;
      const yearCash = (yearCashRaw || 0) * unitMultiplier;
      // 用當前市值近似歷史市值（簡化處理）
      const yearEV = marketCap + yearDebt - yearCash;
      const ratio = yearEV / ebitdaEntry.value;
      if (ratio > 0 && ratio < 200 && isFinite(ratio)) {
        historicalRatios.push(ratio);
      }
    }
  }

  // 加入當前的 EV/EBITDA
  if (currentEVEBITDA > 0 && currentEVEBITDA < 200 && isFinite(currentEVEBITDA)) {
    historicalRatios.push(currentEVEBITDA);
  }

  if (historicalRatios.length < 3) {
    return {
      ticker,
      available: false,
      reason: `歷史 EV/EBITDA 數據不足（${historicalRatios.length} 筆，需至少 3 筆）`,
    };
  }

  // ── 6. 統計：平均值與標準差 ──
  const avgEVEBITDA = mean(historicalRatios);
  const stdEVEBITDA = stddev(historicalRatios);

  // ── 7. 帶狀區間 ──
  const bands = {
    minus2SD: round(avgEVEBITDA - 2 * stdEVEBITDA),
    cheap: round(avgEVEBITDA - stdEVEBITDA),
    mean: round(avgEVEBITDA),
    expensive: round(avgEVEBITDA + stdEVEBITDA),
    plus2SD: round(avgEVEBITDA + 2 * stdEVEBITDA),
  };

  // ── 8. 反推合理價 ──
  // fairPrice = (avgEVEBITDA * currentEBITDA - totalDebt + cash) / sharesOutstanding
  const fairEV = avgEVEBITDA * currentEBITDA;
  const fairValue = (fairEV - totalDebt + cash) / sharesOutstanding;
  const upside =
    currentPrice > 0
      ? ((fairValue - currentPrice) / currentPrice) * 100
      : 0;

  // ── 9. 判斷位置 ──
  let position;
  if (currentEVEBITDA < avgEVEBITDA - stdEVEBITDA) {
    position = '便宜';
  } else if (currentEVEBITDA > avgEVEBITDA + stdEVEBITDA) {
    position = '昂貴';
  } else {
    position = '合理';
  }

  // ── 10. 信號 ──
  let signal;
  if (position === '便宜') {
    signal = 'UNDERVALUED';
  } else if (position === '昂貴') {
    signal = 'OVERVALUED';
  } else {
    signal = 'FAIR';
  }

  return {
    ticker,
    available: true,
    fairValue: round(fairValue),
    upside: round(upside),
    signal,
    currentEVEBITDA: round(currentEVEBITDA),
    avgEVEBITDA: round(avgEVEBITDA),
    stdEVEBITDA: round(stdEVEBITDA),
    position,
    ebitda: round(currentEBITDA),
    ev: round(ev),
    totalDebt: round(totalDebt),
    cash: round(cash),
    bands,
  };
}
