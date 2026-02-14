// ── 回饋系統公開 API ──
export { computeBlendedMAE, maeToWeights, computeFeedbackByType, blendWeights } from './adaptive-weights.js';
export { resynthesizeWithFeedback } from './resynthesize-feedback.js';
export { refreshFeedbackCache, getFeedbackForType, getCacheStatus, clearFeedbackCache } from './cache.js';
