// ── 回饋權重重新合成引擎 ──
// 鏡像 src/llm/resynthesize.js 的模式
// 用混合後的回饋權重重新計算加權合理價

import { round } from '../models/utils.js';

const MODEL_NAMES = {
  dcf: 'DCF', per: 'PER', pbr: 'PBR', div: '股利',
  capex: 'CapEx', evEbitda: 'EV/EBITDA', psr: 'PSR',
};

/**
 * 用回饋權重重新合成估值結果
 * @param {object} storedResult - 原始分析結果
 * @param {object} blendResult - blendWeights() 的回傳值
 * @param {object} feedbackMeta - 回饋元資料（來源、樣本數等）
 * @returns {object} 重新合成的結果（保留原始確定性資料）
 */
export function resynthesizeWithFeedback(storedResult, blendResult, feedbackMeta) {
  const wv = storedResult.weightedValuation;
  const currentPrice = storedResult.currentPrice;
  const weights = blendResult.weights;

  // 提取各模型合理價
  const fairValues = {
    dcf: wv.dcfFairValue,
    per: wv.perFairValue,
    pbr: wv.pbrFairValue,
    div: wv.divFairValue,
    capex: wv.capexFairValue,
    evEbitda: wv.evEbitdaFairValue,
    psr: wv.psrFairValue,
  };

  // 零權重給不可用模型
  const effectiveWeights = {};
  let activeSum = 0;
  for (const [model, w] of Object.entries(weights)) {
    if (fairValues[model] != null && w > 0) {
      effectiveWeights[model] = w;
      activeSum += w;
    } else {
      effectiveWeights[model] = 0;
    }
  }

  // 重新正規化（只有可用模型分配權重）
  if (activeSum === 0) return storedResult;
  for (const key of Object.keys(effectiveWeights)) {
    effectiveWeights[key] = effectiveWeights[key] / activeSum;
  }

  // 計算加權合理價
  let weightedFairValue = 0;
  for (const [model, w] of Object.entries(effectiveWeights)) {
    if (fairValues[model] != null && w > 0) {
      weightedFairValue += fairValues[model] * w;
    }
  }
  weightedFairValue = round(weightedFairValue);

  // 產生 BUY/HOLD/SELL 建議（閾值與 synthesizer.js 一致）
  const upside = currentPrice > 0 ? ((weightedFairValue - currentPrice) / currentPrice) * 100 : 0;
  let action, confidence;
  if (upside > 30) { action = 'BUY'; confidence = '強烈'; }
  else if (upside > 10) { action = 'BUY'; confidence = '一般'; }
  else if (upside > -10) { action = 'HOLD'; confidence = '中性'; }
  else { action = 'SELL'; confidence = upside < -25 ? '強烈' : '一般'; }

  // 方法字串
  const pct = (n) => `${Math.round(n * 100)}%`;
  const parts = [];
  for (const [model, w] of Object.entries(effectiveWeights)) {
    if (w > 0) parts.push(`${MODEL_NAMES[model]} ${pct(w)}`);
  }

  return {
    ...storedResult,
    // 保留原始確定性結果
    deterministicWeightedValuation: storedResult.deterministicWeightedValuation || storedResult.weightedValuation,
    deterministicRecommendation: storedResult.deterministicRecommendation || storedResult.recommendation,
    // 回饋調權後的結果
    weightedValuation: {
      ...storedResult.weightedValuation,
      fairValue: weightedFairValue,
      method: parts.join(' + ') + ' (Feedback)',
      dcfWeight: round(effectiveWeights.dcf, 2),
      perWeight: round(effectiveWeights.per, 2),
      pbrWeight: round(effectiveWeights.pbr, 2),
      divWeight: round(effectiveWeights.div, 2),
      capexWeight: round(effectiveWeights.capex, 2),
      evEbitdaWeight: round(effectiveWeights.evEbitda, 2),
      psrWeight: round(effectiveWeights.psr, 2),
    },
    recommendation: {
      action,
      confidence,
      upside: round(upside),
      fairValue: weightedFairValue,
      reasons: [
        `回饋加權合理價 ${weightedFairValue} 元，潛在${upside > 0 ? '上漲' : '下跌'}空間 ${round(Math.abs(upside))}%`,
        `權重來源：${round(blendResult.blendRatio * 100)}% 歷史回饋 + ${round((1 - blendResult.blendRatio) * 100)}% 預設`,
      ],
    },
    feedbackMetadata: feedbackMeta,
  };
}
