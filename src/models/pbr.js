// ── Model D: PBR 股價淨值比估值模型 ──
// 適用於金融業（主要）及週期性產業（輔助）
// 使用 FinMind TaiwanStockPER 的 PBR 欄位 + 資產負債表的 BVPS

import { round, mean, stddev, estimateSharesOutstanding } from './utils.js';

/**
 * PBR 估值分析
 *
 * @param {object} params
 * @param {string} params.ticker - 股票代號
 * @param {Array}  params.per - TaiwanStockPER 原始數據（含 price_book_ratio 欄位）
 * @param {Array}  params.balanceSheet - TaiwanStockBalanceSheet 原始數據
 * @param {Array}  params.financials - TaiwanStockFinancialStatements 原始數據
 * @param {number} params.currentPrice - 目前股價
 * @returns {object} PBRResult
 */
export function analyzePBR({ ticker, per, balanceSheet, financials, currentPrice }) {
  // ── 1. 從 PER 數據取得歷史 PBR ──
  const pbrRecords = (per || [])
    .filter(d => {
      const pbr = parseFloat(d.price_book_ratio || d.PBR);
      return !isNaN(pbr) && pbr > 0;
    })
    .map(d => ({
      date: d.date,
      pbr: parseFloat(d.price_book_ratio || d.PBR),
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (pbrRecords.length < 20) {
    return {
      ticker,
      available: false,
      reason: `PBR 歷史數據不足（僅 ${pbrRecords.length} 筆，需至少 20 筆）`,
    };
  }

  // ── 2. 計算 BVPS（每股淨值） ──
  let bvps = null;

  // 方法 A：從資產負債表取股東權益
  if (balanceSheet && balanceSheet.length > 0) {
    bvps = extractBVPS(balanceSheet, financials);
  }

  // 方法 B：從最新 PBR 和股價反推
  if (!bvps && pbrRecords.length > 0 && currentPrice > 0) {
    const latestPBR = pbrRecords[pbrRecords.length - 1].pbr;
    if (latestPBR > 0) {
      bvps = currentPrice / latestPBR;
    }
  }

  if (!bvps || bvps <= 0) {
    return {
      ticker,
      available: false,
      reason: '無法計算每股淨值 (BVPS)',
    };
  }

  // ── 3. PBR 統計分析 ──
  const pbrValues = pbrRecords.map(d => d.pbr);
  const avgPBR = mean(pbrValues);
  const stdPBR = stddev(pbrValues);
  const currentPBR = currentPrice / bvps;

  // ── 4. 位置判斷（均值 ± 1SD） ──
  let position;
  if (currentPBR < avgPBR - stdPBR) {
    position = '便宜';
  } else if (currentPBR > avgPBR + stdPBR) {
    position = '昂貴';
  } else if (currentPBR < avgPBR) {
    position = '合理偏低';
  } else {
    position = '合理偏高';
  }

  // ── 5. 合理價 = 平均 PBR × BVPS ──
  const fairValue = avgPBR * bvps;
  const upside = currentPrice > 0
    ? ((fairValue - currentPrice) / currentPrice) * 100
    : 0;

  // ── 6. 信號判定 ──
  let signal;
  if (upside > 20) {
    signal = 'UNDERVALUED';
  } else if (upside < -10) {
    signal = 'OVERVALUED';
  } else {
    signal = 'FAIR';
  }

  // PBR 河流圖 bands
  const bands = {
    cheap: round(bvps * (avgPBR - stdPBR)),
    fair: round(bvps * avgPBR),
    expensive: round(bvps * (avgPBR + stdPBR)),
  };

  return {
    ticker,
    available: true,
    fairValue: round(fairValue),
    upside: round(upside),
    signal,
    currentPBR: round(currentPBR, 2),
    avgPBR: round(avgPBR, 2),
    stdPBR: round(stdPBR, 2),
    bvps: round(bvps),
    position,
    bands,
  };
}

/**
 * 從資產負債表提取 BVPS
 */
function extractBVPS(balanceSheet, financials) {
  // 嘗試找股東權益相關欄位
  const equityTypes = [
    'Equity',
    'TotalEquity',
    'EquityAttributableToOwnersOfParent',
    'StockholdersEquity',
  ];

  // 按日期排序（降序），找最新的
  const sorted = [...balanceSheet].sort((a, b) => new Date(b.date) - new Date(a.date));

  let equity = null;
  for (const type of equityTypes) {
    const record = sorted.find(d => d.type === type);
    if (record) {
      equity = parseFloat(record.value);
      if (!isNaN(equity) && equity > 0) break;
      equity = null;
    }
  }

  if (!equity) return null;

  // 估算流通股數
  const sharesResult = estimateSharesOutstanding(financials);
  if (sharesResult) {
    return equity / sharesResult.shares;
  }

  return null;
}
