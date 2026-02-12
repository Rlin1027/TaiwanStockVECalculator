// ── Model: PSR 股價營收比河流圖估值模型 ──
// 適用於虧損成長股（EPS 為負時 PER 不適用），以營收為基礎的估值方法
// PSR = 市值 / 年營收 = 股價 / 每股營收 (RPS)

import {
  round,
  mean,
  stddev,
  aggregateAnnualFinancials,
  estimateSharesOutstanding,
} from './utils.js';

/**
 * PSR 估值分析
 *
 * @param {object} params
 * @param {string} params.ticker - 股票代號
 * @param {Array}  params.financials - 財報數據
 * @param {number} params.currentPrice - 目前股價
 * @returns {object} PSRResult
 */
export function analyzePSR({ ticker, financials, currentPrice }) {
  // ── 1. 估算流通股數 ──
  const sharesResult = estimateSharesOutstanding(financials);
  if (!sharesResult) {
    return {
      ticker,
      available: false,
      reason: '無法估算流通股數，PSR 模型不適用',
    };
  }
  const sharesOutstanding = sharesResult.shares;

  // ── 2. 計算年度營收 ──
  const annualRevenue = aggregateAnnualFinancials(financials, 'Revenue');

  // 篩選完整年度（4 季都有的年份）
  const completeYears = annualRevenue.filter(d => d.quarters === 4);

  if (completeYears.length < 3) {
    return {
      ticker,
      available: false,
      reason: `完整年度營收數據不足（${completeYears.length} 年，需至少 3 年）`,
    };
  }

  // ── 3. 計算每股營收 (RPS) ──
  // 使用最近完整年度或 TTM 營收
  const latestFullYear = completeYears[0];
  const ttmRevenue = latestFullYear.value;
  const rps = ttmRevenue / sharesOutstanding;

  if (!rps || rps <= 0 || !isFinite(rps)) {
    return {
      ticker,
      available: false,
      reason: '每股營收 (RPS) 計算異常，PSR 模型不適用',
    };
  }

  // ── 4. 計算歷史 PSR（近 5 年完整年度） ──
  const recentYears = completeYears.slice(0, 5);
  const historicalPSRs = recentYears.map(yr => {
    const yearRPS = yr.value / sharesOutstanding;
    // 用當前股價近似各年度 PSR（因缺乏歷史股價）
    // 實務上可用各年年末收盤價，此處以均勻分布近似
    return currentPrice / yearRPS;
  }).filter(v => v > 0 && isFinite(v));

  if (historicalPSRs.length < 3) {
    return {
      ticker,
      available: false,
      reason: `有效 PSR 數據不足（${historicalPSRs.length} 年，需至少 3 年）`,
    };
  }

  // ── 5. PSR 統計：平均值與標準差 ──
  const avgPSR = mean(historicalPSRs);
  const stdPSR = stddev(historicalPSRs);

  // ── 6. 當前 PSR ──
  const currentPSR = currentPrice / rps;

  // ── 7. PSR 河流圖帶狀區間 ──
  const bands = {
    minus2SD: round(avgPSR - 2 * stdPSR),
    cheap: round(avgPSR - stdPSR),
    mean: round(avgPSR),
    expensive: round(avgPSR + stdPSR),
    plus2SD: round(avgPSR + 2 * stdPSR),
  };

  // ── 8. 判斷位置 ──
  let position;
  if (currentPSR < avgPSR - stdPSR) {
    position = '便宜';
  } else if (currentPSR > avgPSR + stdPSR) {
    position = '昂貴';
  } else {
    position = '合理';
  }

  // ── 9. 反推合理價 ──
  const fairValue = avgPSR * rps;
  const upside = currentPrice > 0
    ? ((fairValue - currentPrice) / currentPrice) * 100
    : 0;

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
    currentPSR: round(currentPSR, 2),
    avgPSR: round(avgPSR, 2),
    stdPSR: round(stdPSR, 2),
    rps: round(rps),
    ttmRevenue: round(ttmRevenue),
    position,
    bands,
  };
}
