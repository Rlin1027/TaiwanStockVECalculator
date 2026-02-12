// ── SQLite 資料庫層 ──
// 使用 better-sqlite3 儲存分析歷史和追蹤清單

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/valuation.db';

// 確保目錄存在
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// 啟用 WAL 模式提升並發效能
db.pragma('journal_mode = WAL');

// 自動建表
db.exec(`
  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS portfolio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT UNIQUE NOT NULL,
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_analyses_ticker ON analyses(ticker);
  CREATE INDEX IF NOT EXISTS idx_analyses_created_at ON analyses(created_at);

  -- Phase 3: 回測準確度驗證
  CREATE TABLE IF NOT EXISTS accuracy_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    analysis_date TEXT NOT NULL,
    predicted_fair_value REAL NOT NULL,
    predicted_action TEXT NOT NULL,
    price_at_analysis REAL NOT NULL,
    classification_type TEXT,
    actual_price_30d REAL,
    actual_price_90d REAL,
    actual_price_180d REAL,
    direction_correct_30d INTEGER,
    direction_correct_90d INTEGER,
    direction_correct_180d INTEGER,
    model_fair_values_json TEXT,
    model_errors_json TEXT,
    checked_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (analysis_id) REFERENCES analyses(id)
  );
  CREATE INDEX IF NOT EXISTS idx_accuracy_ticker ON accuracy_checks(ticker);
  CREATE INDEX IF NOT EXISTS idx_accuracy_date ON accuracy_checks(analysis_date);

  -- Phase 3: 智慧投組管理
  CREATE TABLE IF NOT EXISTS portfolio_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    shares REAL DEFAULT 0,
    cost_basis REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(ticker)
  );

  -- Phase 3: 警示系統
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    threshold REAL,
    is_active INTEGER DEFAULT 1,
    last_triggered_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_ticker ON alerts(ticker);
  CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(is_active);
`);

// ── 分析歷史 ──

export function saveAnalysis(ticker, result) {
  const stmt = db.prepare('INSERT INTO analyses (ticker, result_json) VALUES (?, ?)');
  return stmt.run(ticker, JSON.stringify(result));
}

export function getHistory(ticker, limit = 10) {
  const stmt = db.prepare('SELECT id, ticker, result_json, created_at FROM analyses WHERE ticker = ? ORDER BY created_at DESC LIMIT ?');
  const rows = stmt.all(ticker, limit);
  return rows.map(row => ({
    id: row.id,
    ticker: row.ticker,
    result: JSON.parse(row.result_json),
    createdAt: row.created_at,
  }));
}

// ── 追蹤清單 ──

export function addToPortfolio(ticker) {
  const stmt = db.prepare('INSERT OR IGNORE INTO portfolio (ticker) VALUES (?)');
  const info = stmt.run(ticker);
  return { ticker, added: info.changes > 0 };
}

export function removeFromPortfolio(ticker) {
  const stmt = db.prepare('DELETE FROM portfolio WHERE ticker = ?');
  const info = stmt.run(ticker);
  return { ticker, removed: info.changes > 0 };
}

export function getPortfolio() {
  const stmt = db.prepare('SELECT ticker, added_at FROM portfolio ORDER BY added_at');
  return stmt.all().map(row => ({
    ticker: row.ticker,
    addedAt: row.added_at,
  }));
}

// ── LLM 重新合成用查詢 ──

export function getLatestTwo(ticker) {
  const stmt = db.prepare('SELECT id, ticker, result_json, created_at FROM analyses WHERE ticker = ? ORDER BY created_at DESC LIMIT 2');
  const rows = stmt.all(ticker);
  return rows.map(row => ({
    id: row.id,
    ticker: row.ticker,
    result: JSON.parse(row.result_json),
    createdAt: row.created_at,
  }));
}

export function getLatest(ticker) {
  const stmt = db.prepare('SELECT id, ticker, result_json, created_at FROM analyses WHERE ticker = ? ORDER BY created_at DESC LIMIT 1');
  const row = stmt.get(ticker);
  if (!row) return null;
  return {
    id: row.id,
    ticker: row.ticker,
    result: JSON.parse(row.result_json),
    createdAt: row.created_at,
  };
}

// ── Phase 3: 回測準確度 ──

export function saveAccuracyCheck(data) {
  const stmt = db.prepare(`
    INSERT INTO accuracy_checks
      (analysis_id, ticker, analysis_date, predicted_fair_value, predicted_action,
       price_at_analysis, classification_type, actual_price_30d, actual_price_90d,
       actual_price_180d, direction_correct_30d, direction_correct_90d,
       direction_correct_180d, model_fair_values_json, model_errors_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    data.analysisId, data.ticker, data.analysisDate,
    data.predictedFairValue, data.predictedAction, data.priceAtAnalysis,
    data.classificationType || null,
    data.actualPrice30d ?? null, data.actualPrice90d ?? null, data.actualPrice180d ?? null,
    data.directionCorrect30d ?? null, data.directionCorrect90d ?? null, data.directionCorrect180d ?? null,
    data.modelFairValuesJson ? JSON.stringify(data.modelFairValuesJson) : null,
    data.modelErrorsJson ? JSON.stringify(data.modelErrorsJson) : null,
  );
}

export function getAccuracyByTicker(ticker, limit = 20) {
  const stmt = db.prepare('SELECT * FROM accuracy_checks WHERE ticker = ? ORDER BY analysis_date DESC LIMIT ?');
  const rows = stmt.all(ticker, limit);
  return rows.map(row => ({
    ...row,
    model_fair_values_json: row.model_fair_values_json ? JSON.parse(row.model_fair_values_json) : null,
    model_errors_json: row.model_errors_json ? JSON.parse(row.model_errors_json) : null,
  }));
}

export function getAccuracySummary() {
  return db.prepare('SELECT * FROM accuracy_checks ORDER BY analysis_date DESC').all().map(row => ({
    ...row,
    model_fair_values_json: row.model_fair_values_json ? JSON.parse(row.model_fair_values_json) : null,
    model_errors_json: row.model_errors_json ? JSON.parse(row.model_errors_json) : null,
  }));
}

export function getUncheckedAnalyses(minDaysAgo = 30) {
  const stmt = db.prepare(`
    SELECT a.id, a.ticker, a.result_json, a.created_at
    FROM analyses a
    LEFT JOIN accuracy_checks ac ON ac.analysis_id = a.id
    WHERE ac.id IS NULL
      AND julianday('now') - julianday(a.created_at) >= ?
    ORDER BY a.created_at ASC
  `);
  return stmt.all(minDaysAgo).map(row => ({
    id: row.id,
    ticker: row.ticker,
    result: JSON.parse(row.result_json),
    createdAt: row.created_at,
  }));
}

export function getPartialAccuracyChecks() {
  const stmt = db.prepare(`
    SELECT * FROM accuracy_checks
    WHERE (actual_price_90d IS NULL AND julianday('now') - julianday(analysis_date) >= 90)
       OR (actual_price_180d IS NULL AND julianday('now') - julianday(analysis_date) >= 180)
  `);
  return stmt.all().map(row => ({
    ...row,
    model_fair_values_json: row.model_fair_values_json ? JSON.parse(row.model_fair_values_json) : null,
    model_errors_json: row.model_errors_json ? JSON.parse(row.model_errors_json) : null,
  }));
}

export function updateAccuracyCheck(id, updates) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  fields.push("checked_at = datetime('now')");
  values.push(id);
  const stmt = db.prepare(`UPDATE accuracy_checks SET ${fields.join(', ')} WHERE id = ?`);
  return stmt.run(...values);
}

// ── Phase 3: 投組持倉管理 ──

export function upsertHolding(ticker, { shares = 0, costBasis = 0, notes = '' } = {}) {
  const stmt = db.prepare(`
    INSERT INTO portfolio_holdings (ticker, shares, cost_basis, notes, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(ticker) DO UPDATE SET
      shares = excluded.shares,
      cost_basis = excluded.cost_basis,
      notes = excluded.notes,
      updated_at = datetime('now')
  `);
  return stmt.run(ticker, shares, costBasis, notes);
}

export function getHoldings() {
  return db.prepare('SELECT * FROM portfolio_holdings ORDER BY ticker').all();
}

export function getHolding(ticker) {
  return db.prepare('SELECT * FROM portfolio_holdings WHERE ticker = ?').get(ticker) || null;
}

export function removeHolding(ticker) {
  const info = db.prepare('DELETE FROM portfolio_holdings WHERE ticker = ?').run(ticker);
  return { ticker, removed: info.changes > 0 };
}

// ── Phase 3: 警示系統 ──

export function createAlert(ticker, alertType, threshold) {
  const stmt = db.prepare('INSERT INTO alerts (ticker, alert_type, threshold) VALUES (?, ?, ?)');
  return stmt.run(ticker, alertType, threshold);
}

export function getActiveAlerts() {
  return db.prepare('SELECT * FROM alerts WHERE is_active = 1 ORDER BY created_at DESC').all();
}

export function getAlertsByTicker(ticker) {
  return db.prepare('SELECT * FROM alerts WHERE ticker = ? ORDER BY created_at DESC').all(ticker);
}

export function deactivateAlert(id) {
  const info = db.prepare('UPDATE alerts SET is_active = 0 WHERE id = ?').run(id);
  return { id, deactivated: info.changes > 0 };
}

export function updateAlertTriggered(id) {
  return db.prepare("UPDATE alerts SET last_triggered_at = datetime('now') WHERE id = ?").run(id);
}
