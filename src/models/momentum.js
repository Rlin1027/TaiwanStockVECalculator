// ── 輔助模型: 月營收動能分析 ──
// 用月營收 YoY 成長率做為前瞻信號，修正 DCF 的歷史 CAGR 滯後問題

import { round, median } from './utils.js';

/**
 * 分析月營收動能
 *
 * @param {object} params
 * @param {Array}  params.monthRevenue - TaiwanStockMonthRevenue 原始數據
 * @returns {object} MomentumResult
 */
export function analyzeRevenueMomentum({ monthRevenue }) {
  if (!monthRevenue || monthRevenue.length < 13) {
    return {
      available: false,
      reason: '月營收數據不足（需至少 13 個月以計算 YoY）',
    };
  }

  // 按日期排序（升序）
  const sorted = [...monthRevenue]
    .map(d => ({
      year: parseInt(d.revenue_year || d.date?.slice(0, 4)),
      month: parseInt(d.revenue_month || d.date?.slice(5, 7)),
      revenue: parseFloat(d.revenue),
    }))
    .filter(d => d.revenue > 0 && !isNaN(d.year) && !isNaN(d.month))
    .sort((a, b) => a.year * 100 + a.month - (b.year * 100 + b.month));

  if (sorted.length < 13) {
    return { available: false, reason: '有效月營收數據不足' };
  }

  // 計算每月 YoY 成長率
  const yoyGrowths = [];
  for (let i = 12; i < sorted.length; i++) {
    const current = sorted[i];
    // 找去年同月
    const lastYear = sorted.find(
      d => d.year === current.year - 1 && d.month === current.month
    );
    if (lastYear && lastYear.revenue > 0) {
      yoyGrowths.push({
        year: current.year,
        month: current.month,
        growth: (current.revenue - lastYear.revenue) / lastYear.revenue,
      });
    }
  }

  if (yoyGrowths.length < 3) {
    return { available: false, reason: 'YoY 成長率數據不足' };
  }

  // 近 3 個月 YoY 中位數（短期動能）
  const recent3 = yoyGrowths.slice(-3).map(d => d.growth);
  const shortTermGrowth = median(recent3);

  // 近 12 個月 YoY 中位數（中期趨勢）
  const recent12 = yoyGrowths.slice(-12).map(d => d.growth);
  const mediumTermGrowth = median(recent12);

  // 動能加速度
  const acceleration = shortTermGrowth - mediumTermGrowth;

  // 信號判定
  let signal;
  if (acceleration > 0.05) {
    signal = 'ACCELERATING';
  } else if (acceleration < -0.05) {
    signal = 'DECELERATING';
  } else {
    signal = 'STABLE';
  }

  return {
    available: true,
    shortTermGrowth: round(shortTermGrowth * 100),
    mediumTermGrowth: round(mediumTermGrowth * 100),
    acceleration: round(acceleration * 100),
    signal,
    // growthAdjustment 由呼叫端根據年度 CAGR 計算
    rawShortTerm: shortTermGrowth,
    rawMediumTerm: mediumTermGrowth,
  };
}

/**
 * 計算 DCF 成長率調整值
 * 若月營收動能 > 年度 CAGR + 10pp → +5pp
 * 若月營收動能 < 年度 CAGR - 10pp → -5pp
 * 否則 → 0
 */
export function calcGrowthAdjustment(momentum, annualCAGR) {
  if (!momentum?.available) return 0;
  const monthlyMomentum = momentum.rawShortTerm;
  if (monthlyMomentum > annualCAGR + 0.10) return 0.05;
  if (monthlyMomentum < annualCAGR - 0.10) return -0.05;
  return 0;
}
