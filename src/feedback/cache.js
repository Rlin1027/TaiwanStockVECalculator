// ── 回饋權重快取管理 ──
// 記憶體快取，24h 自動過期，lazy refresh

import { computeFeedbackByType } from './adaptive-weights.js';
import { FEEDBACK_CONFIG } from '../config.js';

let _cache = null;    // { data, computedAt, sampleStats }
let _staleMs = FEEDBACK_CONFIG.cacheStaleMs;

/**
 * 重算並快取回饋權重
 * @param {object[]} allChecks - 所有 accuracy_checks（已 parse JSON 欄位）
 * @param {object} [options] - { minSamples, blendRatio, horizonWeights }
 * @returns {object} 各分類類型的回饋權重
 */
export function refreshFeedbackCache(allChecks, options = {}) {
  const data = computeFeedbackByType(allChecks, options);

  _cache = {
    data,
    computedAt: new Date().toISOString(),
    sampleStats: {
      totalChecks: allChecks.length,
      coveredTypes: Object.keys(data),
      typeCount: Object.keys(data).length,
    },
  };

  return data;
}

/**
 * 取得特定分類類型的回饋權重
 * @param {string} classificationType - 分類類型（如 '成長股'）
 * @returns {object|null} 回饋權重資料，無可用回饋時回傳 null
 */
export function getFeedbackForType(classificationType) {
  if (!_cache) return null;

  // 檢查是否過期
  const age = Date.now() - new Date(_cache.computedAt).getTime();
  if (age > _staleMs) return null;

  return _cache.data[classificationType] || null;
}

/**
 * 回傳快取狀態
 */
export function getCacheStatus() {
  if (!_cache) {
    return { initialized: false, message: '快取尚未初始化' };
  }

  const age = Date.now() - new Date(_cache.computedAt).getTime();
  const isStale = age > _staleMs;

  return {
    initialized: true,
    computedAt: _cache.computedAt,
    ageMs: Math.round(age),
    isStale,
    ...(_cache.sampleStats),
    feedbackByType: Object.fromEntries(
      Object.entries(_cache.data).map(([type, entry]) => [
        type,
        { weights: entry.weights, totalChecks: entry.totalChecks, sampleCounts: entry.sampleCounts },
      ])
    ),
  };
}

/**
 * 清除快取（供測試用）
 */
export function clearFeedbackCache() {
  _cache = null;
}
