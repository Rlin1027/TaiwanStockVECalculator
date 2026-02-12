#!/usr/bin/env node

// ── 台股雙軌估值分析系統 — 主入口 (CLI) ──
// 用法: node src/index.js <股票代號> [--format json|md|terminal] [--output <path>]

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { analyzeStock } from './service.js';
import { toMarkdown, toTerminal } from './report/formatters.js';

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

  let result;
  try {
    result = await analyzeStock(ticker);
  } catch (err) {
    console.error(`❌ 分析失敗: ${err.message}`);
    process.exit(1);
  }

  // ── 格式化輸出 ──
  // analyzeStock 回傳的是 JSON 物件（與 synthesize 的 report 結構相同）
  const formatters = {
    json: (r) => JSON.stringify(r, null, 2),
    md: toMarkdown,
    terminal: toTerminal,
  };
  const formatter = formatters[format];
  if (!formatter) {
    console.error(`❌ 不支援的格式: ${format}（支援: json, md, terminal）`);
    process.exit(1);
  }

  const formatted = formatter(result);

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
