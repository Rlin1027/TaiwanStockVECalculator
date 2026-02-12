// ── LLM 輸出驗證層 ──
// 確保 LLM 產出的分類和權重符合系統規範，不合規則回退至確定性結果

import { round } from '../models/utils.js';

const VALID_TYPES = ['金融業', '週期性', '虧損成長股', '成長股', '存股', '價值成長股', '混合型'];
const MODEL_KEYS = ['dcf', 'per', 'pbr', 'div', 'capex', 'evEbitda', 'psr'];

/**
 * 從已儲存的分析結果中提取各模型可用性
 * 使用 weightedValuation 中的 *FairValue 欄位判斷
 */
export function extractModelAvailability(storedResult) {
  const wv = storedResult.weightedValuation;
  return {
    dcf: wv.dcfFairValue != null,
    per: wv.perFairValue != null,
    pbr: wv.pbrFairValue != null,
    div: wv.divFairValue != null,
    capex: wv.capexFairValue != null,
    evEbitda: wv.evEbitdaFairValue != null,
    psr: wv.psrFairValue != null,
  };
}

/**
 * 驗證單一股票的 LLM 輸出
 * @param {object} llmOutput - LLM 產出的分類結果 { type, description, weights, confidence, narrative }
 * @param {object} availableModels - 各模型可用性 { dcf: true, per: false, ... }
 * @returns {{ valid: boolean, sanitized: object|null, errors: string[] }}
 */
export function validateLLMOutput(llmOutput, availableModels) {
  const errors = [];

  if (!llmOutput || typeof llmOutput !== 'object') {
    return { valid: false, sanitized: null, errors: ['LLM 輸出不是有效物件'] };
  }

  // 1. type 必須是 7 種有效分類之一
  if (!llmOutput.type || !VALID_TYPES.includes(llmOutput.type)) {
    errors.push(`無效分類類型: "${llmOutput.type}"，必須是: ${VALID_TYPES.join(', ')}`);
  }

  // 2. weights 必須存在且為物件
  if (!llmOutput.weights || typeof llmOutput.weights !== 'object') {
    errors.push('缺少 weights 物件');
    return { valid: false, sanitized: null, errors };
  }

  const weights = {};

  for (const key of MODEL_KEYS) {
    const w = llmOutput.weights[key];

    if (w === undefined || w === null || typeof w !== 'number' || isNaN(w)) {
      errors.push(`weights.${key} 必須是數字，收到: ${w}`);
      weights[key] = 0;
      continue;
    }

    // 3. 每個 weight 必須在 [0, 0.50]
    if (w < 0 || w > 0.50) {
      errors.push(`weights.${key} = ${w}，必須在 [0, 0.50] 範圍內`);
      weights[key] = 0;
      continue;
    }

    // 4. 不可用模型的 weight 必須 = 0
    if (!availableModels[key] && w > 0) {
      errors.push(`模型 ${key} 不可用但 weight = ${w}，應為 0`);
      weights[key] = 0;
      continue;
    }

    weights[key] = w;
  }

  if (errors.length > 0) {
    return { valid: false, sanitized: null, errors };
  }

  // 5. 權重加總 ≈ 1.0（容差 ±0.02）
  const sum = MODEL_KEYS.reduce((s, k) => s + weights[k], 0);
  if (Math.abs(sum - 1.0) > 0.02) {
    errors.push(`權重加總 = ${round(sum, 4)}，偏離 1.0 超過容差 ±0.02`);
    return { valid: false, sanitized: null, errors };
  }

  // 正規化為精確 1.0
  for (const key of MODEL_KEYS) {
    weights[key] = weights[key] / sum;
  }

  return {
    valid: true,
    sanitized: {
      type: llmOutput.type,
      description: llmOutput.description || '',
      weights,
      confidence: llmOutput.confidence || 'MEDIUM',
      narrative: llmOutput.narrative || '',
    },
    errors: [],
  };
}

/**
 * 批次驗證多檔股票的 LLM 輸出
 * @param {object} batch - { "2330": { type, weights, ... }, "2884": { ... } }
 * @param {object} availabilityMap - { "2330": { dcf: true, ... }, ... }
 * @returns {object} per-ticker validation results
 */
export function validateBatchLLMOutput(batch, availabilityMap) {
  const results = {};
  for (const [ticker, llmOutput] of Object.entries(batch)) {
    const available = availabilityMap[ticker];
    if (!available) {
      results[ticker] = { valid: false, sanitized: null, errors: [`找不到 ${ticker} 的模型可用性資訊`] };
      continue;
    }
    results[ticker] = validateLLMOutput(llmOutput, available);
  }
  return results;
}
