// ── LLM 重新合成引擎 ──
// 讀取已儲存的確定性分析結果，套用 LLM 提供的權重重新計算加權合理價
// 不修改任何原始計算邏輯，僅重新加權

import { round } from '../models/utils.js';

const MODEL_NAMES = {
  dcf: 'DCF', per: 'PER', pbr: 'PBR', div: '股利',
  capex: 'CapEx', evEbitda: 'EV/EBITDA', psr: 'PSR',
};

/**
 * 用 LLM 權重重新合成估值結果
 * @param {object} storedResult - 從 DB 取出的原始分析結果
 * @param {object} llmSanitized - 經 guardrails 驗證後的 LLM 輸出
 * @returns {object} 增強後的結果（保留原始確定性資料）
 */
export function resynthesize(storedResult, llmSanitized) {
  const wv = storedResult.weightedValuation;
  const currentPrice = storedResult.currentPrice;

  // 從 weightedValuation 提取各模型合理價（已處理 v3/v4 格式差異）
  const fairValues = {
    dcf: wv.dcfFairValue,
    per: wv.perFairValue,
    pbr: wv.pbrFairValue,
    div: wv.divFairValue,
    capex: wv.capexFairValue,
    evEbitda: wv.evEbitdaFairValue,
    psr: wv.psrFairValue,
  };

  // 用 LLM 權重計算新的加權合理價
  const weights = llmSanitized.weights;
  let weightedFairValue = 0;
  for (const [model, weight] of Object.entries(weights)) {
    if (fairValues[model] != null && weight > 0) {
      weightedFairValue += fairValues[model] * weight;
    }
  }
  weightedFairValue = round(weightedFairValue);

  // 用與 synthesizer.js 相同的閾值產生建議
  const upside = currentPrice > 0 ? ((weightedFairValue - currentPrice) / currentPrice) * 100 : 0;
  let action, confidence;
  if (upside > 30) { action = 'BUY'; confidence = '強烈'; }
  else if (upside > 10) { action = 'BUY'; confidence = '一般'; }
  else if (upside > -10) { action = 'HOLD'; confidence = '中性'; }
  else { action = 'SELL'; confidence = upside < -25 ? '強烈' : '一般'; }

  // 建構方法字串
  const pct = (n) => `${Math.round(n * 100)}%`;
  const parts = [];
  for (const [model, weight] of Object.entries(weights)) {
    if (weight > 0) parts.push(`${MODEL_NAMES[model]} ${pct(weight)}`);
  }

  return {
    ...storedResult,
    source: 'llm-enhanced',
    llmClassification: {
      type: llmSanitized.type,
      description: llmSanitized.description,
      confidence: llmSanitized.confidence,
      narrative: llmSanitized.narrative,
    },
    deterministicClassification: storedResult.classification,
    deterministicRecommendation: storedResult.recommendation,
    deterministicWeightedValuation: storedResult.weightedValuation,
    classification: {
      ...storedResult.classification,
      type: llmSanitized.type,
      description: llmSanitized.description,
    },
    weightedValuation: {
      ...storedResult.weightedValuation,
      fairValue: weightedFairValue,
      method: parts.join(' + ') + ' (LLM)',
      dcfWeight: round(weights.dcf, 2),
      perWeight: round(weights.per, 2),
      pbrWeight: round(weights.pbr, 2),
      divWeight: round(weights.div, 2),
      capexWeight: round(weights.capex, 2),
      evEbitdaWeight: round(weights.evEbitda, 2),
      psrWeight: round(weights.psr, 2),
    },
    recommendation: {
      action,
      confidence,
      upside: round(upside),
      fairValue: weightedFairValue,
      reasons: [
        `LLM 加權合理價 ${weightedFairValue} 元，潛在${upside > 0 ? '上漲' : '下跌'}空間 ${round(Math.abs(upside))}%`,
        `AI 分類：${llmSanitized.type} — ${llmSanitized.description}`,
        ...(llmSanitized.narrative ? [`AI 分析：${llmSanitized.narrative}`] : []),
      ],
    },
  };
}
