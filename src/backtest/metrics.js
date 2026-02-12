// ── 回測準確度指標計算 ──

/**
 * 判斷方向是否正確
 * BUY → 價格上漲 = correct
 * SELL → 價格下跌 = correct
 * HOLD → 價格變化 < ±5% = correct
 */
export function isDirectionCorrect(action, priceAtAnalysis, actualPrice) {
  if (!actualPrice || !priceAtAnalysis) return null;
  const changePct = (actualPrice - priceAtAnalysis) / priceAtAnalysis;

  switch (action) {
    case 'BUY': return changePct > 0 ? 1 : 0;
    case 'SELL': return changePct < 0 ? 1 : 0;
    case 'HOLD': return Math.abs(changePct) < 0.05 ? 1 : 0;
    default: return null;
  }
}

/**
 * 計算單一模型的 MAE (Mean Absolute Error %)
 */
export function calcMAE(predicted, actual) {
  if (!actual || actual === 0) return null;
  return Math.abs(predicted - actual) / actual * 100;
}

/**
 * 計算各模型對特定實際價格的誤差
 */
export function calcModelErrors(modelFairValues, actualPrice) {
  if (!modelFairValues || !actualPrice) return null;
  const errors = {};
  for (const [model, fairValue] of Object.entries(modelFairValues)) {
    if (fairValue != null) {
      errors[model] = calcMAE(fairValue, actualPrice);
    }
  }
  return errors;
}

/**
 * 從準確度紀錄列表計算聚合統計摘要
 */
export function calculateSummary(checks) {
  if (!checks || checks.length === 0) {
    return { overall: null, byType: {}, byModel: {}, leaderboard: [] };
  }

  // -- Overall hit rates --
  const overall = calcHitRates(checks);

  // -- By classification type --
  const byType = {};
  const typeGroups = groupBy(checks, c => c.classification_type || '未分類');
  for (const [type, group] of Object.entries(typeGroups)) {
    byType[type] = { ...calcHitRates(group), count: group.length };
  }

  // -- By model MAE --
  const modelAccum = {};
  for (const check of checks) {
    const errors = check.model_errors_json;
    if (!errors) continue;
    for (const [model, periods] of Object.entries(errors)) {
      if (!modelAccum[model]) modelAccum[model] = { mae30d: [], mae90d: [], mae180d: [] };
      if (periods?.mae30d != null) modelAccum[model].mae30d.push(periods.mae30d);
      if (periods?.mae90d != null) modelAccum[model].mae90d.push(periods.mae90d);
      if (periods?.mae180d != null) modelAccum[model].mae180d.push(periods.mae180d);
    }
  }

  const byModel = {};
  for (const [model, data] of Object.entries(modelAccum)) {
    byModel[model] = {
      avgMAE30d: avg(data.mae30d),
      avgMAE90d: avg(data.mae90d),
      avgMAE180d: avg(data.mae180d),
      sampleCount: data.mae30d.length,
    };
  }

  // -- Leaderboard (by 30d MAE, ascending) --
  const leaderboard = Object.entries(byModel)
    .filter(([, v]) => v.avgMAE30d != null)
    .sort((a, b) => a[1].avgMAE30d - b[1].avgMAE30d)
    .map(([model, stats], idx) => ({ rank: idx + 1, model, avgMAE: round2(stats.avgMAE30d) }));

  return { overall, byType, byModel, leaderboard };
}

// ── Helpers ──

function calcHitRates(checks) {
  const d30 = checks.filter(c => c.direction_correct_30d != null);
  const d90 = checks.filter(c => c.direction_correct_90d != null);
  const d180 = checks.filter(c => c.direction_correct_180d != null);

  return {
    hitRate30d: d30.length > 0 ? round2(d30.filter(c => c.direction_correct_30d === 1).length / d30.length * 100) : null,
    hitRate90d: d90.length > 0 ? round2(d90.filter(c => c.direction_correct_90d === 1).length / d90.length * 100) : null,
    hitRate180d: d180.length > 0 ? round2(d180.filter(c => c.direction_correct_180d === 1).length / d180.length * 100) : null,
    avgMAE30d: avg(checks.map(c => c.actual_price_30d != null ? calcMAE(c.predicted_fair_value, c.actual_price_30d) : null).filter(v => v != null)),
    avgMAE90d: avg(checks.map(c => c.actual_price_90d != null ? calcMAE(c.predicted_fair_value, c.actual_price_90d) : null).filter(v => v != null)),
    avgMAE180d: avg(checks.map(c => c.actual_price_180d != null ? calcMAE(c.predicted_fair_value, c.actual_price_180d) : null).filter(v => v != null)),
    totalChecks: checks.length,
    pendingChecks: checks.filter(c => c.direction_correct_30d == null).length,
  };
}

function groupBy(arr, keyFn) {
  const map = {};
  for (const item of arr) {
    const key = keyFn(item);
    if (!map[key]) map[key] = [];
    map[key].push(item);
  }
  return map;
}

function avg(nums) {
  if (!nums || nums.length === 0) return null;
  return round2(nums.reduce((s, v) => s + v, 0) / nums.length);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
