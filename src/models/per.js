// ── Model C: PER 本益比河流圖估值模型 ──
// 使用歷史 PER 分布判斷目前估值水位，反推合理價

import { calcTTM_EPS, round, mean, stddev } from './utils.js';

/**
 * PER 估值分析
 *
 * @param {object} params
 * @param {string} params.ticker - 股票代號
 * @param {Array}  params.per - TaiwanStockPER 原始數據（含 date, PER, PBR）
 * @param {Array}  params.financials - 財報數據（用於計算 TTM EPS）
 * @param {number} params.currentPrice - 目前股價
 * @returns {object} PERResult
 */
export function analyzePER({ ticker, per, financials, currentPrice }) {
  // ── 1. 計算 TTM EPS（最近 4 季加總） ──
  const ttmEPS = calcTTM_EPS(financials);

  if (!ttmEPS || ttmEPS <= 0) {
    return {
      ticker,
      available: false,
      reason: 'EPS 為負或數據不足，PER 模型不適用',
    };
  }

  // ── 2. 整理歷史 PER 數據 ──
  const perValues = per
    .map(d => parseFloat(d.PER))
    .filter(v => v > 0 && isFinite(v));

  if (perValues.length < 60) {
    return {
      ticker,
      available: false,
      reason: `歷史 PER 數據不足（${perValues.length} 筆，需至少 60 筆）`,
    };
  }

  // ── 3. 統計：平均值與標準差 ──
  const avgPE = mean(perValues);
  const stdPE = stddev(perValues);

  // ── 4. 取得當前 PER ──
  const latestPER = per.length > 0 ? parseFloat(per[per.length - 1].PER) : null;
  const currentPE = (latestPER && latestPER > 0) ? latestPER : currentPrice / ttmEPS;

  // ── 5. PER 河流圖帶狀區間 ──
  const bands = {
    cheapBelow: round(avgPE - stdPE),       // 便宜線
    fairLow: round(avgPE - stdPE),
    fairHigh: round(avgPE + stdPE),
    expensiveAbove: round(avgPE + stdPE),    // 昂貴線
    mean: round(avgPE),
    minus2SD: round(avgPE - 2 * stdPE),
    plus2SD: round(avgPE + 2 * stdPE),
  };

  // ── 6. 判斷位置 ──
  let position;
  if (currentPE < avgPE - stdPE) {
    position = '便宜';
  } else if (currentPE > avgPE + stdPE) {
    position = '昂貴';
  } else {
    position = '合理';
  }

  // ── 7. 反推合理價 ──
  const fairValue = round(avgPE * ttmEPS);
  const upside = currentPrice > 0
    ? round(((fairValue - currentPrice) / currentPrice) * 100)
    : 0;

  // ── 8. 信號 ──
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
    fairValue,
    upside,
    signal,
    currentPE: round(currentPE),
    avgPE: round(avgPE),
    stdPE: round(stdPE),
    ttmEPS: round(ttmEPS),
    position,
    bands,
  };
}

