// ── FinMind API 客戶端 ──
// 重構自 scripts/verify_finmind_data.js，封裝為乾淨的 async 函式

import { API_CONFIG } from '../config.js';

const { baseUrl, defaultLookbackYears } = API_CONFIG;

/**
 * 底層 fetch 封裝 — 統一錯誤處理與資料驗證
 */
async function fetchDataset(dataset, ticker, startDate) {
  const url = new URL(baseUrl);
  url.searchParams.set('dataset', dataset);
  url.searchParams.set('data_id', ticker);
  url.searchParams.set('start_date', startDate);

  const token = process.env.FINMIND_API_TOKEN;
  if (token) url.searchParams.set('token', token);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(url.toString(), { signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`FinMind API 請求逾時（30 秒）: ${dataset}`);
    }
    throw err;
  }
  clearTimeout(timeout);
  if (!res.ok) {
    throw new Error(`FinMind API HTTP ${res.status}: ${res.statusText}`);
  }

  const json = await res.json();
  if (json.msg !== 'success') {
    throw new Error(`FinMind API error: ${json.msg}`);
  }

  return json.data || [];
}

/** 計算預設起始日期（往回推 N 年） */
function defaultStartDate(years = defaultLookbackYears) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

// ── 公開 API ──

/** 取得歷史股價（需 6 年以上供殖利率河流圖分析） */
export async function fetchStockPrice(ticker, startDate = defaultStartDate()) {
  return fetchDataset('TaiwanStockPrice', ticker, startDate);
}

/** 取得財報數據（Revenue, EPS, Operating Income 等） */
export async function fetchFinancials(ticker, startDate = defaultStartDate()) {
  return fetchDataset('TaiwanStockFinancialStatements', ticker, startDate);
}

/** 取得現金流量表 */
export async function fetchCashFlows(ticker, startDate = defaultStartDate()) {
  return fetchDataset('TaiwanStockCashFlowsStatement', ticker, startDate);
}

/** 取得歷年配息紀錄 */
export async function fetchDividends(ticker, startDate = defaultStartDate(11)) {
  return fetchDataset('TaiwanStockDividend', ticker, startDate);
}

/** 取得歷史本益比 / 股價淨值比 */
export async function fetchPER(ticker, startDate = defaultStartDate()) {
  return fetchDataset('TaiwanStockPER', ticker, startDate);
}

/** 取得股票基本資訊（含 Industry_category 產業分類） */
export async function fetchStockInfo(ticker) {
  return fetchDataset('TaiwanStockInfo', ticker, defaultStartDate(1));
}

/** 取得月營收數據（預設抓 3 年） */
export async function fetchMonthRevenue(ticker, startDate = defaultStartDate(3)) {
  return fetchDataset('TaiwanStockMonthRevenue', ticker, startDate);
}

/** 取得資產負債表 */
export async function fetchBalanceSheet(ticker, startDate = defaultStartDate()) {
  return fetchDataset('TaiwanStockBalanceSheet', ticker, startDate);
}

/**
 * 一次並行抓取所有數據（減少等待時間）
 * @returns {{ price, financials, cashFlows, dividends, per, stockInfo, monthRevenue, balanceSheet }}
 */
export async function fetchAllData(ticker) {
  const [price, financials, cashFlows, dividends, per, stockInfo, monthRevenue, balanceSheet] = await Promise.all([
    fetchStockPrice(ticker),
    fetchFinancials(ticker),
    fetchCashFlows(ticker),
    fetchDividends(ticker),
    fetchPER(ticker),
    fetchStockInfo(ticker),
    fetchMonthRevenue(ticker),
    fetchBalanceSheet(ticker),
  ]);

  // 取得最新收盤價
  const latestPrice = price.length > 0
    ? parseFloat(price[price.length - 1].close)
    : 0;

  // stockInfo 取第一筆（通常只有一筆基本資料）
  const stockInfoRecord = stockInfo.length > 0 ? stockInfo[0] : null;

  return {
    ticker,
    latestPrice,
    priceHistory: price,
    financials,
    cashFlows,
    dividends,
    per,
    stockInfo: stockInfoRecord,
    monthRevenue,
    balanceSheet,
  };
}
