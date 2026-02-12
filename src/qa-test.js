#!/usr/bin/env node

// ── 0050 ETF 成份股 QA 測試腳本 ──
// 用法:
//   node src/qa-test.js                   # 跑全部 50 檔
//   node src/qa-test.js --batch-size 5    # 只跑前 5 檔
//   node src/qa-test.js --sector 金融     # 只跑金融股

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
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

// ── 0050 成份股清單 ──
const TAIWAN_50 = {
  // --- 半導體 (6) ---
  '2330': '台積電', '2303': '聯電', '2454': '聯發科',
  '3711': '日月光投控', '3034': '聯詠', '8046': '南電',
  // --- 電子 (14) ---
  '2317': '鴻海', '2382': '廣達', '3231': '緯創',
  '2301': '光寶科', '2308': '台達電', '2357': '華碩',
  '3037': '欣興', '6669': '緯穎', '2345': '智邦',
  '2379': '瑞昱', '2327': '國巨', '3008': '大立光',
  '2395': '研華', '4938': '和碩',
  // --- 金融 (11) ---
  '2881': '富邦金', '2882': '國泰金', '2891': '中信金',
  '2886': '兆豐金', '2884': '玉山金', '2885': '元大金',
  '2892': '第一金', '2887': '台新金', '2883': '開發金',
  '5880': '合庫金', '2880': '華南金',
  // --- 傳產/週期 (12) ---
  '1301': '台塑', '1303': '南亞', '1326': '台化',
  '6505': '台塑化', '2002': '中鋼', '1101': '台泥',
  '1102': '亞泥', '1216': '統一', '2912': '統一超',
  '2207': '和泰車', '9910': '豐泰', '1227': '佳格',
  // --- 電信/服務 (3) ---
  '2412': '中華電', '3045': '台灣大', '4904': '遠傳',
  // --- 航運 (2) ---
  '2603': '長榮', '2609': '陽明',
  // --- 其他 (2) ---
  '5871': '中租-KY', '2615': '萬海',
};

// ── 產業分組（用於 --sector 過濾） ──
const SECTORS = {
  '半導體': ['2330', '2303', '2454', '3711', '3034', '8046'],
  '電子': ['2317', '2382', '3231', '2301', '2308', '2357', '3037', '6669', '2345', '2379', '2327', '3008', '2395', '4938'],
  '金融': ['2881', '2882', '2891', '2886', '2884', '2885', '2892', '2887', '2883', '5880', '2880'],
  '傳產': ['1301', '1303', '1326', '6505', '2002', '1101', '1102', '1216', '2912', '2207', '9910', '1227'],
  '電信': ['2412', '3045', '4904'],
  '航運': ['2603', '2609', '2615'],
  '金控': ['5871'],
};

// ── 金融股清單（用於 Level 2 DCF 判斷） ──
const FINANCIAL_TICKERS = new Set(['2881', '2882', '2883', '2884', '2885', '2886', '2887', '2891', '2892', '5880', '2880']);

// ── 工具函式 ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 命令列參數解析 ──
function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { batchSize: null, sector: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--batch-size' && args[i + 1]) {
      result.batchSize = parseInt(args[++i], 10);
    } else if (args[i] === '--sector' && args[i + 1]) {
      result.sector = args[++i];
    }
  }

  return result;
}

// ── 取得要測試的股票清單 ──
function getTickerList(opts) {
  let tickers = Object.keys(TAIWAN_50);

  if (opts.sector) {
    const sectorTickers = SECTORS[opts.sector];
    if (!sectorTickers) {
      console.error(`無效的產業名稱: ${opts.sector}`);
      console.error(`可用產業: ${Object.keys(SECTORS).join(', ')}`);
      process.exit(1);
    }
    tickers = sectorTickers;
  }

  if (opts.batchSize && opts.batchSize > 0) {
    tickers = tickers.slice(0, opts.batchSize);
  }

  return tickers;
}

// ══════════════════════════════════════════════
// 驗證規則
// ══════════════════════════════════════════════

const VALID_TYPES = ['金融業', '成長股', '存股', '價值成長股', '週期性', '混合型', '虧損成長股'];
const VALID_ACTIONS = ['BUY', 'HOLD', 'SELL'];

// Level 1 — 結構完整性
function validateLevel1(report, ticker) {
  const errors = [];

  if (!report.ticker || report.ticker !== ticker) {
    errors.push(`ticker 不符: 預期 ${ticker}, 得到 ${report.ticker}`);
  }
  if (!(report.currentPrice > 0)) {
    errors.push(`currentPrice 無效: ${report.currentPrice}`);
  }
  if (!report.classification || !VALID_TYPES.includes(report.classification.type)) {
    errors.push(`classification.type 無效: ${report.classification?.type}`);
  }
  if (!report.weightedValuation || !isFinite(report.weightedValuation.fairValue)) {
    errors.push(`weightedValuation.fairValue 非有限數: ${report.weightedValuation?.fairValue}`);
  }
  if (!report.recommendation || !VALID_ACTIONS.includes(report.recommendation.action)) {
    errors.push(`recommendation.action 無效: ${report.recommendation?.action}`);
  }
  if (!report.timestamp) {
    errors.push('timestamp 不存在');
  }

  return errors;
}

// Level 2 — 模型可用性
function validateLevel2(report, ticker) {
  const errors = [];
  let availableCount = 0;

  // DCF: fairValue > 0
  const dcfAvailable = report.dcfSummary && report.dcfSummary.fairValue > 0;
  if (dcfAvailable) availableCount++;

  // Dividend
  const divAvailable = report.dividendSummary && report.dividendSummary.available !== false;
  if (divAvailable) availableCount++;

  // PER
  const perAvailable = report.perSummary && report.perSummary.available !== false;
  if (perAvailable) availableCount++;

  // PBR
  const pbrAvailable = report.pbrSummary && report.pbrSummary.available !== false;
  if (pbrAvailable) availableCount++;

  // CapEx
  const capexAvailable = report.capexSummary && report.capexSummary.available !== false;
  if (capexAvailable) availableCount++;

  // EV/EBITDA
  const evEbitdaAvailable = report.evEbitdaSummary && report.evEbitdaSummary.available !== false;
  if (evEbitdaAvailable) availableCount++;

  // PSR
  const psrAvailable = report.psrSummary && report.psrSummary.available !== false;
  if (psrAvailable) availableCount++;

  if (availableCount < 2) {
    errors.push(`可用模型數不足: ${availableCount}/7 (至少需 2 個)`);
  }

  // DCF 在非金融股中應 available
  if (!FINANCIAL_TICKERS.has(ticker) && !dcfAvailable) {
    errors.push('非金融股但 DCF 不可用 (fairValue <= 0)');
  }

  return { errors, availableCount, dcfAvailable, divAvailable, perAvailable, pbrAvailable, capexAvailable, evEbitdaAvailable, psrAvailable };
}

// Level 3 — 數值合理性
function validateLevel3(report) {
  const errors = [];
  const wv = report.weightedValuation;

  if (!(wv.fairValue > 0)) {
    errors.push(`fairValue <= 0: ${wv.fairValue}`);
  }

  const upside = report.recommendation.upside;
  if (upside < -90 || upside > 500) {
    errors.push(`upside 超出合理範圍 (-90%~+500%): ${upside}%`);
  }

  // PER 合理性
  if (report.perSummary && report.perSummary.available !== false) {
    const pe = report.perSummary.currentPE;
    if (!(pe > 0 && pe < 200)) {
      errors.push(`currentPE 超出範圍 (0~200): ${pe}`);
    }
  }

  // PBR 合理性
  if (report.pbrSummary && report.pbrSummary.available !== false) {
    const pbr = report.pbrSummary.currentPBR;
    if (!(pbr > 0 && pbr < 50)) {
      errors.push(`currentPBR 超出範圍 (0~50): ${pbr}`);
    }
  }

  // 權重加總
  const weightSum = (wv.dcfWeight || 0) + (wv.perWeight || 0) + (wv.pbrWeight || 0) + (wv.divWeight || 0) + (wv.capexWeight || 0) + (wv.evEbitdaWeight || 0) + (wv.psrWeight || 0);
  if (weightSum < 0.99 || weightSum > 1.01) {
    errors.push(`權重加總超出 0.99~1.01: ${weightSum.toFixed(4)}`);
  }

  // 股利殖利率合理性
  if (report.dividendSummary && report.dividendSummary.available !== false) {
    const y = report.dividendSummary.currentYield;
    if (y !== undefined && (y < 0 || y > 30)) {
      errors.push(`currentYield 超出範圍 (0%~30%): ${y}%`);
    }
  }

  return errors;
}

// Level 4 — 跨模型一致性（warning-only）
function validateLevel4(report) {
  const warnings = [];

  // 收集所有模型 signal
  const signals = [];
  if (report.dcfSummary?.signal && report.dcfSummary.signal !== 'N/A') signals.push({ model: 'DCF', signal: report.dcfSummary.signal });
  if (report.perSummary?.signal) signals.push({ model: 'PER', signal: report.perSummary.signal });
  if (report.pbrSummary?.signal) signals.push({ model: 'PBR', signal: report.pbrSummary.signal });
  if (report.dividendSummary?.signal) signals.push({ model: 'Dividend', signal: report.dividendSummary.signal });
  if (report.capexSummary?.signal) signals.push({ model: 'CapEx', signal: report.capexSummary.signal });
  if (report.evEbitdaSummary?.signal) signals.push({ model: 'EV/EBITDA', signal: report.evEbitdaSummary.signal });
  if (report.psrSummary?.signal) signals.push({ model: 'PSR', signal: report.psrSummary.signal });

  // 若 3+ 模型判 UNDERVALUED 但 action 不是 BUY
  const undervalued = signals.filter(s => s.signal === 'UNDERVALUED');
  if (undervalued.length >= 3 && report.recommendation.action !== 'BUY') {
    warnings.push(`${undervalued.length} 個模型判 UNDERVALUED 但建議為 ${report.recommendation.action}`);
  }

  // 計算各 fairValue 的 CV
  const fairValues = [];
  if (report.dcfSummary?.fairValue > 0) fairValues.push(report.dcfSummary.fairValue);
  if (report.perSummary?.fairValue > 0) fairValues.push(report.perSummary.fairValue);
  if (report.pbrSummary?.fairValue > 0) fairValues.push(report.pbrSummary.fairValue);
  if (report.dividendSummary?.fairValue > 0) fairValues.push(report.dividendSummary.fairValue);
  if (report.capexSummary?.fairValue > 0) fairValues.push(report.capexSummary.fairValue);
  if (report.evEbitdaSummary?.fairValue > 0) fairValues.push(report.evEbitdaSummary.fairValue);
  if (report.psrSummary?.fairValue > 0) fairValues.push(report.psrSummary.fairValue);

  if (fairValues.length >= 2) {
    const avg = fairValues.reduce((a, b) => a + b, 0) / fairValues.length;
    const variance = fairValues.reduce((sum, v) => sum + (v - avg) ** 2, 0) / fairValues.length;
    const sd = Math.sqrt(variance);
    const cv = avg > 0 ? sd / avg : 0;
    if (cv > 2.0) {
      warnings.push(`模型 fairValue CV 過高: ${cv.toFixed(2)} (各值: ${fairValues.map(v => v.toFixed(1)).join(', ')})`);
    }
  }

  return warnings;
}

// ══════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════

async function main() {
  const opts = parseArgs(process.argv);
  const tickers = getTickerList(opts);
  const totalCount = tickers.length;
  const startTime = new Date();

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('     0050 QA 測試報告');
  console.log('═══════════════════════════════════════');
  console.log('');
  console.log(`測試時間: ${startTime.toISOString()}`);
  console.log(`成份股數: ${totalCount}`);
  console.log(`API 呼叫預估: ${totalCount * 8} calls`);
  if (opts.sector) console.log(`篩選產業: ${opts.sector}`);
  if (opts.batchSize) console.log(`批次大小: ${opts.batchSize}`);
  console.log('');

  // 統計
  const results = [];
  const stats = {
    pass: 0, warn: 0, fail: 0,
    level1Pass: 0, level2Pass: 0, level3Pass: 0, level4Pass: 0,
    modelAvailability: { dcf: 0, per: 0, pbr: 0, dividend: 0, capex: 0, evEbitda: 0, psr: 0 },
    classificationDist: {},
    threeOrMoreModels: 0,
  };

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const name = TAIWAN_50[ticker] || '未知';
    const prefix = `[${i + 1}/${totalCount}] ${ticker} ${name}`;

    let report;
    let fetchError = null;

    try {
      // Step 1: 抓取數據
      const data = await fetchAllData(ticker);

      // Step 2: 營收動能
      const momentum = analyzeRevenueMomentum({ monthRevenue: data.monthRevenue });

      // Step 3: DCF
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
      } catch (e) {
        dcfResult = {
          ticker, fairValue: 0, upside: 0, signal: 'N/A', sector: '未知',
          details: { growthRate: 0, wacc: 0, fcfBase: 0, sharesMethod: 'N/A', terminalWarning: null, growthPhases: [], momentumAdjustment: null },
        };
      }

      // Step 4: Dividend
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
      } catch (e) {
        dividendResult = { ticker, available: false, reason: `模型錯誤: ${e.message}` };
      }

      // Step 5: PER
      let perResult;
      try {
        perResult = analyzePER({
          ticker,
          per: data.per,
          financials: data.financials,
          currentPrice: data.latestPrice,
        });
      } catch (e) {
        perResult = { ticker, available: false, reason: `模型錯誤: ${e.message}` };
      }

      // Step 6: PBR
      let pbrResult;
      try {
        pbrResult = analyzePBR({
          ticker,
          per: data.per,
          balanceSheet: data.balanceSheet,
          financials: data.financials,
          currentPrice: data.latestPrice,
        });
      } catch (e) {
        pbrResult = { ticker, available: false, reason: `模型錯誤: ${e.message}` };
      }

      // Step 7: CapEx (用 perResult)
      let capexResult;
      try {
        capexResult = analyzeCapEx({
          ticker,
          financials: data.financials,
          cashFlows: data.cashFlows,
          per: perResult,
          currentPrice: data.latestPrice,
        });
      } catch (e) {
        capexResult = { available: false, reason: `模型錯誤: ${e.message}` };
      }

      // Step 8: EV/EBITDA
      let evEbitdaResult;
      try {
        evEbitdaResult = analyzeEVEBITDA({
          ticker,
          financials: data.financials,
          cashFlows: data.cashFlows,
          balanceSheet: data.balanceSheet,
          currentPrice: data.latestPrice,
        });
      } catch (e) {
        evEbitdaResult = { available: false, reason: `模型錯誤: ${e.message}` };
      }

      // Step 9: PSR
      let psrResult;
      try {
        psrResult = analyzePSR({
          ticker,
          financials: data.financials,
          currentPrice: data.latestPrice,
        });
      } catch (e) {
        psrResult = { available: false, reason: `模型錯誤: ${e.message}` };
      }

      // Step 10: Synthesize
      report = synthesize({
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

    } catch (e) {
      fetchError = e.message;
    }

    // ── 驗證 ──
    const tickerResult = {
      ticker, name, fetchError,
      level1: [], level2: { errors: [], availableCount: 0 },
      level3: [], level4: [],
      report: null,
    };

    if (fetchError) {
      tickerResult.level1 = [`數據抓取失敗: ${fetchError}`];
      tickerResult.status = 'FAIL';
      stats.fail++;
      console.log(`進度: ${prefix}... FAIL (數據抓取失敗)`);
    } else {
      tickerResult.report = report;

      // Level 1
      tickerResult.level1 = validateLevel1(report, ticker);
      if (tickerResult.level1.length === 0) stats.level1Pass++;

      // Level 2
      tickerResult.level2 = validateLevel2(report, ticker);
      if (tickerResult.level2.errors.length === 0) stats.level2Pass++;

      // 統計模型可用率
      if (tickerResult.level2.dcfAvailable) stats.modelAvailability.dcf++;
      if (tickerResult.level2.perAvailable) stats.modelAvailability.per++;
      if (tickerResult.level2.pbrAvailable) stats.modelAvailability.pbr++;
      if (tickerResult.level2.divAvailable) stats.modelAvailability.dividend++;
      if (tickerResult.level2.capexAvailable) stats.modelAvailability.capex++;
      if (tickerResult.level2.evEbitdaAvailable) stats.modelAvailability.evEbitda++;
      if (tickerResult.level2.psrAvailable) stats.modelAvailability.psr++;
      if (tickerResult.level2.availableCount >= 3) stats.threeOrMoreModels++;

      // Level 3
      tickerResult.level3 = validateLevel3(report);
      if (tickerResult.level3.length === 0) stats.level3Pass++;

      // Level 4
      tickerResult.level4 = validateLevel4(report);
      if (tickerResult.level4.length === 0) stats.level4Pass++;

      // 分類分佈
      const cType = report.classification?.type || '未知';
      stats.classificationDist[cType] = (stats.classificationDist[cType] || 0) + 1;

      // 判定結果
      const hasError = tickerResult.level1.length > 0 || tickerResult.level2.errors.length > 0 || tickerResult.level3.length > 0;
      const hasWarning = tickerResult.level4.length > 0;

      if (hasError) {
        tickerResult.status = 'FAIL';
        stats.fail++;
      } else if (hasWarning) {
        tickerResult.status = 'WARN';
        stats.warn++;
      } else {
        tickerResult.status = 'PASS';
        stats.pass++;
      }

      const statusIcon = tickerResult.status === 'PASS' ? '\u2705' : tickerResult.status === 'WARN' ? '\u26A0\uFE0F' : '\u274C';
      console.log(`進度: ${prefix}... ${statusIcon} (${tickerResult.level2.availableCount}/7 模型)`);
    }

    results.push(tickerResult);

    // Rate limiting: 每檔完成後 sleep 3 秒
    if (i < tickers.length - 1) {
      await sleep(3000);
    }
  }

  // ══════════════════════════════════════════════
  // 結果摘要
  // ══════════════════════════════════════════════
  const endTime = new Date();
  const durationSec = ((endTime - startTime) / 1000).toFixed(1);

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('     結果摘要');
  console.log('═══════════════════════════════════════');
  console.log('');
  console.log(`通過: ${stats.pass}/${totalCount} (${((stats.pass / totalCount) * 100).toFixed(1)}%)`);
  console.log(`警告: ${stats.warn}`);
  console.log(`失敗: ${stats.fail}`);
  console.log(`耗時: ${durationSec} 秒`);
  console.log('');
  console.log(`Level 1 (結構): ${stats.level1Pass}/${totalCount} ${stats.level1Pass === totalCount ? '\u2705' : '\u274C'}`);
  console.log(`Level 2 (可用性): ${stats.level2Pass}/${totalCount} ${stats.level2Pass === totalCount ? '\u2705' : '\u274C'}`);
  console.log(`Level 3 (數值): ${stats.level3Pass}/${totalCount} ${stats.level3Pass === totalCount ? '\u2705' : '\u274C'}`);
  console.log(`Level 4 (一致性): ${stats.level4Pass}/${totalCount} ${stats.level4Pass === totalCount ? '\u2705' : '\u26A0\uFE0F'}`);
  console.log('');

  // >= 90% 有 3+ 模型
  const threeModelPct = ((stats.threeOrMoreModels / totalCount) * 100).toFixed(1);
  console.log(`3+ 模型可用: ${stats.threeOrMoreModels}/${totalCount} (${threeModelPct}%) ${parseFloat(threeModelPct) >= 90 ? '\u2705' : '\u274C'}`);
  console.log('');

  console.log('模型可用率:');
  console.log(`  DCF:      ${stats.modelAvailability.dcf}/${totalCount} (${((stats.modelAvailability.dcf / totalCount) * 100).toFixed(1)}%)`);
  console.log(`  PER:      ${stats.modelAvailability.per}/${totalCount} (${((stats.modelAvailability.per / totalCount) * 100).toFixed(1)}%)`);
  console.log(`  PBR:      ${stats.modelAvailability.pbr}/${totalCount} (${((stats.modelAvailability.pbr / totalCount) * 100).toFixed(1)}%)`);
  console.log(`  Dividend: ${stats.modelAvailability.dividend}/${totalCount} (${((stats.modelAvailability.dividend / totalCount) * 100).toFixed(1)}%)`);
  console.log(`  CapEx:    ${stats.modelAvailability.capex}/${totalCount} (${((stats.modelAvailability.capex / totalCount) * 100).toFixed(1)}%)`);
  console.log(`  EV/EBITDA:${stats.modelAvailability.evEbitda}/${totalCount} (${((stats.modelAvailability.evEbitda / totalCount) * 100).toFixed(1)}%)`);
  console.log(`  PSR:      ${stats.modelAvailability.psr}/${totalCount} (${((stats.modelAvailability.psr / totalCount) * 100).toFixed(1)}%)`);
  console.log('');

  console.log('分類分佈:');
  for (const [type, count] of Object.entries(stats.classificationDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }
  console.log('');

  // ── 失敗詳情 ──
  const failures = results.filter(r => r.status === 'FAIL');
  if (failures.length > 0) {
    console.log('--- 失敗詳情 ---');
    for (const f of failures) {
      console.log(`\n${f.ticker} ${f.name}:`);
      if (f.fetchError) {
        console.log(`  [抓取錯誤] ${f.fetchError}`);
      }
      for (const e of f.level1) console.log(`  [L1] ${e}`);
      for (const e of f.level2.errors) console.log(`  [L2] ${e}`);
      for (const e of f.level3) console.log(`  [L3] ${e}`);
    }
    console.log('');
  }

  // ── 警告詳情 ──
  const warns = results.filter(r => r.level4.length > 0);
  if (warns.length > 0) {
    console.log('--- 警告詳情 ---');
    for (const w of warns) {
      console.log(`\n${w.ticker} ${w.name}:`);
      for (const warning of w.level4) console.log(`  [L4] ${warning}`);
    }
    console.log('');
  }

  // ── JSON 報告輸出 ──
  const date = startTime.toISOString().slice(0, 10);
  const fullReport = {
    meta: {
      testTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationSeconds: parseFloat(durationSec),
      totalStocks: totalCount,
      sector: opts.sector || 'all',
      batchSize: opts.batchSize || null,
    },
    summary: {
      pass: stats.pass,
      warn: stats.warn,
      fail: stats.fail,
      passRate: parseFloat(((stats.pass / totalCount) * 100).toFixed(1)),
      level1Pass: stats.level1Pass,
      level2Pass: stats.level2Pass,
      level3Pass: stats.level3Pass,
      level4Pass: stats.level4Pass,
      threeOrMoreModels: stats.threeOrMoreModels,
      threeOrMoreModelsPct: parseFloat(threeModelPct),
      modelAvailability: stats.modelAvailability,
      classificationDist: stats.classificationDist,
    },
    results: results.map(r => ({
      ticker: r.ticker,
      name: r.name,
      status: r.status,
      fetchError: r.fetchError || null,
      level1Errors: r.level1,
      level2Errors: r.level2.errors,
      level2AvailableCount: r.level2.availableCount,
      level3Errors: r.level3,
      level4Warnings: r.level4,
      report: r.report || null,
    })),
  };

  mkdirSync('output', { recursive: true });
  const reportPath = `output/qa-report-${date}.json`;
  writeFileSync(reportPath, JSON.stringify(fullReport, null, 2));
  console.log(`詳細報告已存: ${reportPath}`);
  console.log('');
}

main().catch(err => {
  console.error(`\n未預期的錯誤: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
