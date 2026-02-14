// ── 回測回饋權重演算法 ──
// 從歷史 MAE 計算 inverse-MAE 回饋權重，與預設權重混合

import { round } from '../models/utils.js';
import { FEEDBACK_CONFIG } from '../config.js';

const MODEL_KEYS = ['dcf', 'per', 'pbr', 'div', 'capex', 'evEbitda', 'psr'];

/**
 * 計算混合 MAE（三時間軸加權平均）
 * @param {{ mae30d: number[], mae90d: number[], mae180d: number[] }} modelStats
 * @returns {number|null} blendedMAE，樣本不足時回傳 null
 */
export function computeBlendedMAE(modelStats, options = {}) {
  const minSamples = options.minSamples ?? FEEDBACK_CONFIG.minSamples;
  const hw = options.horizonWeights ?? FEEDBACK_CONFIG.horizonWeights;

  const avg30 = safeAvg(modelStats.mae30d);
  const avg90 = safeAvg(modelStats.mae90d);
  const avg180 = safeAvg(modelStats.mae180d);

  // 至少需要 30d 數據，且樣本數需達標
  if (avg30 == null || modelStats.mae30d.length < minSamples) return null;

  // 有幾個時間軸可用就用幾個，動態正規化權重
  let totalHW = hw.mae30d;
  let blended = avg30 * hw.mae30d;

  if (avg90 != null) {
    blended += avg90 * hw.mae90d;
    totalHW += hw.mae90d;
  }
  if (avg180 != null) {
    blended += avg180 * hw.mae180d;
    totalHW += hw.mae180d;
  }

  return blended / totalHW;
}

/**
 * 將各模型的 blendedMAE 轉換為正規化權重（inverse-MAE）
 * @param {object} maeByModel - { dcf: 15.2, per: 8.3, ... }（null 表示不可用）
 * @returns {object} 正規化後的權重 { dcf: 0.12, per: 0.25, ... }
 */
export function maeToWeights(maeByModel) {
  const maxWeight = FEEDBACK_CONFIG.maxWeight;
  const epsilon = 0.01;

  // 計算 inverse-MAE
  const inverseMap = {};
  let totalInverse = 0;
  for (const key of MODEL_KEYS) {
    const mae = maeByModel[key];
    if (mae != null) {
      const inv = 1 / (mae + epsilon);
      inverseMap[key] = inv;
      totalInverse += inv;
    } else {
      inverseMap[key] = 0;
    }
  }

  // 正規化為加總 = 1.0
  const weights = {};
  if (totalInverse === 0) return null;

  for (const key of MODEL_KEYS) {
    let w = inverseMap[key] / totalInverse;
    // 單一模型上限
    if (w > maxWeight) w = maxWeight;
    weights[key] = w;
  }

  // 再次正規化（因為 cap 可能讓加總 < 1.0）
  const sum = MODEL_KEYS.reduce((s, k) => s + weights[k], 0);
  for (const key of MODEL_KEYS) {
    weights[key] = round(weights[key] / sum, 4);
  }

  return weights;
}

/**
 * 按分類類型計算回饋權重
 * @param {object[]} checks - accuracy_checks（已 parse model_errors_json）
 * @param {object} [options]
 * @returns {object} { '成長股': { weights, sampleCounts, blendedMAEs }, ... }
 */
export function computeFeedbackByType(checks, options = {}) {
  const minSamples = options.minSamples ?? FEEDBACK_CONFIG.minSamples;

  // 按分類類型分組
  const byType = {};
  for (const check of checks) {
    const type = check.classification_type || '未分類';
    if (!byType[type]) byType[type] = [];
    byType[type].push(check);
  }

  const result = {};
  for (const [type, group] of Object.entries(byType)) {
    // 累積各模型的 MAE 數據
    const modelAccum = {};
    for (const key of MODEL_KEYS) {
      modelAccum[key] = { mae30d: [], mae90d: [], mae180d: [] };
    }

    for (const check of group) {
      const errors = check.model_errors_json;
      if (!errors) continue;
      for (const [model, periods] of Object.entries(errors)) {
        if (!modelAccum[model]) continue;
        if (periods?.mae30d != null) modelAccum[model].mae30d.push(periods.mae30d);
        if (periods?.mae90d != null) modelAccum[model].mae90d.push(periods.mae90d);
        if (periods?.mae180d != null) modelAccum[model].mae180d.push(periods.mae180d);
      }
    }

    // 計算各模型的 blendedMAE
    const blendedMAEs = {};
    const sampleCounts = {};
    for (const key of MODEL_KEYS) {
      blendedMAEs[key] = computeBlendedMAE(modelAccum[key], { minSamples, horizonWeights: options.horizonWeights });
      sampleCounts[key] = modelAccum[key].mae30d.length;
    }

    // 轉換為回饋權重
    const weights = maeToWeights(blendedMAEs);
    if (weights) {
      result[type] = { weights, sampleCounts, blendedMAEs, totalChecks: group.length };
    }
  }

  return result;
}

/**
 * 混合預設權重 + 回饋權重
 * @param {object} defaultClassification - synthesizer 的分類結果（含 dcfWeight 等）
 * @param {object} feedbackEntry - computeFeedbackByType 的單一類型結果
 * @param {object} [options]
 * @returns {object} { weights, source }
 */
export function blendWeights(defaultClassification, feedbackEntry, options = {}) {
  const blendRatio = options.blendRatio ?? FEEDBACK_CONFIG.blendRatio;
  const maxWeight = options.maxWeight ?? FEEDBACK_CONFIG.maxWeight;

  const defaultWeights = {
    dcf: defaultClassification.dcfWeight ?? 0,
    per: defaultClassification.perWeight ?? 0,
    pbr: defaultClassification.pbrWeight ?? 0,
    div: defaultClassification.divWeight ?? 0,
    capex: defaultClassification.capexWeight ?? 0,
    evEbitda: defaultClassification.evEbitdaWeight ?? 0,
    psr: defaultClassification.psrWeight ?? 0,
  };

  const feedbackWeights = feedbackEntry.weights;

  // 混合：(1 - blendRatio) × default + blendRatio × feedback
  const blended = {};
  for (const key of MODEL_KEYS) {
    let w = (1 - blendRatio) * defaultWeights[key] + blendRatio * feedbackWeights[key];
    if (w > maxWeight) w = maxWeight;
    blended[key] = w;
  }

  // 正規化為加總 = 1.0
  const sum = MODEL_KEYS.reduce((s, k) => s + blended[k], 0);
  if (sum === 0) return null;

  for (const key of MODEL_KEYS) {
    blended[key] = round(blended[key] / sum, 4);
  }

  return {
    weights: blended,
    source: 'blended',
    blendRatio,
    defaultWeights,
    feedbackWeights,
  };
}

// ── Helpers ──

function safeAvg(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
