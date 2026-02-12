#!/usr/bin/env node
// 批次測試腳本 — 接收股票代號列表，輸出精簡摘要

import 'dotenv/config';
import { fetchAllData } from './api/finmind.js';
import { calculateDCF } from './models/dcf.js';
import { analyzeDividend } from './models/dividend.js';
import { analyzePER } from './models/per.js';
import { synthesize } from './report/synthesizer.js';

const tickers = process.argv.slice(2);
if (tickers.length === 0) {
  console.error('用法: node src/batch-test.js 2330 2454 ...');
  process.exit(1);
}

const batchName = process.env.BATCH_NAME || 'Batch';
console.log(`\n=== ${batchName}：測試 ${tickers.length} 檔 ===\n`);

const results = [];

for (const ticker of tickers) {
  try {
    const data = await fetchAllData(ticker);
    if (data.latestPrice === 0) {
      results.push({ ticker, status: 'ERROR', reason: '無股價數據' });
      continue;
    }

    const dcf = calculateDCF({
      ticker, financials: data.financials,
      cashFlows: data.cashFlows, currentPrice: data.latestPrice,
    });
    const dividend = analyzeDividend({
      ticker, dividends: data.dividends,
      priceHistory: data.priceHistory, financials: data.financials,
      currentPrice: data.latestPrice,
    });
    const per = analyzePER({
      ticker, per: data.per,
      financials: data.financials, currentPrice: data.latestPrice,
    });
    const report = synthesize({
      dcf, dividend, per, ticker, currentPrice: data.latestPrice,
    });

    const rec = report.recommendation;
    const wv = report.weightedValuation;
    results.push({
      ticker,
      status: 'OK',
      price: data.latestPrice,
      fairValue: wv.fairValue,
      upside: rec.upside,
      action: rec.action,
      confidence: rec.confidence,
      type: report.classification.type,
      method: wv.method,
    });

    const icon = rec.action === 'BUY' ? '🟢' : rec.action === 'HOLD' ? '🟡' : '🔴';
    console.log(`${icon} ${ticker} | ${data.latestPrice}→${wv.fairValue} 元 | ${rec.upside > 0 ? '+' : ''}${rec.upside}% | ${rec.action}(${rec.confidence}) | ${report.classification.type}`);
  } catch (err) {
    results.push({ ticker, status: 'ERROR', reason: err.message });
    console.log(`❌ ${ticker} | 錯誤: ${err.message}`);
  }
}

// 統計摘要
const ok = results.filter(r => r.status === 'OK');
const buys = ok.filter(r => r.action === 'BUY');
const holds = ok.filter(r => r.action === 'HOLD');
const sells = ok.filter(r => r.action === 'SELL');
const errors = results.filter(r => r.status === 'ERROR');

console.log(`\n--- ${batchName} 摘要 ---`);
console.log(`成功: ${ok.length} | 錯誤: ${errors.length}`);
console.log(`🟢 BUY: ${buys.length} | 🟡 HOLD: ${holds.length} | 🔴 SELL: ${sells.length}`);
if (buys.length > 0) console.log(`  BUY: ${buys.map(r => `${r.ticker}(${r.upside}%)`).join(', ')}`);
if (sells.length > 0) console.log(`  SELL: ${sells.map(r => `${r.ticker}(${r.upside}%)`).join(', ')}`);

// 輸出 JSON 供彙總用
const jsonPath = `/tmp/batch_${batchName.replace(/\s/g, '_')}.json`;
import('node:fs').then(fs => {
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\n結果已存: ${jsonPath}`);
});
