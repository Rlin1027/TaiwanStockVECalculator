import { round, pct } from '../models/utils.js';

// ── 七模型綜合判斷引擎（V4.0） ──
// 根據 DCF、PER、PBR、股利、CapEx、EV/EBITDA、PSR 分析結果，判斷股票類型並產出綜合建議

export function synthesize({ dcf, dividend, per, pbr = null, capex = null, evEbitda = null, psr = null, momentum = null, ticker, currentPrice }) {
  const classification = classifyStock(dcf, dividend, capex, per);
  const weightedValuation = calculateWeightedValuation(dcf, dividend, per, pbr, capex, evEbitda, psr, classification);
  const recommendation = generateRecommendation(dcf, dividend, per, capex, evEbitda, psr, classification, weightedValuation, currentPrice);
  const risks = identifyRisks(dcf, dividend, per, capex, evEbitda, psr);

  return {
    ticker, currentPrice, classification, weightedValuation, recommendation, risks,
    dcfSummary: {
      fairValue: dcf.fairValue, fairValueWithMargin: dcf.fairValueWithMargin,
      upside: dcf.upside, signal: dcf.signal,
      growthRate: dcf.details.growthRate, wacc: dcf.details.wacc,
      growthPhases: dcf.details.growthPhases,
      momentumAdjustment: dcf.details.momentumAdjustment,
      fcfYield: dcf.details.fcfYield ?? null,
    },
    perSummary: per.available ? {
      fairValue: per.fairValue, upside: per.upside, signal: per.signal,
      currentPE: per.currentPE, avgPE: per.avgPE, stdPE: per.stdPE, position: per.position,
    } : { available: false, reason: per.reason },
    pbrSummary: pbr?.available ? {
      fairValue: pbr.fairValue, upside: pbr.upside, signal: pbr.signal,
      currentPBR: pbr.currentPBR, avgPBR: pbr.avgPBR, stdPBR: pbr.stdPBR,
      bvps: pbr.bvps, position: pbr.position,
    } : { available: false, reason: pbr?.reason || 'PBR 模型不可用' },
    capexSummary: capex?.available ? {
      fairValue: capex.fairValue, upside: capex.upside, signal: capex.signal,
      capExCAGR: capex.capExCAGR, recentCapExGrowth: capex.recentCapExGrowth,
      capExIntensity: capex.capExIntensity, sectorConfidence: capex.sectorConfidence,
      transmissionRatio: capex.transmissionRatio, operatingLeverage: capex.operatingLeverage,
      forwardRevenueGrowth: capex.forwardRevenueGrowth, forwardEarningsGrowth: capex.forwardEarningsGrowth,
      ttmEPS: capex.ttmEPS, forwardEPS: capex.forwardEPS, avgPE: capex.avgPE, peSource: capex.peSource,
    } : { available: false, reason: capex?.reason || 'CapEx 模型不可用' },
    evEbitdaSummary: evEbitda?.available ? {
      fairValue: evEbitda.fairValue, upside: evEbitda.upside, signal: evEbitda.signal,
      currentEVEBITDA: evEbitda.currentEVEBITDA, avgEVEBITDA: evEbitda.avgEVEBITDA,
      ebitda: evEbitda.ebitda, ev: evEbitda.ev, position: evEbitda.position,
    } : { available: false, reason: evEbitda?.reason || 'EV/EBITDA 模型不可用' },
    psrSummary: psr?.available ? {
      fairValue: psr.fairValue, upside: psr.upside, signal: psr.signal,
      currentPSR: psr.currentPSR, avgPSR: psr.avgPSR, rps: psr.rps, position: psr.position,
    } : { available: false, reason: psr?.reason || 'PSR 模型不可用' },
    dividendSummary: dividend.available ? {
      fairValue: dividend.fairValue, upside: dividend.upside, signal: dividend.signal,
      currentYield: dividend.currentYield, yieldPosition: dividend.yieldBands.position,
      payoutGrade: dividend.payoutSafety.latestGrade,
      consecutiveYears: dividend.consistency.consecutiveYears,
      isAristocrat: dividend.consistency.isAristocrat,
      ggm: dividend.ggm ?? null,
    } : { available: false, reason: dividend.reason },
    momentumSummary: momentum?.available ? {
      shortTermGrowth: momentum.shortTermGrowth, mediumTermGrowth: momentum.mediumTermGrowth,
      acceleration: momentum.acceleration, signal: momentum.signal,
    } : { available: false },
    timestamp: new Date().toISOString(),
  };
}

function classifyStock(dcf, dividend, capex, per) {
  const growthRate = dcf.details.growthRate || 0;
  const hasDiv = dividend.available;
  const yieldRate = hasDiv ? dividend.currentYield : 0;
  const isStable = hasDiv && dividend.consistency.consecutiveYears >= 5;
  const payoutOk = hasDiv && dividend.payoutSafety.latestGrade !== 'WARNING';
  const isFinancial = dcf.sector === '金融保險';
  const isCyclical = dcf.sector === '週期性';
  const highCapEx = capex?.available && capex.capExIntensity > 15;
  const hasNegativeEPS = per && !per.available && per.reason?.includes('EPS 為負');

  if (isFinancial) {
    return { type: '金融業', description: '營運現金流含存放款，PBR 主導估值',
      dcfWeight: 0.00, perWeight: 0.25, pbrWeight: 0.35, divWeight: 0.28, capexWeight: 0.02, evEbitdaWeight: 0.10, psrWeight: 0.00 };
  }
  if (isCyclical) {
    return { type: '週期性', description: '週期性產業，EV/EBITDA + PBR + 正規化 DCF 多軌估值',
      dcfWeight: 0.15, perWeight: 0.10, pbrWeight: 0.20, divWeight: 0.15, capexWeight: 0.15, evEbitdaWeight: 0.20, psrWeight: 0.05 };
  }
  if (hasNegativeEPS && growthRate > 5) {
    return { type: '虧損成長股', description: 'EPS 為負，PSR 主導估值，DCF + EV/EBITDA 補充',
      dcfWeight: 0.15, perWeight: 0.00, pbrWeight: 0.05, divWeight: 0.00, capexWeight: 0.10, evEbitdaWeight: 0.30, psrWeight: 0.40 };
  }
  if (growthRate > 10 && yieldRate < 2) {
    if (highCapEx) {
      return { type: '成長股', description: '高成長高資本支出，CapEx 驅動未來產能擴張',
        dcfWeight: 0.30, perWeight: 0.20, pbrWeight: 0.00, divWeight: 0.10, capexWeight: 0.20, evEbitdaWeight: 0.10, psrWeight: 0.10 };
    }
    return { type: '成長股', description: '高成長低資本支出，DCF 主導，PER 補充市場定價',
      dcfWeight: 0.35, perWeight: 0.25, pbrWeight: 0.00, divWeight: 0.12, capexWeight: 0.08, evEbitdaWeight: 0.10, psrWeight: 0.10 };
  }
  if (yieldRate >= 4 && isStable && payoutOk) {
    return { type: '存股', description: '穩定配息，股利模型主導',
      dcfWeight: 0.08, perWeight: 0.18, pbrWeight: 0.08, divWeight: 0.45, capexWeight: 0.06, evEbitdaWeight: 0.10, psrWeight: 0.05 };
  }
  if (yieldRate >= 3 && growthRate >= 5) {
    return { type: '價值成長股', description: '兼具成長與配息，七模型均衡',
      dcfWeight: 0.20, perWeight: 0.18, pbrWeight: 0.06, divWeight: 0.25, capexWeight: 0.11, evEbitdaWeight: 0.12, psrWeight: 0.08 };
  }
  return { type: '混合型', description: '特徵不明顯，七模型平均分配參考',
    dcfWeight: 0.20, perWeight: 0.20, pbrWeight: 0.06, divWeight: 0.22, capexWeight: 0.10, evEbitdaWeight: 0.12, psrWeight: 0.10 };
}

function calculateWeightedValuation(dcf, dividend, per, pbr, capex, evEbitda, psr, classification) {
  const dcfFair = dcf.fairValue || 0;
  const divFair = (dividend.available && dividend.fairValue) ? dividend.fairValue : null;
  const perFair = (per.available && per.fairValue) ? per.fairValue : null;
  const pbrFair = (pbr?.available && pbr.fairValue) ? pbr.fairValue : null;
  const capexFair = (capex?.available && capex.fairValue) ? capex.fairValue : null;
  const evEbitdaFair = (evEbitda?.available && evEbitda.fairValue) ? evEbitda.fairValue : null;
  const psrFair = (psr?.available && psr.fairValue) ? psr.fairValue : null;
  const isFinancial = dcf.sector === '金融保險';
  const dcfReliable = !isFinancial && dcfFair > 0 && dcf.details.fcfBase > 0;

  let weights = {
    dcf: dcfReliable ? classification.dcfWeight : 0,
    per: perFair ? classification.perWeight : 0,
    pbr: pbrFair ? (classification.pbrWeight || 0) : 0,
    div: divFair ? classification.divWeight : 0,
    capex: capexFair ? (classification.capexWeight || 0) : 0,
    evEbitda: evEbitdaFair ? (classification.evEbitdaWeight || 0) : 0,
    psr: psrFair ? (classification.psrWeight || 0) : 0,
  };

  // 信心度動態調整
  if (weights.dcf > 0 && dcf.details?.terminalRatio > 85) weights.dcf *= 0.6;
  else if (weights.dcf > 0 && dcf.details?.terminalRatio > 75) weights.dcf *= 0.8;
  if (weights.dcf > 0 && dcf.details?.fcfBase < 0) weights.dcf *= 0.3;
  if (weights.capex > 0 && capex?.sectorConfidence === 'LOW') weights.capex *= 0.5;
  else if (weights.capex > 0 && capex?.sectorConfidence === 'HIGH') weights.capex *= 1.2;

  const totalWeight = Object.values(weights).reduce((s, v) => s + v, 0);
  if (totalWeight === 0) {
    return { fairValue: round(dcfFair), method: '僅 DCF 原始值（其他模型不可用，參考性低）',
      dcfWeight: 1.0, perWeight: 0.0, pbrWeight: 0.0, divWeight: 0.0, capexWeight: 0.0, evEbitdaWeight: 0.0, psrWeight: 0.0 };
  }
  for (const k of Object.keys(weights)) weights[k] /= totalWeight;

  const weighted =
    (dcfReliable ? dcfFair : 0) * weights.dcf +
    (perFair || 0) * weights.per +
    (pbrFair || 0) * weights.pbr +
    (divFair || 0) * weights.div +
    (capexFair || 0) * weights.capex +
    (evEbitdaFair || 0) * weights.evEbitda +
    (psrFair || 0) * weights.psr;

  const parts = [];
  if (weights.dcf > 0) parts.push('DCF ' + pct(weights.dcf));
  if (weights.per > 0) parts.push('PER ' + pct(weights.per));
  if (weights.pbr > 0) parts.push('PBR ' + pct(weights.pbr));
  if (weights.div > 0) parts.push('股利 ' + pct(weights.div));
  if (weights.capex > 0) parts.push('CapEx ' + pct(weights.capex));
  if (weights.evEbitda > 0) parts.push('EV/EBITDA ' + pct(weights.evEbitda));
  if (weights.psr > 0) parts.push('PSR ' + pct(weights.psr));

  return {
    fairValue: round(weighted), method: parts.join(' + '),
    dcfWeight: round(weights.dcf, 2), perWeight: round(weights.per, 2),
    pbrWeight: round(weights.pbr, 2), divWeight: round(weights.div, 2),
    capexWeight: round(weights.capex, 2), evEbitdaWeight: round(weights.evEbitda, 2),
    psrWeight: round(weights.psr, 2),
    dcfFairValue: dcfReliable ? round(dcfFair) : null,
    perFairValue: perFair ? round(perFair) : null,
    pbrFairValue: pbrFair ? round(pbrFair) : null,
    divFairValue: divFair ? round(divFair) : null,
    capexFairValue: capexFair ? round(capexFair) : null,
    evEbitdaFairValue: evEbitdaFair ? round(evEbitdaFair) : null,
    psrFairValue: psrFair ? round(psrFair) : null,
    confidenceAdjusted: true,
  };
}

function generateRecommendation(dcf, dividend, per, capex, evEbitda, psr, classification, weighted, currentPrice) {
  const upside = currentPrice > 0 ? ((weighted.fairValue - currentPrice) / currentPrice) * 100 : 0;
  let action, confidence, reasons;

  if (upside > 30) { action = 'BUY'; confidence = '強烈'; reasons = ['加權合理價 ' + weighted.fairValue + ' 元，潛在上漲空間 ' + round(upside) + '%']; }
  else if (upside > 10) { action = 'BUY'; confidence = '一般'; reasons = ['加權合理價 ' + weighted.fairValue + ' 元，尚有 ' + round(upside) + '% 空間']; }
  else if (upside > -10) { action = 'HOLD'; confidence = '中性'; reasons = ['目前股價接近合理價位（偏差 ' + round(upside) + '%）']; }
  else { action = 'SELL'; confidence = upside < -25 ? '強烈' : '一般'; reasons = ['目前股價高於合理價 ' + round(Math.abs(upside)) + '%']; }

  reasons.push('股票類型：' + classification.type + ' — ' + classification.description);

  if (per.available) {
    if (per.position === '便宜') reasons.push('PER ' + per.currentPE + 'x 低於歷史平均 ' + per.avgPE + 'x，本益比偏低');
    else if (per.position === '昂貴') reasons.push('PER ' + per.currentPE + 'x 高於歷史平均 ' + per.avgPE + 'x，本益比偏高');
  }
  if (dividend.available) {
    if (dividend.yieldBands.position === '便宜') reasons.push('殖利率位於歷史高位區，價格偏低');
    else if (dividend.yieldBands.position === '昂貴') reasons.push('殖利率位於歷史低位區，價格偏高');
    if (dividend.consistency.isAristocrat) reasons.push('符合台股股利貴族標準（連續配息且穩定成長）');
  }
  if (capex?.available) {
    if (capex.recentCapExGrowth > 20) reasons.push('近期資本支出大幅增加 ' + capex.recentCapExGrowth + '%，未來產能擴張可期');
    else if (capex.recentCapExGrowth < -10) reasons.push('近期資本支出縮減 ' + capex.recentCapExGrowth + '%，成長動能可能放緩');
  }
  if (evEbitda?.available) {
    if (evEbitda.position === '便宜') reasons.push('EV/EBITDA ' + evEbitda.currentEVEBITDA + 'x 低於均值 ' + evEbitda.avgEVEBITDA + 'x，企業價值偏低');
    else if (evEbitda.position === '昂貴') reasons.push('EV/EBITDA ' + evEbitda.currentEVEBITDA + 'x 高於均值 ' + evEbitda.avgEVEBITDA + 'x，企業價值偏高');
  }
  if (psr?.available) {
    if (psr.position === '便宜') reasons.push('PSR ' + psr.currentPSR + 'x 低於均值 ' + psr.avgPSR + 'x，營收估值偏低');
    else if (psr.position === '昂貴') reasons.push('PSR ' + psr.currentPSR + 'x 高於均值 ' + psr.avgPSR + 'x，營收估值偏高');
  }

  return { action, confidence, upside: round(upside), fairValue: weighted.fairValue, reasons };
}

function identifyRisks(dcf, dividend, per, capex, evEbitda, psr) {
  const risks = [];

  if (dcf.details.terminalWarning) risks.push(dcf.details.terminalWarning);
  if (dcf.details.sharesMethod.includes('動態估算')) risks.push('流通股數使用動態估算，公允價值可能有偏差');
  if (dcf.details.fcfBase < 0) risks.push('自由現金流為負值，DCF 估值可靠性降低');

  if (per.available && per.position === '昂貴') {
    risks.push('當前 PER ' + per.currentPE + 'x 超過歷史均值+1SD（' + round(per.avgPE + per.stdPE) + 'x），估值偏高');
  }

  if (dividend.available) {
    if (dividend.payoutSafety.latestGrade === 'WARNING') risks.push('配息率過高（' + dividend.payoutSafety.latestPayoutRatio + '%），配息可能不可持續');
    if (dividend.consistency.consecutiveYears < 3) risks.push('連續配息年數不足 3 年，配息穩定性存疑');
  }

  if (capex?.available) {
    if (capex.recentCapExGrowth < -15) risks.push('公司正在大幅減少資本支出（YoY ' + capex.recentCapExGrowth + '%），未來成長可能受限');
    if (capex.capExIntensity > 25) risks.push('CapEx 強度極高（' + capex.capExIntensity + '%），若投資回報不如預期將嚴重影響獲利');
    if (capex.transmissionRatio < 0.3) risks.push('CapEx → 營收傳導效率偏低（' + capex.transmissionRatio + '），資本投入轉化為營收的效率不佳');
  }

  if (evEbitda?.available && evEbitda.position === '昂貴') {
    risks.push('EV/EBITDA ' + evEbitda.currentEVEBITDA + 'x 高於歷史均值+1SD，企業價值可能被高估');
  }
  if (psr?.available && psr.currentPSR > 10) {
    risks.push('PSR ' + psr.currentPSR + 'x 極高，市場對營收成長的預期可能過於樂觀');
  }

  if (risks.length === 0) risks.push('未發現重大風險提示');
  return risks;
}
