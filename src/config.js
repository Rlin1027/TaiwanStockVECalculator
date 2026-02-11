// ── 台股雙軌估值系統 — 集中設定 ──

/** 產業 WACC 對照表（折現率） */
export const SECTOR_WACC = {
  '半導體':     { min: 0.10, max: 0.12, default: 0.10 },
  '電子零組件': { min: 0.09, max: 0.11, default: 0.10 },
  '資訊服務':   { min: 0.09, max: 0.11, default: 0.10 },
  '通信網路':   { min: 0.08, max: 0.10, default: 0.09 },
  '光電':       { min: 0.10, max: 0.12, default: 0.11 },
  '金融保險':   { min: 0.06, max: 0.08, default: 0.07 },
  '傳產':       { min: 0.08, max: 0.10, default: 0.09 },
  '食品':       { min: 0.07, max: 0.09, default: 0.08 },
  '營建':       { min: 0.08, max: 0.10, default: 0.09 },
  '電信':       { min: 0.06, max: 0.08, default: 0.07 },
  'default':    { min: 0.08, max: 0.12, default: 0.10 },
};

/** 常見股票的產業分類（可擴充） */
export const TICKER_SECTOR = {
  '2330': '半導體', '2303': '半導體', '2454': '半導體', '3711': '半導體',
  '2317': '電子零組件', '2382': '電子零組件', '3231': '電子零組件',
  '2412': '電信', '3045': '資訊服務',
  '2881': '金融保險', '2882': '金融保險', '2883': '金融保險',
  '2884': '金融保險', '2885': '金融保險', '2886': '金融保險',
  '2887': '金融保險', '2891': '金融保險', '2892': '金融保險',
  '1301': '傳產', '1303': '傳產', '1326': '傳產', '2002': '傳產',
  '1216': '食品', '1227': '食品',
  '2912': '傳產', '5880': '金融保險',
};

/** DCF 模型參數 */
export const DCF_CONFIG = {
  terminalGrowthRate: 0.02,   // 終端成長率（台灣 GDP 長期平均）
  projectionYears: 5,          // 預測年數
  maxGrowthRate: 0.15,         // 成長率上限
  minGrowthRate: 0.00,         // 成長率下限（不做負成長預測）
  marginOfSafety: 0.25,        // 安全邊際 25%
  taxRate: 0.20,               // 有效稅率（NOPAT 估算用）
};

/** 股利分析參數 */
export const DIVIDEND_CONFIG = {
  payoutSafe: 0.70,            // 配息率安全閾值
  payoutModerate: 0.90,        // 配息率警告閾值
  aristocratYears: 10,         // 股利貴族最低連續配息年數
  minYearsForAnalysis: 3,      // 最少需要幾年數據
};

/** FinMind API 設定 */
export const API_CONFIG = {
  baseUrl: 'https://api.finmindtrade.com/api/v4/data',
  defaultLookbackYears: 6,     // 預設抓取年數（多抓一年避免邊界問題）
};

/**
 * 取得指定股票的 WACC
 */
export function getWACC(ticker, sector = null) {
  const s = sector || TICKER_SECTOR[ticker] || 'default';
  const config = SECTOR_WACC[s] || SECTOR_WACC['default'];
  return config.default;
}

/**
 * 取得指定股票的產業名稱
 */
export function getSector(ticker) {
  return TICKER_SECTOR[ticker] || '未分類';
}
