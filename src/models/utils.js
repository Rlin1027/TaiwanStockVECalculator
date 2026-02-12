// ── 共用工具函式 ──
// 從 dcf.js、per.js 抽取的共用函式，供所有估值模型使用

/**
 * 從 FinMind 財報數據中提取指定 type 的年度數值
 * 回傳按日期降序排列的 { date, value } 陣列
 */
export function extractByType(records, type) {
  return records
    .filter(d => d.type === type)
    .map(d => ({ date: d.date, value: parseFloat(d.value) }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

/**
 * 取得最新一筆的 value（若無則回傳 fallback）
 */
export function latestValue(records, type, fallback = 0) {
  const items = extractByType(records, type);
  return items.length > 0 ? items[0].value : fallback;
}

/**
 * 計算 CAGR（複合年增長率）
 * @param {number[]} values - 按時間降序排列的值（[最新, ..., 最舊]）
 * @param {number} years - 跨越年數
 */
export function calcCAGR(values, years) {
  if (values.length < 2 || years <= 0) return null;
  const latest = values[0];
  const oldest = values[values.length - 1];
  if (oldest <= 0 || latest <= 0) return null;
  return Math.pow(latest / oldest, 1 / years) - 1;
}

/**
 * 從累計式 YTD 現金流資料中提取年度數值
 * FinMind 現金流量表為累計 YTD：Q1, Q1+Q2, Q1+Q2+Q3, Full Year (Q4/12月)
 * 回傳年度值，按年份降序排列
 */
export function extractAnnualCashFlow(records, type) {
  const filtered = records
    .filter(d => d.type === type)
    .map(d => ({ date: d.date, value: parseFloat(d.value) }));

  const byYear = {};
  for (const d of filtered) {
    const year = d.date.slice(0, 4);
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(d);
  }

  const annuals = [];
  for (const [year, entries] of Object.entries(byYear)) {
    const sorted = entries.sort((a, b) => new Date(b.date) - new Date(a.date));
    const latest = sorted[0];
    const month = parseInt(latest.date.slice(5, 7));

    if (month === 12) {
      annuals.push({ year, value: latest.value, complete: true });
    } else {
      const quarterCount = Math.ceil(month / 3);
      annuals.push({ year, value: latest.value * (4 / quarterCount), complete: false });
    }
  }

  return annuals.sort((a, b) => b.year.localeCompare(a.year));
}

/**
 * 將單季財報資料彙整為年度總計
 * FinMind 損益表為單季數據，需要加總 4 季為年度值
 * 回傳按年份降序排列
 */
export function aggregateAnnualFinancials(records, type) {
  const filtered = records
    .filter(d => d.type === type)
    .map(d => ({ date: d.date, value: parseFloat(d.value) }));

  const byYear = {};
  for (const d of filtered) {
    const year = d.date.slice(0, 4);
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(d.value);
  }

  const annuals = [];
  for (const [year, values] of Object.entries(byYear)) {
    const sum = values.reduce((s, v) => s + v, 0);
    annuals.push({ year, value: sum, quarters: values.length });
  }

  return annuals.sort((a, b) => b.year.localeCompare(a.year));
}

/**
 * 從財報數據計算 TTM EPS（最近 4 季加總）
 */
export function calcTTM_EPS(financials) {
  const epsRecords = financials
    .filter(d => d.type === 'EPS')
    .map(d => ({ date: d.date, value: parseFloat(d.value) }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (epsRecords.length < 4) return null;

  const recent4 = epsRecords.slice(0, 4);
  return recent4.reduce((sum, r) => sum + r.value, 0);
}

/**
 * 四捨五入到指定小數位
 */
export function round(n, d = 2) {
  return Math.round(n * 10 ** d) / 10 ** d;
}

/**
 * 算術平均數
 */
export function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/**
 * 樣本標準差（除以 N-1）
 * 統一三個河流圖模型的計算基準
 */
export function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * 中位數
 */
export function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 百分比格式化（0.35 → "35%"）
 */
export function pct(n) {
  return `${Math.round(n * 100)}%`;
}

/**
 * 從財報數據估算流通股數
 * 用 IncomeAfterTaxes / EPS 推算，含千元單位修正
 * @returns {{ shares: number, method: string } | null}
 */
export function estimateSharesOutstanding(financials) {
  const epsRecords = (financials || [])
    .filter(d => d.type === 'EPS')
    .map(d => ({ date: d.date, value: parseFloat(d.value) }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const niRecords = (financials || [])
    .filter(d => d.type === 'IncomeAfterTaxes')
    .map(d => ({ date: d.date, value: parseFloat(d.value) }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (epsRecords.length === 0 || niRecords.length === 0) return null;

  const eps = epsRecords[0].value;
  const ni = niRecords[0].value;
  if (eps === 0 || ni === 0) return null;

  const rawShares = Math.abs(ni / eps);
  if (rawShares > 1e7 && rawShares < 3e11) {
    return { shares: rawShares, method: '稅後淨利 / EPS' };
  }

  const sharesK = Math.abs((ni * 1000) / eps);
  if (sharesK > 1e7 && sharesK < 3e11) {
    return { shares: sharesK, method: '稅後淨利(千元) / EPS' };
  }

  return null;
}
