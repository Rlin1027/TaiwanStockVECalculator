// ── Model E: CapEx 資本支出估值模型 ──
// CapEx-Forward PER：用 CapEx 成長率推算未來營收成長，轉換為前瞻 EPS，乘以歷史 PER 得合理價
// 核心論點：今天的 CapEx → 明天的產能 → 後天的營收 → 未來盈餘 → 合理價

import { calcCAGR, extractAnnualCashFlow, aggregateAnnualFinancials, calcTTM_EPS, round } from './utils.js';

/**
 * CapEx 估值分析
 *
 * @param {object} params
 * @param {string} params.ticker - 股票代號
 * @param {Array}  params.financials - TaiwanStockFinancialStatements 原始數據
 * @param {Array}  params.cashFlows  - TaiwanStockCashFlowsStatement 原始數據
 * @param {object} params.per - analyzePER() 的結果（取 avgPE）
 * @param {number} params.currentPrice - 目前股價
 * @returns {object} CapExResult
 */
export function analyzeCapEx({ ticker, financials, cashFlows, per, currentPrice }) {
  // ── Step 1：提取 & 平滑 CapEx ──
  const annualCapEx = extractAnnualCashFlow(cashFlows, 'PropertyAndPlantAndEquipment');

  // 取絕對值（CapEx 在現金流表中通常為負值）
  const capExEntries = annualCapEx
    .filter(d => d.complete)
    .map(d => ({ year: d.year, value: Math.abs(d.value) }));

  if (capExEntries.length < 4) {
    return {
      available: false,
      reason: `CapEx 年度數據不足（僅 ${capExEntries.length} 年，需至少 4 年）`,
    };
  }

  // 2 年滾動平均消除塊狀性（lumpiness）
  const smoothedCapEx = [];
  for (let i = 0; i < capExEntries.length - 1; i++) {
    smoothedCapEx.push({
      year: capExEntries[i].year,
      value: (capExEntries[i].value + capExEntries[i + 1].value) / 2,
    });
  }

  if (smoothedCapEx.length < 3) {
    return {
      available: false,
      reason: '平滑後 CapEx 數據不足（需至少 3 年）',
    };
  }

  // ── Step 2：計算 CapEx CAGR ──
  const smoothedValues = smoothedCapEx.map(d => d.value);
  const capExYears = Math.min(smoothedValues.length - 1, 4);
  let capExCAGR = calcCAGR(smoothedValues.slice(0, capExYears + 1), capExYears);

  if (capExCAGR === null) {
    return {
      available: false,
      reason: 'CapEx CAGR 無法計算（數值異常）',
    };
  }

  // 限制範圍 [-20%, +50%]
  capExCAGR = Math.max(-0.20, Math.min(0.50, capExCAGR));

  // ── Step 3：計算 CapEx → 營收傳導比率 ──
  const annualRevenues = aggregateAnnualFinancials(financials, 'Revenue');
  const completeRevenues = annualRevenues.filter(r => r.quarters === 4);
  const revenueValues = completeRevenues.map(r => r.value);

  let revCAGR = null;
  if (revenueValues.length >= 2) {
    const revYears = Math.min(revenueValues.length - 1, 4);
    revCAGR = calcCAGR(revenueValues.slice(0, revYears + 1), revYears);
  }

  let transmissionRatio;
  if (capExCAGR !== 0 && Math.abs(capExCAGR) > 0.01 && revCAGR !== null) {
    transmissionRatio = revCAGR / capExCAGR;
    // 限制範圍 [0.2, 1.5]
    transmissionRatio = Math.max(0.2, Math.min(1.5, transmissionRatio));
  } else {
    transmissionRatio = 0.5; // 預設值
  }

  // ── Step 4：前瞻營收成長率 ──
  if (smoothedCapEx[1].value === 0) {
    return {
      available: false,
      reason: 'CapEx 基期為零，無法計算成長率',
    };
  }
  const recentCapExGrowth = smoothedCapEx[0].value / smoothedCapEx[1].value - 1;
  let forwardRevenueGrowth = recentCapExGrowth * transmissionRatio;
  // 限制範圍 [0%, 40%]
  forwardRevenueGrowth = Math.max(0, Math.min(0.40, forwardRevenueGrowth));

  // ── Step 5：前瞻盈餘成長率（營業槓桿） ──
  const annualOpIncome = aggregateAnnualFinancials(financials, 'OperatingIncome');
  const completeOpIncome = annualOpIncome.filter(r => r.quarters === 4);
  const opIncomeValues = completeOpIncome.map(r => r.value);

  let opIncomeCAGR = null;
  if (opIncomeValues.length >= 2) {
    const opYears = Math.min(opIncomeValues.length - 1, 4);
    opIncomeCAGR = calcCAGR(opIncomeValues.slice(0, opYears + 1), opYears);
  }

  let operatingLeverage;
  if (opIncomeCAGR !== null && revCAGR !== null && revCAGR > 0.01) {
    operatingLeverage = opIncomeCAGR / revCAGR;
    // 限制範圍 [0.5, 2.5]
    operatingLeverage = Math.max(0.5, Math.min(2.5, operatingLeverage));
  } else {
    operatingLeverage = 1.0; // 預設
  }

  const forwardEarningsGrowth = forwardRevenueGrowth * operatingLeverage;

  // ── Step 6：前瞻 EPS ──
  const ttmEPS = calcTTM_EPS(financials);
  if (!ttmEPS || ttmEPS <= 0) {
    return {
      available: false,
      reason: 'EPS 為負或數據不足，CapEx 模型不適用',
    };
  }

  const forwardEPS = ttmEPS * (1 + forwardEarningsGrowth);

  // ── Step 7：合理價 ──
  let avgPE, peSource;
  if (per?.available && per.avgPE > 0) {
    avgPE = per.avgPE;
    peSource = `歷史平均 PER（${avgPE}x）`;
  } else {
    avgPE = 12;
    peSource = '預設 PER（12x，PER 模型不可用）';
  }

  const fairValue = forwardEPS * avgPE;

  if (fairValue <= 0) {
    return {
      available: false,
      reason: '前瞻合理價為負值，模型不適用',
    };
  }

  const upside = currentPrice > 0
    ? ((fairValue - currentPrice) / currentPrice) * 100
    : 0;

  // ── Step 8：CapEx 強度（用於權重） ──
  const capExIntensities = [];
  for (const ce of capExEntries) {
    const revEntry = completeRevenues.find(r => r.year === ce.year);
    if (revEntry && revEntry.value > 0) {
      capExIntensities.push(ce.value / revEntry.value);
    }
  }

  const capExIntensity = capExIntensities.length > 0
    ? capExIntensities.reduce((s, v) => s + v, 0) / capExIntensities.length
    : 0;

  let sectorConfidence;
  if (capExIntensity > 0.15) {
    sectorConfidence = 'HIGH';
  } else if (capExIntensity >= 0.05) {
    sectorConfidence = 'MEDIUM';
  } else {
    sectorConfidence = 'LOW';
  }

  // 信號判定
  let signal;
  if (upside > 20) {
    signal = 'UNDERVALUED';
  } else if (upside < -10) {
    signal = 'OVERVALUED';
  } else {
    signal = 'FAIR';
  }

  return {
    available: true,
    fairValue: round(fairValue),
    upside: round(upside),
    signal,
    capExCAGR: round(capExCAGR * 100),
    recentCapExGrowth: round(recentCapExGrowth * 100),
    capExIntensity: round(capExIntensity * 100),
    sectorConfidence,
    transmissionRatio: round(transmissionRatio, 2),
    operatingLeverage: round(operatingLeverage, 2),
    forwardRevenueGrowth: round(forwardRevenueGrowth * 100),
    forwardEarningsGrowth: round(forwardEarningsGrowth * 100),
    ttmEPS: round(ttmEPS),
    forwardEPS: round(forwardEPS),
    avgPE: round(avgPE),
    peSource,
  };
}
