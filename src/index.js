#!/usr/bin/env node

// ── 台股雙軌估值分析系統 — 主入口 ──
// 用法: node src/index.js <股票代號> [--format json|md|terminal] [--output <path>]

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { fetchAllData } from './api/finmind.js';
import { calculateDCF } from './models/dcf.js';
import { analyzeDividend } from './models/dividend.js';
import { analyzePER } from './models/per.js';
import { analyzePBR } from './models/pbr.js';
import { analyzeCapEx } from './models/capex.js';
import { analyzeRevenueMomentum } from './models/momentum.js';
import { synthesize } from './report/synthesizer.js';
import { toJSON, toMarkdown, toTerminal } from './report/formatters.js';

// ── 解析命令列參數 ──
function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { ticker: null, format: 'terminal', output: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format' && args[i + 1]) {
      result.format = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      result.output = args[++i];
    } else if (!args[i].startsWith('-')) {
      result.ticker = args[i];
    }
  }

  return result;
}

// ── 主流程 ──
async function main() {
  const { ticker, format, output } = parseArgs(process.argv);

  if (!ticker) {
    console.error('用法: node src/index.js <股票代號> [--format json|md|terminal] [--output <path>]');
    console.error('範例: node src/index.js 2330');
    console.error('      node src/index.js 2886 --format md --output report.md');
    process.exit(1);
  }

  // 驗證 ticker 格式（台股代號為 4-6 位數字）
  if (!/^\d{4,6}$/.test(ticker)) {
    console.error(`❌ 無效的股票代號格式: ${ticker}（應為 4-6 位數字，如 2330）`);
    process.exit(1);
  }

  console.error(`\n⏳ 正在分析 ${ticker}...\n`);

  // ── Step 1: 抓取所有數據（並行） ──
  console.error('📡 從 FinMind 抓取數據...');
  let data;
  try {
    data = await fetchAllData(ticker);
  } catch (err) {
    console.error(`❌ 數據抓取失敗: ${err.message}`);
    console.error('   請確認 FINMIND_API_TOKEN 已設定於 .env 檔案中');
    process.exit(1);
  }

  if (data.latestPrice === 0) {
    console.error('❌ 無法取得股價數據，請確認股票代號是否正確');
    process.exit(1);
  }
  console.error(`   股價: ${data.latestPrice} 元 | 財報: ${data.financials.length} 筆 | 現金流: ${data.cashFlows.length} 筆 | 股利: ${data.dividends.length} 筆 | PER: ${data.per.length} 筆`);
  if (data.stockInfo) console.error(`   產業: ${data.stockInfo.industry_category || data.stockInfo.Industry_category || '未知'}`);
  console.error(`   月營收: ${data.monthRevenue.length} 筆 | 資產負債表: ${data.balanceSheet.length} 筆`);

  // ── Step 2: 營收動能分析 ──
  console.error('📈 分析營收動能...');
  const momentum = analyzeRevenueMomentum({ monthRevenue: data.monthRevenue });

  // ── Step 3: 並行執行五模型 ──
  console.error('🔬 執行估值模型...');

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
    console.error(`⚠️ DCF 模型執行失敗: ${err.message}`);
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
    });
  } catch (err) {
    console.error(`⚠️ 股利模型執行失敗: ${err.message}`);
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
    console.error(`⚠️ PER 模型執行失敗: ${err.message}`);
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
    console.error(`⚠️ PBR 模型執行失敗: ${err.message}`);
    pbrResult = { ticker, available: false, reason: `模型錯誤: ${err.message}` };
  }

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
    console.error(`⚠️ CapEx 模型執行失敗: ${err.message}`);
    capexResult = { available: false, reason: `模型錯誤: ${err.message}` };
  }

  // ── Step 4: 綜合判斷 ──
  console.error('📊 綜合分析中...');
  const report = synthesize({
    dcf: dcfResult,
    dividend: dividendResult,
    per: perResult,
    pbr: pbrResult,
    capex: capexResult,
    momentum,
    ticker,
    currentPrice: data.latestPrice,
  });

  // ── Step 5: 格式化輸出 ──
  const formatters = { json: toJSON, md: toMarkdown, terminal: toTerminal };
  const formatter = formatters[format];
  if (!formatter) {
    console.error(`❌ 不支援的格式: ${format}（支援: json, md, terminal）`);
    process.exit(1);
  }

  const formatted = formatter(report);

  if (output) {
    writeFileSync(output, formatted, 'utf-8');
    console.error(`\n✅ 報告已寫入 ${output}`);
  } else {
    // 進度訊息用 stderr，報告用 stdout（方便 pipe）
    console.log(formatted);
  }

  console.error('✅ 分析完成\n');
}

main().catch(err => {
  console.error(`\n❌ 未預期的錯誤: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
