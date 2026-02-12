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
