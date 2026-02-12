// ── 回測引擎 ──
// 比對 DB 中歷史分析的預測 vs 實際後續股價

import { fetchStockPrice } from '../api/finmind.js';
import {
  getUncheckedAnalyses, getPartialAccuracyChecks,
  saveAccuracyCheck, updateAccuracyCheck,
} from '../db.js';
import { isDirectionCorrect, calcMAE } from './metrics.js';

/**
 * 執行回測掃描
 * 1. 處理未回測的分析紀錄（≥ minDaysAgo 天）
 * 2. 回填已存在但缺少 90d/180d 數據的紀錄
 */
export async function runBacktest({ minDaysAgo = 30, maxResults = 100 } = {}) {
  const results = { processed: 0, skipped: 0, backfilled: 0, errors: [] };

  // ── Part 1: 新的回測 ──
  const unchecked = getUncheckedAnalyses(minDaysAgo).slice(0, maxResults);
  const tickerGroups = groupByTicker(unchecked);

  for (const [ticker, analyses] of Object.entries(tickerGroups)) {
    try {
      // 找出最早的分析日期，一次抓整段股價
      const earliest = analyses.reduce((min, a) => a.createdAt < min ? a.createdAt : min, analyses[0].createdAt);
      const startDate = earliest.slice(0, 10);
      const priceData = await fetchStockPrice(ticker, startDate);

      if (!priceData || priceData.length === 0) {
        results.errors.push({ ticker, error: 'No price data available' });
        results.skipped += analyses.length;
        continue;
      }

      for (const analysis of analyses) {
        try {
          processAnalysis(analysis, priceData);
          results.processed++;
        } catch (err) {
          results.errors.push({ ticker, analysisId: analysis.id, error: err.message });
          results.skipped++;
        }
      }
    } catch (err) {
      results.errors.push({ ticker, error: err.message });
      results.skipped += analyses.length;
    }
  }

  // ── Part 2: 回填 90d/180d ──
  const partial = getPartialAccuracyChecks();
  for (const check of partial) {
    try {
      await backfillCheck(check);
      results.backfilled++;
    } catch (err) {
      results.errors.push({ ticker: check.ticker, checkId: check.id, error: err.message });
    }
  }

  return results;
}

/**
 * 處理單筆分析紀錄，與實際股價比對
 */
function processAnalysis(analysis, priceData) {
  const result = analysis.result;
  const analysisDate = analysis.createdAt.slice(0, 10);

  const fairValue = result.weightedValuation?.fairValue;
  const action = result.recommendation?.action;
  const price = result.currentPrice;

  if (!fairValue || !action || !price) {
    throw new Error('Analysis missing fairValue, action, or currentPrice');
  }

  // 取各模型的公允價值
  const wv = result.weightedValuation || {};
  const modelFairValues = {
    dcf: wv.dcfFairValue ?? null,
    per: wv.perFairValue ?? null,
    pbr: wv.pbrFairValue ?? null,
    div: wv.divFairValue ?? null,
    capex: wv.capexFairValue ?? null,
    evEbitda: wv.evEbitdaFairValue ?? null,
    psr: wv.psrFairValue ?? null,
  };

  // 找 T+30/90/180 天的實際價格
  const actual30d = findPriceAtOffset(priceData, analysisDate, 30);
  const actual90d = findPriceAtOffset(priceData, analysisDate, 90);
  const actual180d = findPriceAtOffset(priceData, analysisDate, 180);

  // 計算各模型在各期間的 MAE
  const modelErrors = {};
  for (const [model, fv] of Object.entries(modelFairValues)) {
    if (fv == null) continue;
    modelErrors[model] = {
      mae30d: actual30d ? calcMAE(fv, actual30d) : null,
      mae90d: actual90d ? calcMAE(fv, actual90d) : null,
      mae180d: actual180d ? calcMAE(fv, actual180d) : null,
    };
  }

  saveAccuracyCheck({
    analysisId: analysis.id,
    ticker: analysis.ticker,
    analysisDate,
    predictedFairValue: fairValue,
    predictedAction: action,
    priceAtAnalysis: price,
    classificationType: result.classification?.type || result.llmClassification?.type || null,
    actualPrice30d: actual30d,
    actualPrice90d: actual90d,
    actualPrice180d: actual180d,
    directionCorrect30d: isDirectionCorrect(action, price, actual30d),
    directionCorrect90d: isDirectionCorrect(action, price, actual90d),
    directionCorrect180d: isDirectionCorrect(action, price, actual180d),
    modelFairValuesJson: modelFairValues,
    modelErrorsJson: modelErrors,
  });
}

/**
 * 回填已存在的 accuracy_check 中缺少的 90d/180d 數據
 */
async function backfillCheck(check) {
  const priceData = await fetchStockPrice(check.ticker, check.analysis_date);
  if (!priceData || priceData.length === 0) return;

  const updates = {};

  if (check.actual_price_90d == null) {
    const actual90d = findPriceAtOffset(priceData, check.analysis_date, 90);
    if (actual90d) {
      updates.actual_price_90d = actual90d;
      updates.direction_correct_90d = isDirectionCorrect(check.predicted_action, check.price_at_analysis, actual90d);

      // 更新模型誤差
      const modelFV = check.model_fair_values_json;
      const modelErrors = check.model_errors_json || {};
      if (modelFV) {
        for (const [model, fv] of Object.entries(modelFV)) {
          if (fv == null) continue;
          if (!modelErrors[model]) modelErrors[model] = {};
          modelErrors[model].mae90d = calcMAE(fv, actual90d);
        }
        updates.model_errors_json = JSON.stringify(modelErrors);
      }
    }
  }

  if (check.actual_price_180d == null) {
    const actual180d = findPriceAtOffset(priceData, check.analysis_date, 180);
    if (actual180d) {
      updates.actual_price_180d = actual180d;
      updates.direction_correct_180d = isDirectionCorrect(check.predicted_action, check.price_at_analysis, actual180d);

      const modelFV = check.model_fair_values_json;
      const modelErrors = check.model_errors_json || {};
      if (modelFV) {
        for (const [model, fv] of Object.entries(modelFV)) {
          if (fv == null) continue;
          if (!modelErrors[model]) modelErrors[model] = {};
          modelErrors[model].mae180d = calcMAE(fv, actual180d);
        }
        updates.model_errors_json = JSON.stringify(modelErrors);
      }
    }
  }

  if (Object.keys(updates).length > 0) {
    updateAccuracyCheck(check.id, updates);
  }
}

// ── Helpers ──

/**
 * 在股價數據中找到距離 baseDate + offsetDays 最近的交易日收盤價
 * 容差 ±3 個交易日
 */
function findPriceAtOffset(priceData, baseDate, offsetDays) {
  const target = new Date(baseDate);
  target.setDate(target.getDate() + offsetDays);
  const targetStr = target.toISOString().slice(0, 10);

  // 找最接近 target 的交易日（±3 天容差）
  let bestMatch = null;
  let bestDiff = Infinity;

  for (const row of priceData) {
    const rowDate = row.date;
    const diff = Math.abs(daysDiff(rowDate, targetStr));
    if (diff <= 3 && diff < bestDiff) {
      bestDiff = diff;
      bestMatch = parseFloat(row.close);
    }
  }

  return bestMatch;
}

function daysDiff(dateA, dateB) {
  return (new Date(dateA) - new Date(dateB)) / (1000 * 60 * 60 * 24);
}

function groupByTicker(analyses) {
  const groups = {};
  for (const a of analyses) {
    if (!groups[a.ticker]) groups[a.ticker] = [];
    groups[a.ticker].push(a);
  }
  return groups;
}
