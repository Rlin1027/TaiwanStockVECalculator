// ── 估值分析 HTTP API 伺服器 ──

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { analyzeStock, analyzeBatch } from './service.js';
import { saveAnalysis, getHistory, addToPortfolio, removeFromPortfolio, getPortfolio } from './db.js';

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
