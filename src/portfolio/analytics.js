// ── 投組分析引擎 ──
// 績效追蹤、產業配置、風險指標

import { getSector } from '../config.js';

/**
 * 計算投組分析
 * @param {Array} holdings - portfolio_holdings 紀錄
 * @param {Object} latestAnalyses - { ticker: analysisResult }
 */
export function calculatePortfolioAnalytics(holdings, latestAnalyses) {
  const positions = [];
  let totalValue = 0;
  let totalCost = 0;

  for (const h of holdings) {
    const analysis = latestAnalyses[h.ticker];
    const currentPrice = analysis?.result?.currentPrice || 0;
    const fairValue = analysis?.result?.weightedValuation?.fairValue || 0;
    const action = analysis?.result?.recommendation?.action || 'N/A';
    const upside = analysis?.result?.recommendation?.upside || 0;
    const classificationType = analysis?.result?.classification?.type
      || analysis?.result?.llmClassification?.type || '未分類';

    const marketValue = h.shares * currentPrice;
    const cost = h.shares * h.cost_basis;
    const pnl = h.shares > 0 ? marketValue - cost : 0;
    const pnlPct = cost > 0 ? round2(pnl / cost * 100) : 0;

    if (h.shares > 0) {
      totalValue += marketValue;
      totalCost += cost;
    }

    positions.push({
      ticker: h.ticker,
      shares: h.shares,
      costBasis: h.cost_basis,
      currentPrice,
      marketValue: round2(marketValue),
      pnl: round2(pnl),
      pnlPct,
      fairValue: round2(fairValue),
      upside: round2(upside),
      action,
      classificationType,
      sector: getSector(h.ticker),
      notes: h.notes,
      weight: 0, // 稍後計算
    });
  }

  // 計算各持倉佔比
  if (totalValue > 0) {
    for (const pos of positions) {
      if (pos.shares > 0) {
        pos.weight = round2(pos.marketValue / totalValue * 100);
      }
    }
  }

  // 產業配置
  const sectorAllocation = {};
  for (const pos of positions) {
    if (pos.shares <= 0) continue;
    const sector = pos.sector;
    if (!sectorAllocation[sector]) {
      sectorAllocation[sector] = { value: 0, weight: 0, count: 0 };
    }
    sectorAllocation[sector].value += pos.marketValue;
    sectorAllocation[sector].count++;
  }
  if (totalValue > 0) {
    for (const data of Object.values(sectorAllocation)) {
      data.value = round2(data.value);
      data.weight = round2(data.value / totalValue * 100);
    }
  }

  // 風險指標
  const activePositions = positions.filter(p => p.shares > 0);
  const sortedByWeight = [...activePositions].sort((a, b) => b.weight - a.weight);
  const top3Weight = sortedByWeight.slice(0, 3).reduce((s, p) => s + p.weight, 0);
  const maxSectorWeight = Math.max(...Object.values(sectorAllocation).map(s => s.weight), 0);

  const risk = {
    concentrationTop3: round2(top3Weight),
    sectorConcentration: round2(maxSectorWeight),
    avgUpside: activePositions.length > 0
      ? round2(activePositions.reduce((s, p) => s + p.upside, 0) / activePositions.length)
      : 0,
    buyCount: activePositions.filter(p => p.action === 'BUY').length,
    holdCount: activePositions.filter(p => p.action === 'HOLD').length,
    sellCount: activePositions.filter(p => p.action === 'SELL').length,
  };

  // 估值摘要
  const valuation = {
    undervalued: positions.filter(p => p.upside > 10).map(p => p.ticker),
    overvalued: positions.filter(p => p.upside < -10).map(p => p.ticker),
    fairlyValued: positions.filter(p => p.upside >= -10 && p.upside <= 10).map(p => p.ticker),
  };

  const unrealizedPnL = round2(totalValue - totalCost);

  return {
    totalValue: round2(totalValue),
    totalCost: round2(totalCost),
    unrealizedPnL,
    unrealizedPnLPct: totalCost > 0 ? round2(unrealizedPnL / totalCost * 100) : 0,
    positions,
    sectorAllocation,
    risk,
    valuation,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
