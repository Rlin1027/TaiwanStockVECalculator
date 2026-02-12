// ── Model A: DCF 估值模型 ──
// 重構自 n8n_nodes/dcf_valuation_logic.js，移除 n8n 依賴
// 改為純函式，接收結構化數據，輸出結構化結果

import { DCF_CONFIG, SECTOR_GROWTH_CAP, getWACC, getSector } from '../config.js';
import { calcGrowthAdjustment } from './momentum.js';
import { calcCAGR, extractAnnualCashFlow, aggregateAnnualFinancials, round, estimateSharesOutstanding } from './utils.js';

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
export function calculateDCF({ ticker, financials, cashFlows, currentPrice, momentum = null, stockInfo = null, overrides = {} }) {
  const sector = getSector(ticker, stockInfo);
  const wacc = overrides.wacc ?? getWACC(ticker, sector);
  const sectorGrowthCap = SECTOR_GROWTH_CAP[sector] ?? SECTOR_GROWTH_CAP['default'] ?? 0.30;
  const {
    terminalGrowthRate,
    projectionYears,
    highGrowthYears,
    decayYears,
    matureGrowthRate,
    minGrowthRate,
    marginOfSafety,
    taxRate,
  } = { ...DCF_CONFIG, ...overrides };
  // 使用產業成長率上限（週期性 10%，一般 30%）
  const maxGrowthRate = overrides.maxGrowthRate ?? sectorGrowthCap;

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

  // ── 週期性產業 FCF 正規化：使用 5 年平均 FCF ──
  if (sector === '週期性' && annualOpCF.length >= 3) {
    const annualFCFs = [];
    for (const yearEntry of annualOpCF.slice(0, 5)) {
      const matchCapEx = annualCapEx.find(c => c.year === yearEntry.year);
      const yearFCF = yearEntry.value - Math.abs(matchCapEx?.value || 0);
      annualFCFs.push(yearFCF);
    }
    if (annualFCFs.length >= 3) {
      fcfBase = annualFCFs.reduce((s, v) => s + v, 0) / annualFCFs.length;
      fcfMethod = `${annualFCFs.length}年平均 FCF（週期性正規化）`;
    }
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

  // V3：加權平均（營收 70% + EPS 30%），取代 V2 的保守取低
  let growthRate;
  if (revCAGR !== null && epsCAGR !== null) {
    growthRate = revCAGR * 0.7 + epsCAGR * 0.3;
  } else {
    growthRate = revCAGR ?? epsCAGR ?? 0.05;
  }

  // V3：月營收動能調整
  const annualCAGR = growthRate;
  const growthAdj = calcGrowthAdjustment(momentum, annualCAGR);
  growthRate += growthAdj;

  // 限制範圍（週期性產業上限 10%，一般 30%）
  growthRate = Math.max(minGrowthRate, Math.min(maxGrowthRate, growthRate));

  // ── 3. 流通股數推算 ──
  const sharesResult = estimateSharesOutstanding(financials);
  let sharesOutstanding, sharesMethod;
  if (sharesResult) {
    sharesOutstanding = sharesResult.shares;
    sharesMethod = sharesResult.method;
  } else {
    sharesOutstanding = 1e9;
    sharesMethod = '預設值 (10億股)';
  }

  // ── 4. DCF 多階段現金流預測 ──
  const projections = [];
  let sumPV = 0;
  let prevFCF = fcfBase;
  const growthPhases = [];

  for (let i = 1; i <= projectionYears; i++) {
    let yearGrowth;
    let phase;
    if (i <= highGrowthYears) {
      yearGrowth = growthRate;
      phase = '高成長期';
    } else {
      // 線性衰退：從 growthRate → matureGrowthRate
      const decayStep = (i - highGrowthYears) / decayYears;
      yearGrowth = growthRate - (growthRate - matureGrowthRate) * decayStep;
      phase = '衰退期';
    }
    const projectedFCF = prevFCF * (1 + yearGrowth);
    const discountFactor = Math.pow(1 + wacc, i);
    const pv = projectedFCF / discountFactor;
    projections.push({ year: i, fcf: projectedFCF, pv, growth: round(yearGrowth * 100), phase });
    growthPhases.push({ year: i, growth: round(yearGrowth * 100), phase });
    sumPV += pv;
    prevFCF = projectedFCF;
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
      momentumAdjustment: growthAdj !== 0 ? round(growthAdj * 100) : null,
      wacc: round(wacc * 100),
      terminalGrowthRate: round(terminalGrowthRate * 100),
      projectionYears,
      sharesOutstanding: Math.round(sharesOutstanding),
      sharesMethod,
      terminalValuePV: round(terminalValuePV),
      terminalRatio: round(terminalRatio),
      terminalWarning,
      growthPhases,
      highGrowthYears,
      decayYears,
      matureGrowthRate: round(matureGrowthRate * 100),
      sumProjectedPV: round(sumPV),
      totalEnterpriseValue: round(totalPV),
      projections,
    },
  };
}

