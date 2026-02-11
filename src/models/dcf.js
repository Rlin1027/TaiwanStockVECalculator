// ── Model A: DCF 估值模型 ──
// 重構自 n8n_nodes/dcf_valuation_logic.js，移除 n8n 依賴
// 改為純函式，接收結構化數據，輸出結構化結果

import { DCF_CONFIG, getWACC, getSector } from '../config.js';

/**
 * 從 FinMind 財報數據中提取指定 type 的年度數值
 * 回傳按日期降序排列的 { date, value } 陣列
 */
function extractByType(records, type) {
  return records
    .filter(d => d.type === type)
    .map(d => ({ date: d.date, value: parseFloat(d.value) }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

/**
 * 取得最新一筆的 value（若無則回傳 fallback）
 */
function latestValue(records, type, fallback = 0) {
  const items = extractByType(records, type);
  return items.length > 0 ? items[0].value : fallback;
}

/**
 * 計算 CAGR（複合年增長率）
 * @param {number[]} values - 按時間降序排列的值（[最新, ..., 最舊]）
 * @param {number} years - 跨越年數
 */
function calcCAGR(values, years) {
  if (values.length < 2 || years <= 0) return null;
  const latest = values[0];
  const oldest = values[values.length - 1];
  if (oldest <= 0 || latest <= 0) return null;
  return Math.pow(latest / oldest, 1 / years) - 1;
}

/**
 * 從累計式 YTD 現金流資料中提取年度數值
 * FinMind 現金流量表為累計 YTD：Q1, Q1+Q2, Q1+Q2+Q3, Full Year (Q4/12月)
 * 回傳年度值，按年份降序排列
 */
function extractAnnualCashFlow(records, type) {
  const filtered = records
    .filter(d => d.type === type)
    .map(d => ({ date: d.date, value: parseFloat(d.value) }));

  const byYear = {};
  for (const d of filtered) {
    const year = d.date.slice(0, 4);
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(d);
  }

  const annuals = [];
  for (const [year, entries] of Object.entries(byYear)) {
    const sorted = entries.sort((a, b) => new Date(b.date) - new Date(a.date));
    const latest = sorted[0];
    const month = parseInt(latest.date.slice(5, 7));

    if (month === 12) {
      annuals.push({ year, value: latest.value, complete: true });
    } else {
      const quarterCount = Math.ceil(month / 3);
      annuals.push({ year, value: latest.value * (4 / quarterCount), complete: false });
    }
  }

  return annuals.sort((a, b) => b.year.localeCompare(a.year));
}

/**
 * 將單季財報資料彙整為年度總計
 * FinMind 損益表為單季數據，需要加總 4 季為年度值
 * 回傳按年份降序排列
 */
function aggregateAnnualFinancials(records, type) {
  const filtered = records
    .filter(d => d.type === type)
    .map(d => ({ date: d.date, value: parseFloat(d.value) }));

  const byYear = {};
  for (const d of filtered) {
    const year = d.date.slice(0, 4);
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(d.value);
  }

  const annuals = [];
  for (const [year, values] of Object.entries(byYear)) {
    const sum = values.reduce((s, v) => s + v, 0);
    annuals.push({ year, value: sum, quarters: values.length });
  }

  return annuals.sort((a, b) => b.year.localeCompare(a.year));
}

/**
 * DCF 估值主函式
 *
 * @param {object} params
 * @param {string} params.ticker - 股票代號
 * @param {Array}  params.financials - TaiwanStockFinancialStatements 原始數據
 * @param {Array}  params.cashFlows  - TaiwanStockCashFlowsStatement 原始數據
 * @param {number} params.currentPrice - 目前股價
 * @param {object} [params.overrides] - 可覆寫的參數（wacc, growthRate 等）
 * @returns {object} DCFResult
 */
export function calculateDCF({ ticker, financials, cashFlows, currentPrice, overrides = {} }) {
  const wacc = overrides.wacc ?? getWACC(ticker);
  const sector = getSector(ticker);
  const {
    terminalGrowthRate,
    projectionYears,
    maxGrowthRate,
    minGrowthRate,
    marginOfSafety,
    taxRate,
  } = { ...DCF_CONFIG, ...overrides };

  // ── 1. 提取 FCF 基礎數據（年度值） ──
  // 現金流為累計 YTD，需取完整年度（Q4/12月）或年化
  const annualOpCF = extractAnnualCashFlow(cashFlows, 'CashFlowsFromOperatingActivities');
  const annualCapEx = extractAnnualCashFlow(cashFlows, 'PropertyAndPlantAndEquipment');

  // 優先使用最近的完整年度，否則用年化值
  const opCFEntry = annualOpCF.find(d => d.complete) || annualOpCF[0];
  const capExEntry = annualCapEx.find(d => d.complete) || annualCapEx[0];

  const opCashFlow = opCFEntry?.value || 0;
  const capEx = Math.abs(capExEntry?.value || 0);

  // 營業利益（備用，使用年度匯總）
  const annualOpIncome = aggregateAnnualFinancials(financials, 'OperatingIncome');
  const opIncome = annualOpIncome.length > 0 ? annualOpIncome[0].value : 0;

  // FCF = 營運現金流 - 資本支出（若無營運現金流，用 NOPAT 代替）
  let fcfBase;
  let fcfMethod;
  if (opCashFlow !== 0) {
    fcfBase = opCashFlow - capEx;
    fcfMethod = `營運現金流 - 資本支出（${opCFEntry?.complete ? opCFEntry.year + ' 全年' : '年化估算'}）`;
  } else {
    fcfBase = (opIncome * (1 - taxRate)) - capEx;
    fcfMethod = 'NOPAT 估算 (營業利益 × (1-稅率) - 資本支出)';
  }

  // ── 2. 成長率估算（使用年度匯總數據） ──
  // 營收 CAGR（將單季數據彙整為年度）
  const annualRevenues = aggregateAnnualFinancials(financials, 'Revenue');
  // 僅使用完整年度（4 季）的數據來計算 CAGR
  const completeRevenues = annualRevenues.filter(r => r.quarters === 4);
  const revenueValues = completeRevenues.map(r => r.value);

  let revCAGR = null;
  if (revenueValues.length >= 2) {
    const yearSpan = Math.min(revenueValues.length - 1, 4);
    revCAGR = calcCAGR(revenueValues.slice(0, yearSpan + 1), yearSpan);
  }

  // EPS CAGR（交叉驗證用，同樣年度匯總）
  const annualEPS = aggregateAnnualFinancials(financials, 'EPS');
  const completeEPS = annualEPS.filter(r => r.quarters === 4);
  const epsValues = completeEPS.map(r => r.value);

  let epsCAGR = null;
  if (epsValues.length >= 2) {
    const yearSpan = Math.min(epsValues.length - 1, 4);
    epsCAGR = calcCAGR(epsValues.slice(0, yearSpan + 1), yearSpan);
  }

  // 取兩者較保守的值（若都無，用預設 5%）
  let growthRate;
  if (revCAGR !== null && epsCAGR !== null) {
    growthRate = Math.min(revCAGR, epsCAGR); // 保守取低
  } else {
    growthRate = revCAGR ?? epsCAGR ?? 0.05;
  }

  // 限制範圍
  growthRate = Math.max(minGrowthRate, Math.min(maxGrowthRate, growthRate));

  // ── 3. 流通股數推算 ──
  const netIncome = latestValue(financials, 'IncomeAfterTaxes');
  const eps = latestValue(financials, 'EPS');

  let sharesOutstanding;
  let sharesMethod;
  if (eps !== 0 && netIncome !== 0) {
    // FinMind 的 IncomeAfterTaxes 單位是千元，EPS 是元
    // sharesOutstanding = (netIncome * 1000) / eps 會得到股數
    // 但實際上 FinMind 的 value 可能已經是完整數值
    // 先用 netIncome / eps，再檢查合理性
    const rawShares = Math.abs(netIncome / eps);

    // 合理性檢查：台股一般流通股數在 1 億 ~ 300 億之間
    if (rawShares > 1e7 && rawShares < 3e11) {
      sharesOutstanding = rawShares;
      sharesMethod = '稅後淨利 / EPS';
    } else {
      // 可能單位不同，嘗試千元轉換
      const adjusted = Math.abs((netIncome * 1000) / eps);
      if (adjusted > 1e7 && adjusted < 3e11) {
        sharesOutstanding = adjusted;
        sharesMethod = '稅後淨利(千元) / EPS';
      } else {
        sharesOutstanding = 1e9;
        sharesMethod = '預設值 (10億股)';
      }
    }
  } else {
    sharesOutstanding = 1e9;
    sharesMethod = '預設值 (10億股)';
  }

  // ── 4. DCF 現金流預測 ──
  const projections = [];
  let sumPV = 0;

  for (let i = 1; i <= projectionYears; i++) {
    const projectedFCF = fcfBase * Math.pow(1 + growthRate, i);
    const discountFactor = Math.pow(1 + wacc, i);
    const pv = projectedFCF / discountFactor;
    projections.push({ year: i, fcf: projectedFCF, pv });
    sumPV += pv;
  }

  // ── 5. 終端價值（Gordon Growth Model）──
  const lastYearFCF = projections[projectionYears - 1].fcf;
  const terminalValue = (lastYearFCF * (1 + terminalGrowthRate)) / (wacc - terminalGrowthRate);
  const terminalValuePV = terminalValue / Math.pow(1 + wacc, projectionYears);
  const totalPV = sumPV + terminalValuePV;

  // ── 6. 每股合理價 ──
  const fairValue = totalPV / sharesOutstanding;
  const fairValueWithMargin = fairValue * (1 - marginOfSafety);
  const upside = currentPrice > 0
    ? ((fairValue - currentPrice) / currentPrice) * 100
    : 0;

  // ── 7. 終端價值佔比檢查（健康範圍: 50-80%）──
  const terminalRatio = totalPV > 0 ? (terminalValuePV / totalPV) * 100 : 0;
  const terminalWarning = terminalRatio > 85
    ? '終端價值佔比偏高，估值對長期假設敏感'
    : terminalRatio < 40
      ? '終端價值佔比偏低，短期現金流主導'
      : null;

  return {
    ticker,
    sector,
    currentPrice,
    fairValue: round(fairValue),
    fairValueWithMargin: round(fairValueWithMargin),
    upside: round(upside),
    signal: upside > 20 ? 'UNDERVALUED' : upside < -10 ? 'OVERVALUED' : 'FAIR',
    details: {
      fcfBase: round(fcfBase),
      fcfMethod,
      growthRate: round(growthRate * 100),
      revCAGR: revCAGR !== null ? round(revCAGR * 100) : null,
      epsCAGR: epsCAGR !== null ? round(epsCAGR * 100) : null,
      wacc: round(wacc * 100),
      terminalGrowthRate: round(terminalGrowthRate * 100),
      projectionYears,
      sharesOutstanding: Math.round(sharesOutstanding),
      sharesMethod,
      terminalValuePV: round(terminalValuePV),
      terminalRatio: round(terminalRatio),
      terminalWarning,
      sumProjectedPV: round(sumPV),
      totalEnterpriseValue: round(totalPV),
      projections,
    },
  };
}

function round(n, d = 2) {
  return Math.round(n * 10 ** d) / 10 ** d;
}
