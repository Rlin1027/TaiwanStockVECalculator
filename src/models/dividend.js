// ── Model B: 股利分析模型（全新） ──
// 三大維度：殖利率河流圖、配息安全性、配息穩定性

import { DIVIDEND_CONFIG } from '../config.js';
import { round, mean, stddev } from './utils.js';

/**
 * 股利分析主函式
 *
 * @param {object} params
 * @param {string} params.ticker
 * @param {Array}  params.dividends    - TaiwanStockDividend 原始數據
 * @param {Array}  params.priceHistory - TaiwanStockPrice 原始數據
 * @param {Array}  params.financials   - TaiwanStockFinancialStatements 原始數據
 * @param {number} params.currentPrice - 目前股價
 * @returns {object} DividendResult
 */
export function analyzeDividend({ ticker, dividends, priceHistory, financials, currentPrice }) {
  const { payoutSafe, payoutModerate, aristocratYears, minYearsForAnalysis } = DIVIDEND_CONFIG;

  // ── 整理年度股利數據 ──
  const annualDividends = buildAnnualDividends(dividends);
  const years = Object.keys(annualDividends).sort();

  if (years.length < minYearsForAnalysis) {
    return {
      ticker,
      currentPrice,
      available: false,
      reason: `股利數據不足（僅 ${years.length} 年，需至少 ${minYearsForAnalysis} 年）`,
    };
  }

  // ── 1. 殖利率河流圖 (Yield Bands) ──
  const yieldData = calculateYieldBands(annualDividends, priceHistory, currentPrice);

  // ── 2. 配息安全性 (Payout Ratio) ──
  const payoutData = calculatePayoutSafety(annualDividends, financials, {
    payoutSafe,
    payoutModerate,
  });

  // ── 3. 配息穩定性 (Consistency) ──
  const consistencyData = calculateConsistency(annualDividends, aristocratYears);

  // ── 4. 股利估值（反推合理價） ──
  // 使用最近「完整年度」的股利（避免當年度僅配部分季度導致偏低）
  const latestDividend = findLatestCompleteDividend(annualDividends, years);
  const fairValue = yieldData.avg5Y > 0
    ? round(latestDividend / yieldData.avg5Y)
    : null;

  const upside = (fairValue && currentPrice > 0)
    ? round(((fairValue - currentPrice) / currentPrice) * 100)
    : null;

  // 綜合信號
  let signal = 'FAIR';
  if (yieldData.position === '便宜' && payoutData.latestGrade !== 'WARNING') {
    signal = 'UNDERVALUED';
  } else if (yieldData.position === '昂貴' || payoutData.latestGrade === 'WARNING') {
    signal = 'OVERVALUED';
  }

  return {
    ticker,
    currentPrice,
    available: true,
    fairValue,
    upside,
    signal,
    currentYield: yieldData.currentYield,
    yieldBands: yieldData,
    payoutSafety: payoutData,
    consistency: consistencyData,
    latestDividend,
    annualDividends,
  };
}

// ── 內部工具函式 ──

/**
 * 找出最近一個「完整年度」的現金股利
 * 若最新年度的配息筆數少於前一年度，視為不完整（季配息尚未全部發放）
 * 回傳完整年度的 cashDividend
 */
function findLatestCompleteDividend(annualDividends, years) {
  if (years.length === 0) return 0;

  // 統計每年有幾筆原始配息記錄（用 cashDividend > 0 的年份比較）
  // 若最後一年的股利金額明顯低於前一年且前一年存在，使用前一年
  const latest = years[years.length - 1];
  const prev = years.length >= 2 ? years[years.length - 2] : null;

  const latestDiv = annualDividends[latest]?.cashDividend || 0;
  const prevDiv = prev ? (annualDividends[prev]?.cashDividend || 0) : 0;

  // 如果最新年度的股利金額不到前一年的 70%，視為不完整年度
  if (prev && prevDiv > 0 && latestDiv < prevDiv * 0.7) {
    return prevDiv;
  }

  return latestDiv;
}

/**
 * 將民國年份轉換為西元年份
 * "113年第2季" → "2024"
 * "103年" → "2014"
 */
function parseROCYear(yearStr) {
  if (!yearStr) return null;
  const match = yearStr.match(/^(\d+)年/);
  if (match) {
    return String(parseInt(match[1]) + 1911);
  }
  return yearStr;
}

/**
 * 將 FinMind 股利原始資料整理為年度資料
 * FinMind TaiwanStockDividend 欄位：
 *   stock_id, date, year, CashEarningsDistribution, StockEarningsDistribution,
 *   CashStaticDistribution, StockStaticDistribution, ...
 * 注意：year 欄位為民國年格式（如 "113年第2季"），需轉換為西元年
 */
function buildAnnualDividends(rawDividends) {
  const byYear = {};

  for (const d of rawDividends) {
    const year = parseROCYear(d.year) || d.date?.slice(0, 4);
    if (!year) continue;

    if (!byYear[year]) {
      byYear[year] = { year, cashDividend: 0, stockDividend: 0 };
    }

    // 現金股利 = 盈餘分配 + 公積分配
    const cashEarnings = parseFloat(d.CashEarningsDistribution) || 0;
    const cashStatic = parseFloat(d.CashStaticDistribution) || 0;
    byYear[year].cashDividend += cashEarnings + cashStatic;

    // 股票股利
    const stockEarnings = parseFloat(d.StockEarningsDistribution) || 0;
    const stockStatic = parseFloat(d.StockStaticDistribution) || 0;
    byYear[year].stockDividend += stockEarnings + stockStatic;
  }

  // 保留總股利
  for (const y of Object.values(byYear)) {
    y.totalDividend = round(y.cashDividend + y.stockDividend);
    y.cashDividend = round(y.cashDividend);
    y.stockDividend = round(y.stockDividend);
  }

  return byYear;
}

/**
 * 殖利率河流圖計算
 */
function calculateYieldBands(annualDividends, priceHistory, currentPrice) {
  const years = Object.keys(annualDividends).sort();
  const yields = [];

  // 計算每年殖利率 = 現金股利 / 該年平均股價
  // 若無當年股價，用配息年份對應的價格
  const priceByYear = buildAveragePriceByYear(priceHistory);

  for (const year of years) {
    const div = annualDividends[year];
    if (div.cashDividend <= 0) continue;

    // 嘗試用該年或前一年均價
    const avgPrice = priceByYear[year] || priceByYear[String(Number(year) - 1)];
    if (!avgPrice || avgPrice <= 0) continue;

    const yieldRate = div.cashDividend / avgPrice;
    yields.push({ year, cashDividend: div.cashDividend, avgPrice: round(avgPrice), yield: round(yieldRate * 100) });
  }

  // 5 年平均殖利率 & 標準差
  const recent5 = yields.slice(-5);
  const yieldValues = recent5.map(y => y.yield);
  const avg5Y = yieldValues.length > 0 ? mean(yieldValues) / 100 : 0;
  const std5Y = yieldValues.length > 1 ? stddev(yieldValues) / 100 : 0;

  // 目前殖利率（使用最近完整年度的股利）
  const latestDiv = findLatestCompleteDividend(annualDividends, years);
  const currentYield = currentPrice > 0 ? round((latestDiv / currentPrice) * 100) : 0;
  const currentYieldDecimal = currentYield / 100;

  // 判斷位置
  let position;
  if (avg5Y === 0) {
    position = '無法判斷';
  } else if (currentYieldDecimal > avg5Y + std5Y) {
    position = '便宜';
  } else if (currentYieldDecimal < avg5Y - std5Y) {
    position = '昂貴';
  } else {
    position = '合理';
  }

  return {
    history: yields,
    avg5Y: round(avg5Y, 4),
    std5Y: round(std5Y, 4),
    currentYield,
    position,
    cheapThreshold: round((avg5Y + std5Y) * 100),
    fairRange: `${round((avg5Y - std5Y) * 100)}% ~ ${round((avg5Y + std5Y) * 100)}%`,
    expensiveThreshold: round((avg5Y - std5Y) * 100),
  };
}

/**
 * 配息安全性（Payout Ratio）
 */
function calculatePayoutSafety(annualDividends, financials, thresholds) {
  const years = Object.keys(annualDividends).sort();
  const epsData = financials
    .filter(d => d.type === 'EPS')
    .map(d => ({ date: d.date, value: parseFloat(d.value) }));

  // 建立年度 EPS 對照（加總各季 EPS 為年度 EPS）
  const epsByYear = {};
  for (const e of epsData) {
    const year = e.date.slice(0, 4);
    if (!epsByYear[year]) epsByYear[year] = 0;
    epsByYear[year] += e.value;
  }

  const ratios = [];
  for (const year of years) {
    const div = annualDividends[year];
    // 股利通常是上一年度盈餘分配，所以配息率 = 股利 / 上一年 EPS
    const earningsYear = String(Number(year) - 1);
    const eps = epsByYear[earningsYear] || epsByYear[year];
    if (!eps || eps <= 0) continue;

    const ratio = div.cashDividend / eps;
    let grade;
    if (ratio <= thresholds.payoutSafe) grade = 'SAFE';
    else if (ratio <= thresholds.payoutModerate) grade = 'MODERATE';
    else grade = 'WARNING';

    ratios.push({
      year,
      cashDividend: div.cashDividend,
      eps: round(eps),
      payoutRatio: round(ratio * 100),
      grade,
    });
  }

  const latest = ratios.length > 0 ? ratios[ratios.length - 1] : null;

  return {
    history: ratios,
    latestPayoutRatio: latest?.payoutRatio ?? null,
    latestGrade: latest?.grade ?? 'N/A',
    avgPayoutRatio: ratios.length > 0
      ? round(mean(ratios.map(r => r.payoutRatio)))
      : null,
  };
}

/**
 * 配息穩定性（連續配息、股利成長）
 */
function calculateConsistency(annualDividends, aristocratThreshold) {
  const years = Object.keys(annualDividends).sort();
  const cashDivs = years
    .map(y => ({ year: y, cashDividend: annualDividends[y].cashDividend }))
    .filter(d => d.cashDividend > 0);

  // 連續配息年數（從最近一年往回數）
  let consecutiveYears = 0;
  for (let i = cashDivs.length - 1; i >= 0; i--) {
    if (cashDivs[i].cashDividend > 0) {
      consecutiveYears++;
      // 確認年份連續
      if (i > 0 && Number(cashDivs[i].year) - Number(cashDivs[i - 1].year) > 1) break;
    } else {
      break;
    }
  }

  // 股利年增率（YoY Growth）
  const growthRates = [];
  for (let i = 1; i < cashDivs.length; i++) {
    const prev = cashDivs[i - 1].cashDividend;
    const curr = cashDivs[i].cashDividend;
    if (prev > 0) {
      growthRates.push({
        year: cashDivs[i].year,
        growth: round(((curr - prev) / prev) * 100),
      });
    }
  }

  // 是否逐年成長（近 5 年）
  const recent5Growth = growthRates.slice(-5);
  const isGrowing = recent5Growth.length >= 3 &&
    recent5Growth.filter(g => g.growth >= 0).length >= Math.ceil(recent5Growth.length * 0.8);

  // 股利貴族判定
  const isAristocrat = consecutiveYears >= aristocratThreshold && isGrowing;

  return {
    consecutiveYears,
    growthHistory: growthRates,
    avgGrowthRate: growthRates.length > 0 ? round(mean(growthRates.map(g => g.growth))) : null,
    isGrowing,
    isAristocrat,
    totalDividendYears: cashDivs.length,
  };
}

// ── 數學工具 ──

function buildAveragePriceByYear(priceHistory) {
  const byYear = {};
  for (const p of priceHistory) {
    const year = p.date.slice(0, 4);
    if (!byYear[year]) byYear[year] = [];
    const close = parseFloat(p.close);
    if (!isNaN(close)) byYear[year].push(close);
  }
  const result = {};
  for (const [year, prices] of Object.entries(byYear)) {
    result[year] = mean(prices);
  }
  return result;
}
