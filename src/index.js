#!/usr/bin/env node

// ── 台股雙軌估值分析系統 — 主入口 ──
// 用法: node src/index.js <股票代號> [--format json|md|terminal] [--output <path>]

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { fetchAllData } from './api/finmind.js';
import { calculateDCF } from './models/dcf.js';
import { analyzeDividend } from './models/dividend.js';
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
  console.error(`   股價: ${data.latestPrice} 元 | 財報: ${data.financials.length} 筆 | 現金流: ${data.cashFlows.length} 筆 | 股利: ${data.dividends.length} 筆`);

  // ── Step 2: 並行執行雙模型 ──
  console.error('🔬 執行估值模型...');

  const dcfResult = calculateDCF({
    ticker,
    financials: data.financials,
    cashFlows: data.cashFlows,
    currentPrice: data.latestPrice,
  });

  const dividendResult = analyzeDividend({
    ticker,
    dividends: data.dividends,
    priceHistory: data.priceHistory,
    financials: data.financials,
    currentPrice: data.latestPrice,
  });

  // ── Step 3: 綜合判斷 ──
  console.error('📊 綜合分析中...');
  const report = synthesize({
    dcf: dcfResult,
    dividend: dividendResult,
    ticker,
    currentPrice: data.latestPrice,
  });

  // ── Step 4: 格式化輸出 ──
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
