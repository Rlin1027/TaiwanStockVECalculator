// ── 核心分析服務 ──
// 從 index.js 提取的分析邏輯，供 CLI 和 API 共用

import { fetchAllData } from './api/finmind.js';
import { calculateDCF } from './models/dcf.js';
import { analyzeDividend } from './models/dividend.js';
import { analyzePER } from './models/per.js';
import { analyzePBR } from './models/pbr.js';
import { analyzeCapEx } from './models/capex.js';
import { analyzeEVEBITDA } from './models/ev-ebitda.js';
import { analyzePSR } from './models/psr.js';
import { analyzeRevenueMomentum } from './models/momentum.js';
import { synthesize } from './report/synthesizer.js';
import { toJSON } from './report/formatters.js';

/**
 * 分析單一股票，回傳與 toJSON(synthesize(...)) 相同的結構
 * @param {string} ticker - 股票代號 (4-6 位數字)
 * @returns {Promise<object>} 估值分析結果 JSON 物件
 */
export async function analyzeStock(ticker) {
  // Step 1: 抓取所有數據
  const data = await fetchAllData(ticker);

  if (data.latestPrice === 0) {
    throw new Error('無法取得股價數據，請確認股票代號是否正確');
  }

  // Step 2: 營收動能分析
  const momentum = analyzeRevenueMomentum({ monthRevenue: data.monthRevenue });

  // Step 3: 執行七模型（保持與 index.js 相同的執行順序和 try/catch）

  let dcfResult;
  try {
    dcfResult = calculateDCF({
      ticker,
      financials: data.financials,
      cashFlows: data.cashFlows,
      currentPrice: data.latestPrice,
      momentum,
      stockInfo: data.stockInfo,
    });
  } catch (err) {
    dcfResult = { ticker, fairValue: 0, upside: 0, signal: 'N/A', sector: '未知', details: { growthRate: 0, wacc: 0, fcfBase: 0, sharesMethod: 'N/A', terminalWarning: null, growthPhases: [], momentumAdjustment: null } };
  }

  let dividendResult;
  try {
    dividendResult = analyzeDividend({
      ticker,
      dividends: data.dividends,
      priceHistory: data.priceHistory,
      financials: data.financials,
      currentPrice: data.latestPrice,
      stockInfo: data.stockInfo,
    });
  } catch (err) {
    dividendResult = { ticker, available: false, reason: `模型錯誤: ${err.message}` };
  }

  let perResult;
  try {
    perResult = analyzePER({
      ticker,
      per: data.per,
      financials: data.financials,
      currentPrice: data.latestPrice,
    });
  } catch (err) {
    perResult = { ticker, available: false, reason: `模型錯誤: ${err.message}` };
  }

  let pbrResult;
  try {
    pbrResult = analyzePBR({
      ticker,
      per: data.per,
      balanceSheet: data.balanceSheet,
      financials: data.financials,
      currentPrice: data.latestPrice,
    });
  } catch (err) {
    pbrResult = { ticker, available: false, reason: `模型錯誤: ${err.message}` };
  }

  // CapEx 依賴 PER result
  let capexResult;
  try {
    capexResult = analyzeCapEx({
      ticker,
      financials: data.financials,
      cashFlows: data.cashFlows,
      per: perResult,
      currentPrice: data.latestPrice,
    });
  } catch (err) {
    capexResult = { available: false, reason: `模型錯誤: ${err.message}` };
  }

  let evEbitdaResult;
  try {
    evEbitdaResult = analyzeEVEBITDA({
      ticker,
      financials: data.financials,
      cashFlows: data.cashFlows,
      balanceSheet: data.balanceSheet,
      currentPrice: data.latestPrice,
    });
  } catch (err) {
    evEbitdaResult = { available: false, reason: `模型錯誤: ${err.message}` };
  }

  let psrResult;
  try {
    psrResult = analyzePSR({
      ticker,
      financials: data.financials,
      currentPrice: data.latestPrice,
    });
  } catch (err) {
    psrResult = { available: false, reason: `模型錯誤: ${err.message}` };
  }

  // Step 4: 綜合判斷
  const report = synthesize({
    dcf: dcfResult,
    dividend: dividendResult,
    per: perResult,
    pbr: pbrResult,
    capex: capexResult,
    evEbitda: evEbitdaResult,
    psr: psrResult,
    momentum,
    ticker,
    currentPrice: data.latestPrice,
  });

  // 回傳與 toJSON() 相同的結構（JSON 物件）
  return JSON.parse(toJSON(report));
}

/**
 * 批次分析多檔股票，含速率控制
 * @param {string[]} tickers - 股票代號陣列
 * @param {object} [options]
 * @param {number} [options.delayMs] - 每檔間隔毫秒數，預設 3000
 * @returns {Promise<{results: object[], errors: object[]}>}
 */
export async function analyzeBatch(tickers, options = {}) {
  const delayMs = options.delayMs ?? parseInt(process.env.BATCH_DELAY_MS || '3000', 10);
  const results = [];
  const errors = [];

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    try {
      const result = await analyzeStock(ticker);
      results.push(result);
    } catch (err) {
      errors.push({ ticker, error: err.message });
    }

    // 速率控制：非最後一檔時等待
    if (i < tickers.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return { results, errors };
}
