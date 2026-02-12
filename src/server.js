// ── 估值分析 HTTP API 伺服器 ──

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { analyzeStock, analyzeBatch } from './service.js';
import {
  saveAnalysis, getHistory, getLatest, getLatestTwo,
  addToPortfolio, removeFromPortfolio, getPortfolio,
  getAccuracyByTicker, getAccuracySummary,
  upsertHolding, getHoldings, getHolding, removeHolding,
  createAlert, getActiveAlerts, getAlertsByTicker, deactivateAlert, updateAlertTriggered,
} from './db.js';
import { validateLLMOutput, validateBatchLLMOutput, extractModelAvailability } from './llm/guardrails.js';
import { resynthesize } from './llm/resynthesize.js';
import { runBacktest } from './backtest/engine.js';
import { calculateSummary } from './backtest/metrics.js';
import { calculatePortfolioAnalytics } from './portfolio/analytics.js';
import { checkAlerts } from './portfolio/alerts.js';
import { fetchStockPrice } from './api/finmind.js';

const app = express();

// ── Middleware ──
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// 可選 API Key 驗證
if (process.env.API_KEY) {
  app.use('/api', (req, res, next) => {
    // 跳過 health check
    if (req.path === '/health') return next();

    const key = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-api-key'];
    if (key !== process.env.API_KEY) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing API key' });
    }
    next();
  });
}

// ── Ticker 格式驗證 ──
function isValidTicker(ticker) {
  return /^\d{4,6}$/.test(ticker);
}

// ── Routes ──

// 健康檢查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), version: '1.0.0' });
});

// 單股分析
app.post('/api/analyze/:ticker', async (req, res) => {
  const { ticker } = req.params;

  if (!isValidTicker(ticker)) {
    return res.status(400).json({ error: 'Bad Request', message: `Invalid ticker format: ${ticker} (expected 4-6 digits)` });
  }

  try {
    const result = await analyzeStock(ticker);
    saveAnalysis(ticker, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Analysis Failed', message: err.message });
  }
});

// 批次分析
app.post('/api/analyze/batch', async (req, res) => {
  const { tickers } = req.body || {};

  if (!Array.isArray(tickers) || tickers.length === 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'Request body must contain a non-empty tickers array' });
  }

  // 驗證所有 ticker 格式
  const invalid = tickers.filter(t => !isValidTicker(t));
  if (invalid.length > 0) {
    return res.status(400).json({ error: 'Bad Request', message: `Invalid ticker(s): ${invalid.join(', ')}` });
  }

  try {
    const { results, errors } = await analyzeBatch(tickers);

    // 逐一儲存成功的分析結果
    for (const result of results) {
      saveAnalysis(result.ticker, result);
    }

    res.json({
      results,
      errors,
      summary: {
        total: tickers.length,
        success: results.length,
        failed: errors.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Batch Analysis Failed', message: err.message });
  }
});

// 歷史分析紀錄
app.get('/api/history/:ticker', (req, res) => {
  const { ticker } = req.params;

  if (!isValidTicker(ticker)) {
    return res.status(400).json({ error: 'Bad Request', message: `Invalid ticker format: ${ticker}` });
  }

  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const analyses = getHistory(ticker, limit);
    res.json({ ticker, analyses });
  } catch (err) {
    res.status(500).json({ error: 'Query Failed', message: err.message });
  }
});

// ── LLM 智慧分類端點 ──

// 歷史差異比較
app.get('/api/compare/:ticker', (req, res) => {
  const { ticker } = req.params;

  if (!isValidTicker(ticker)) {
    return res.status(400).json({ error: 'Bad Request', message: `Invalid ticker format: ${ticker}` });
  }

  try {
    const rows = getLatestTwo(ticker);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Not Found', message: `No analysis history for ${ticker}` });
    }

    if (rows.length === 1) {
      return res.json({ ticker, isFirstAnalysis: true, latest: rows[0], delta: null });
    }

    const [latest, previous] = rows;
    const l = latest.result;
    const p = previous.result;

    const daysBetween = Math.round(
      (new Date(latest.createdAt) - new Date(previous.createdAt)) / (1000 * 60 * 60 * 24)
    );

    const delta = {
      priceChange: l.currentPrice - p.currentPrice,
      priceChangePct: p.currentPrice > 0
        ? Math.round(((l.currentPrice - p.currentPrice) / p.currentPrice) * 10000) / 100
        : null,
      fairValueChange: (l.weightedValuation?.fairValue || 0) - (p.weightedValuation?.fairValue || 0),
      classificationChanged: l.classification?.type !== p.classification?.type,
      previousClassification: p.classification?.type,
      currentClassification: l.classification?.type,
      actionChanged: l.recommendation?.action !== p.recommendation?.action,
      previousAction: p.recommendation?.action,
      currentAction: l.recommendation?.action,
      modelFairValues: {
        dcf: { current: l.weightedValuation?.dcfFairValue ?? null, previous: p.weightedValuation?.dcfFairValue ?? null },
        per: { current: l.weightedValuation?.perFairValue ?? null, previous: p.weightedValuation?.perFairValue ?? null },
        pbr: { current: l.weightedValuation?.pbrFairValue ?? null, previous: p.weightedValuation?.pbrFairValue ?? null },
        div: { current: l.weightedValuation?.divFairValue ?? null, previous: p.weightedValuation?.divFairValue ?? null },
        capex: { current: l.weightedValuation?.capexFairValue ?? null, previous: p.weightedValuation?.capexFairValue ?? null },
        evEbitda: { current: l.weightedValuation?.evEbitdaFairValue ?? null, previous: p.weightedValuation?.evEbitdaFairValue ?? null },
        psr: { current: l.weightedValuation?.psrFairValue ?? null, previous: p.weightedValuation?.psrFairValue ?? null },
      },
      daysBetween,
    };

    res.json({ ticker, isFirstAnalysis: false, latest, previous, delta });
  } catch (err) {
    res.status(500).json({ error: 'Compare Failed', message: err.message });
  }
});

// 批次重新合成（必須在 :ticker 之前註冊）
app.post('/api/resynthesize/batch', (req, res) => {
  const { stocks, save = false } = req.body || {};

  if (!stocks || typeof stocks !== 'object' || Object.keys(stocks).length === 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'Request body must contain a non-empty stocks object' });
  }

  try {
    const results = [];
    const errors = [];
    let enhancedCount = 0;
    let fallbackCount = 0;

    for (const [ticker, llmOutput] of Object.entries(stocks)) {
      if (!isValidTicker(ticker)) {
        errors.push({ ticker, error: `Invalid ticker format: ${ticker}` });
        continue;
      }

      const record = getLatest(ticker);
      if (!record) {
        errors.push({ ticker, error: `No analysis found for ${ticker}` });
        continue;
      }

      const available = extractModelAvailability(record.result);
      const validation = validateLLMOutput(llmOutput, available);

      if (!validation.valid) {
        fallbackCount++;
        results.push({
          ticker,
          source: 'deterministic-fallback',
          guardrailErrors: validation.errors,
          result: record.result,
        });
        continue;
      }

      const enhanced = resynthesize(record.result, validation.sanitized);
      enhancedCount++;

      if (save) {
        saveAnalysis(ticker, enhanced);
      }

      results.push({ ticker, source: 'llm-enhanced', result: enhanced });
    }

    res.json({
      results,
      errors,
      summary: {
        total: Object.keys(stocks).length,
        enhanced: enhancedCount,
        fallback: fallbackCount,
        failed: errors.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Batch Resynthesize Failed', message: err.message });
  }
});

// 單股重新合成
app.post('/api/resynthesize/:ticker', (req, res) => {
  const { ticker } = req.params;
  const { llmClassification, save = false } = req.body || {};

  if (!isValidTicker(ticker)) {
    return res.status(400).json({ error: 'Bad Request', message: `Invalid ticker format: ${ticker}` });
  }

  if (!llmClassification) {
    return res.status(400).json({ error: 'Bad Request', message: 'Request body must contain llmClassification' });
  }

  try {
    const record = getLatest(ticker);
    if (!record) {
      return res.status(404).json({ error: 'Not Found', message: `No analysis found for ${ticker}` });
    }

    const available = extractModelAvailability(record.result);
    const validation = validateLLMOutput(llmClassification, available);

    if (!validation.valid) {
      return res.json({
        source: 'deterministic-fallback',
        guardrailErrors: validation.errors,
        result: record.result,
      });
    }

    const enhanced = resynthesize(record.result, validation.sanitized);

    if (save) {
      saveAnalysis(ticker, enhanced);
    }

    res.json(enhanced);
  } catch (err) {
    res.status(500).json({ error: 'Resynthesize Failed', message: err.message });
  }
});

// ── Phase 3: 回測 API ──

// 觸發回測掃描
app.post('/api/backtest/run', async (req, res) => {
  try {
    const { minDaysAgo = 30, maxResults = 100 } = req.body || {};
    const result = await runBacktest({ minDaysAgo, maxResults });

    // 取最新的摘要統計
    const allChecks = getAccuracySummary();
    const summary = calculateSummary(allChecks);

    res.json({ ...result, summary });
  } catch (err) {
    res.status(500).json({ error: 'Backtest Failed', message: err.message });
  }
});

// 回測摘要統計
app.get('/api/backtest/summary', (req, res) => {
  try {
    const allChecks = getAccuracySummary();
    const summary = calculateSummary(allChecks);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: 'Query Failed', message: err.message });
  }
});

// 特定股票的回測紀錄
app.get('/api/backtest/:ticker', (req, res) => {
  const { ticker } = req.params;
  if (!isValidTicker(ticker)) {
    return res.status(400).json({ error: 'Bad Request', message: `Invalid ticker format: ${ticker}` });
  }

  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const checks = getAccuracyByTicker(ticker, limit);
    const metrics = calculateSummary(checks);
    res.json({ ticker, checks, metrics });
  } catch (err) {
    res.status(500).json({ error: 'Query Failed', message: err.message });
  }
});

// ── Phase 3: 投組持倉管理 ──

// 取全部持倉
app.get('/api/portfolio/holdings', (req, res) => {
  try {
    const holdings = getHoldings();
    res.json({ holdings });
  } catch (err) {
    res.status(500).json({ error: 'Query Failed', message: err.message });
  }
});

// 新增/更新持倉
app.put('/api/portfolio/holdings/:ticker', (req, res) => {
  const { ticker } = req.params;
  if (!isValidTicker(ticker)) {
    return res.status(400).json({ error: 'Bad Request', message: `Invalid ticker format: ${ticker}` });
  }

  try {
    const { shares = 0, costBasis = 0, notes = '' } = req.body || {};
    upsertHolding(ticker, { shares, costBasis, notes });
    const holding = getHolding(ticker);
    res.json({ ticker, holding });
  } catch (err) {
    res.status(500).json({ error: 'Operation Failed', message: err.message });
  }
});

// 移除持倉
app.delete('/api/portfolio/holdings/:ticker', (req, res) => {
  const { ticker } = req.params;
  if (!isValidTicker(ticker)) {
    return res.status(400).json({ error: 'Bad Request', message: `Invalid ticker format: ${ticker}` });
  }

  try {
    const result = removeHolding(ticker);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Operation Failed', message: err.message });
  }
});

// 投組分析（績效 + 配置 + 風險）
app.get('/api/portfolio/analytics', (req, res) => {
  try {
    const holdings = getHoldings();
    const latestAnalyses = {};
    for (const h of holdings) {
      const latest = getLatest(h.ticker);
      if (latest) latestAnalyses[h.ticker] = latest;
    }
    const analytics = calculatePortfolioAnalytics(holdings, latestAnalyses);
    res.json(analytics);
  } catch (err) {
    res.status(500).json({ error: 'Analytics Failed', message: err.message });
  }
});

// ── Phase 3: 警示管理 ──

// 列出所有啟用中的警示
app.get('/api/alerts', (req, res) => {
  try {
    const alerts = getActiveAlerts();
    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ error: 'Query Failed', message: err.message });
  }
});

// 建立警示
app.post('/api/alerts', (req, res) => {
  const { ticker, alertType, threshold } = req.body || {};

  if (!ticker || !isValidTicker(ticker)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Valid ticker is required' });
  }

  const validTypes = ['price_above', 'price_below', 'upside_above', 'classification_change'];
  if (!validTypes.includes(alertType)) {
    return res.status(400).json({ error: 'Bad Request', message: `alertType must be one of: ${validTypes.join(', ')}` });
  }

  if (alertType !== 'classification_change' && (threshold == null || typeof threshold !== 'number')) {
    return res.status(400).json({ error: 'Bad Request', message: 'threshold (number) is required for this alert type' });
  }

  try {
    const info = createAlert(ticker, alertType, threshold ?? 0);
    res.json({ id: info.lastInsertRowid, ticker, alertType, threshold });
  } catch (err) {
    res.status(500).json({ error: 'Operation Failed', message: err.message });
  }
});

// 停用警示
app.delete('/api/alerts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid alert id' });
  }

  try {
    const result = deactivateAlert(id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Operation Failed', message: err.message });
  }
});

// 觸發一次警示檢查
app.post('/api/alerts/check', async (req, res) => {
  try {
    const alerts = getActiveAlerts();
    if (alerts.length === 0) {
      return res.json({ triggered: [], message: 'No active alerts' });
    }

    // 收集所有需要的 ticker
    const tickers = [...new Set(alerts.map(a => a.ticker))];

    // 取最新分析
    const latestAnalyses = {};
    for (const ticker of tickers) {
      const latest = getLatest(ticker);
      if (latest) latestAnalyses[ticker] = latest;
    }

    // 取當前股價（抓最近 5 天避免假日）
    const currentPrices = {};
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const startDate = fiveDaysAgo.toISOString().slice(0, 10);

    await Promise.all(tickers.map(async (ticker) => {
      try {
        const prices = await fetchStockPrice(ticker, startDate);
        if (prices.length > 0) {
          currentPrices[ticker] = parseFloat(prices[prices.length - 1].close);
        }
      } catch { /* skip ticker on error */ }
    }));

    // 檢查觸發
    const triggered = checkAlerts(alerts, latestAnalyses, currentPrices);

    // 更新觸發時間
    for (const t of triggered) {
      updateAlertTriggered(t.alert.id);
    }

    res.json({
      triggered: triggered.map(t => ({
        alertId: t.alert.id,
        ticker: t.alert.ticker,
        type: t.alert.alert_type,
        threshold: t.alert.threshold,
        message: t.message,
      })),
      checkedCount: alerts.length,
      triggeredCount: triggered.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Alert Check Failed', message: err.message });
  }
});

// 取得追蹤清單
app.get('/api/portfolio', (req, res) => {
  try {
    const tickers = getPortfolio();
    res.json({ tickers });
  } catch (err) {
    res.status(500).json({ error: 'Query Failed', message: err.message });
  }
});

// 新增追蹤
app.post('/api/portfolio', (req, res) => {
  const { tickers } = req.body || {};

  if (!Array.isArray(tickers) || tickers.length === 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'Request body must contain a non-empty tickers array' });
  }

  const invalid = tickers.filter(t => !isValidTicker(t));
  if (invalid.length > 0) {
    return res.status(400).json({ error: 'Bad Request', message: `Invalid ticker(s): ${invalid.join(', ')}` });
  }

  try {
    const added = tickers.map(t => addToPortfolio(t));
    res.json({ added });
  } catch (err) {
    res.status(500).json({ error: 'Operation Failed', message: err.message });
  }
});

// 移除追蹤
app.delete('/api/portfolio/:ticker', (req, res) => {
  const { ticker } = req.params;

  if (!isValidTicker(ticker)) {
    return res.status(400).json({ error: 'Bad Request', message: `Invalid ticker format: ${ticker}` });
  }

  try {
    const result = removeFromPortfolio(ticker);
    res.json({ removed: result.removed, ticker });
  } catch (err) {
    res.status(500).json({ error: 'Operation Failed', message: err.message });
  }
});

// ── 啟動伺服器 ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Valuation API running on port ${PORT}`);
});
