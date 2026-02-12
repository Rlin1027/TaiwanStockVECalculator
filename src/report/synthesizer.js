import { round, pct } from '../models/utils.js';

// ── 五模型綜合判斷引擎（V3.1） ──
// 根據 DCF、PER、PBR、股利、CapEx 分析結果，判斷股票類型並產出綜合建議

/**
 * 綜合五個模型的結果
 *
 * @param {object} params
 * @param {object} params.dcf      - calculateDCF() 的結果
 * @param {object} params.dividend - analyzeDividend() 的結果
 * @param {object} params.per      - analyzePER() 的結果
 * @param {object} params.pbr      - analyzePBR() 的結果
 * @param {object} params.capex    - analyzeCapEx() 的結果
 * @param {object} [params.momentum] - analyzeRevenueMomentum() 的結果
 * @param {string} params.ticker
 * @param {number} params.currentPrice
 * @returns {object} SynthesisResult
 */
export function synthesize({ dcf, dividend, per, pbr = null, capex = null, momentum = null, ticker, currentPrice }) {
  // ── 1. 判斷股票類型（含 CapEx 強度） ──
  const classification = classifyStock(dcf, dividend, capex);

  // ── 2. 加權估值 ──
  const weightedValuation = calculateWeightedValuation(dcf, dividend, per, pbr, capex, classification);

  // ── 3. 綜合建議 ──
  const recommendation = generateRecommendation(dcf, dividend, per, capex, classification, weightedValuation, currentPrice);

  // ── 4. 風險提示 ──
  const risks = identifyRisks(dcf, dividend, per, capex);

  return {
    ticker,
    currentPrice,
    classification,
    weightedValuation,
    recommendation,
    risks,
    dcfSummary: {
      fairValue: dcf.fairValue,
      fairValueWithMargin: dcf.fairValueWithMargin,
      upside: dcf.upside,
      signal: dcf.signal,
      growthRate: dcf.details.growthRate,
      wacc: dcf.details.wacc,
      growthPhases: dcf.details.growthPhases,
      momentumAdjustment: dcf.details.momentumAdjustment,
    },
    perSummary: per.available ? {
      fairValue: per.fairValue,
      upside: per.upside,
      signal: per.signal,
      currentPE: per.currentPE,
      avgPE: per.avgPE,
      stdPE: per.stdPE,
      position: per.position,
    } : { available: false, reason: per.reason },
    pbrSummary: pbr?.available ? {
      fairValue: pbr.fairValue,
      upside: pbr.upside,
      signal: pbr.signal,
      currentPBR: pbr.currentPBR,
      avgPBR: pbr.avgPBR,
      stdPBR: pbr.stdPBR,
      bvps: pbr.bvps,
      position: pbr.position,
    } : { available: false, reason: pbr?.reason || 'PBR 模型不可用' },
    capexSummary: capex?.available ? {
      fairValue: capex.fairValue,
      upside: capex.upside,
      signal: capex.signal,
      capExCAGR: capex.capExCAGR,
      recentCapExGrowth: capex.recentCapExGrowth,
      capExIntensity: capex.capExIntensity,
      sectorConfidence: capex.sectorConfidence,
      transmissionRatio: capex.transmissionRatio,
      operatingLeverage: capex.operatingLeverage,
      forwardRevenueGrowth: capex.forwardRevenueGrowth,
      forwardEarningsGrowth: capex.forwardEarningsGrowth,
      ttmEPS: capex.ttmEPS,
      forwardEPS: capex.forwardEPS,
      avgPE: capex.avgPE,
      peSource: capex.peSource,
    } : { available: false, reason: capex?.reason || 'CapEx 模型不可用' },
    dividendSummary: dividend.available ? {
      fairValue: dividend.fairValue,
      upside: dividend.upside,
      signal: dividend.signal,
      currentYield: dividend.currentYield,
      yieldPosition: dividend.yieldBands.position,
      payoutGrade: dividend.payoutSafety.latestGrade,
      consecutiveYears: dividend.consistency.consecutiveYears,
      isAristocrat: dividend.consistency.isAristocrat,
    } : { available: false, reason: dividend.reason },
    momentumSummary: momentum?.available ? {
      shortTermGrowth: momentum.shortTermGrowth,
      mediumTermGrowth: momentum.mediumTermGrowth,
      acceleration: momentum.acceleration,
      signal: momentum.signal,
    } : { available: false },
    timestamp: new Date().toISOString(),
  };
}

/**
 * 股票分類邏輯（V3.1：五模型權重，含 CapEx）
 */
function classifyStock(dcf, dividend, capex) {
  const growthRate = dcf.details.growthRate || 0;
  const hasDiv = dividend.available;
  const yieldRate = hasDiv ? dividend.currentYield : 0;
  const isStable = hasDiv && dividend.consistency.consecutiveYears >= 5;
  const payoutOk = hasDiv && dividend.payoutSafety.latestGrade !== 'WARNING';
  const isFinancial = dcf.sector === '金融保險';
  const isCyclical = dcf.sector === '週期性';
  const highCapEx = capex?.available && capex.capExIntensity > 15;

  // 金融業：PBR 主導，DCF 不適用
  if (isFinancial) {
    return {
      type: '金融業',
      description: '營運現金流含存放款，PBR 主導估值',
      dcfWeight: 0.00,
      perWeight: 0.28,
      pbrWeight: 0.38,
      divWeight: 0.29,
      capexWeight: 0.05,
    };
  }

  // 週期性產業：PBR + 正規化 DCF + CapEx
  if (isCyclical) {
    return {
      type: '週期性',
      description: '週期性產業，PBR + 正規化 DCF + CapEx 多軌估值',
      dcfWeight: 0.20,
      perWeight: 0.15,
      pbrWeight: 0.25,
      divWeight: 0.20,
      capexWeight: 0.20,
    };
  }

  // 成長股：依 CapEx 強度細分權重
  if (growthRate > 10 && yieldRate < 2) {
    if (highCapEx) {
      return {
        type: '成長股',
        description: '高成長高資本支出，CapEx 驅動未來產能擴張',
        dcfWeight: 0.35,
        perWeight: 0.25,
        pbrWeight: 0.00,
        divWeight: 0.15,
        capexWeight: 0.25,
      };
    }
    return {
      type: '成長股',
      description: '高成長低資本支出，DCF 主導，PER 補充市場定價',
      dcfWeight: 0.45,
      perWeight: 0.28,
      pbrWeight: 0.00,
      divWeight: 0.17,
      capexWeight: 0.10,
    };
  }

  // 存股：股利主導
  if (yieldRate >= 4 && isStable && payoutOk) {
    return {
      type: '存股',
      description: '穩定配息，股利模型主導',
      dcfWeight: 0.10,
      perWeight: 0.22,
      pbrWeight: 0.10,
      divWeight: 0.50,
      capexWeight: 0.08,
    };
  }

  // 價值成長股：均衡
  if (yieldRate >= 3 && growthRate >= 5) {
    return {
      type: '價值成長股',
      description: '兼具成長與配息，五模型均衡',
      dcfWeight: 0.25,
      perWeight: 0.22,
      pbrWeight: 0.08,
      divWeight: 0.30,
      capexWeight: 0.15,
    };
  }

  // 預設：混合型
  return {
    type: '混合型',
    description: '特徵不明顯，五模型平均分配參考',
    dcfWeight: 0.25,
    perWeight: 0.25,
    pbrWeight: 0.08,
    divWeight: 0.27,
    capexWeight: 0.15,
  };
}

/**
 * 加權估值（V3.1：五模型）
 */
function calculateWeightedValuation(dcf, dividend, per, pbr, capex, classification) {
  const dcfFair = dcf.fairValue || 0;
  const divFair = (dividend.available && dividend.fairValue) ? dividend.fairValue : null;
  const perFair = (per.available && per.fairValue) ? per.fairValue : null;
  const pbrFair = (pbr?.available && pbr.fairValue) ? pbr.fairValue : null;
  const capexFair = (capex?.available && capex.fairValue) ? capex.fairValue : null;
  const isFinancial = dcf.sector === '金融保險';
  const dcfReliable = !isFinancial && dcfFair > 0 && dcf.details.fcfBase > 0;

  // 收集可用模型及其權重
  let weights = {
    dcf: dcfReliable ? classification.dcfWeight : 0,
    per: perFair ? classification.perWeight : 0,
    pbr: pbrFair ? (classification.pbrWeight || 0) : 0,
    div: divFair ? classification.divWeight : 0,
    capex: capexFair ? (classification.capexWeight || 0) : 0,
  };

  // 正規化權重（確保總和 = 1）
  const totalWeight = weights.dcf + weights.per + weights.pbr + weights.div + weights.capex;
  if (totalWeight === 0) {
    return {
      fairValue: round(dcfFair),
      method: '僅 DCF 原始值（其他模型不可用，參考性低）',
      dcfWeight: 1.0, perWeight: 0.0, pbrWeight: 0.0, divWeight: 0.0, capexWeight: 0.0,
    };
  }
  weights.dcf /= totalWeight;
  weights.per /= totalWeight;
  weights.pbr /= totalWeight;
  weights.div /= totalWeight;
  weights.capex /= totalWeight;

  const weighted =
    (dcfReliable ? dcfFair : 0) * weights.dcf +
    (perFair || 0) * weights.per +
    (pbrFair || 0) * weights.pbr +
    (divFair || 0) * weights.div +
    (capexFair || 0) * weights.capex;

  // 組合方法說明
  const parts = [];
  if (weights.dcf > 0) parts.push(`DCF ${pct(weights.dcf)}`);
  if (weights.per > 0) parts.push(`PER ${pct(weights.per)}`);
  if (weights.pbr > 0) parts.push(`PBR ${pct(weights.pbr)}`);
  if (weights.div > 0) parts.push(`股利 ${pct(weights.div)}`);
  if (weights.capex > 0) parts.push(`CapEx ${pct(weights.capex)}`);

  return {
    fairValue: round(weighted),
    method: parts.join(' + '),
    dcfWeight: round(weights.dcf, 2),
    perWeight: round(weights.per, 2),
    pbrWeight: round(weights.pbr, 2),
    divWeight: round(weights.div, 2),
    capexWeight: round(weights.capex, 2),
    dcfFairValue: dcfReliable ? round(dcfFair) : null,
    perFairValue: perFair ? round(perFair) : null,
    pbrFairValue: pbrFair ? round(pbrFair) : null,
    divFairValue: divFair ? round(divFair) : null,
    capexFairValue: capexFair ? round(capexFair) : null,
  };
}

/**
 * 綜合建議（V3.1：含 CapEx）
 */
function generateRecommendation(dcf, dividend, per, capex, classification, weighted, currentPrice) {
  const upside = currentPrice > 0
    ? ((weighted.fairValue - currentPrice) / currentPrice) * 100
    : 0;

  let action, confidence, reasons;

  if (upside > 30) {
    action = 'BUY';
    confidence = '強烈';
    reasons = [`加權合理價 ${weighted.fairValue} 元，潛在上漲空間 ${round(upside)}%`];
  } else if (upside > 10) {
    action = 'BUY';
    confidence = '一般';
    reasons = [`加權合理價 ${weighted.fairValue} 元，尚有 ${round(upside)}% 空間`];
  } else if (upside > -10) {
    action = 'HOLD';
    confidence = '中性';
    reasons = [`目前股價接近合理價位（偏差 ${round(upside)}%）`];
  } else {
    action = 'SELL';
    confidence = upside < -25 ? '強烈' : '一般';
    reasons = [`目前股價高於合理價 ${round(Math.abs(upside))}%`];
  }

  // 附加判斷理由
  reasons.push(`股票類型：${classification.type} — ${classification.description}`);

  if (per.available) {
    if (per.position === '便宜') {
      reasons.push(`PER ${per.currentPE}x 低於歷史平均 ${per.avgPE}x，本益比偏低`);
    } else if (per.position === '昂貴') {
      reasons.push(`PER ${per.currentPE}x 高於歷史平均 ${per.avgPE}x，本益比偏高`);
    }
  }

  if (dividend.available) {
    if (dividend.yieldBands.position === '便宜') {
      reasons.push('殖利率位於歷史高位區，價格偏低');
    } else if (dividend.yieldBands.position === '昂貴') {
      reasons.push('殖利率位於歷史低位區，價格偏高');
    }
    if (dividend.consistency.isAristocrat) {
      reasons.push('符合台股股利貴族標準（連續配息且穩定成長）');
    }
  }

  if (capex?.available) {
    if (capex.recentCapExGrowth > 20) {
      reasons.push(`近期資本支出大幅增加 ${capex.recentCapExGrowth}%，未來產能擴張可期`);
    } else if (capex.recentCapExGrowth < -10) {
      reasons.push(`近期資本支出縮減 ${capex.recentCapExGrowth}%，成長動能可能放緩`);
    }
    if (capex.sectorConfidence === 'HIGH') {
      reasons.push(`CapEx 強度 ${capex.capExIntensity}%（高資本密集），CapEx 模型參考價值較高`);
    }
  }

  return {
    action,
    confidence,
    upside: round(upside),
    fairValue: weighted.fairValue,
    reasons,
  };
}

/**
 * 風險提示（V3.1：含 CapEx）
 */
function identifyRisks(dcf, dividend, per, capex) {
  const risks = [];

  // DCF 風險
  if (dcf.details.terminalWarning) {
    risks.push(dcf.details.terminalWarning);
  }
  if (dcf.details.sharesMethod.includes('預設值')) {
    risks.push('流通股數使用預設值，公允價值可能有偏差');
  }
  if (dcf.details.fcfBase < 0) {
    risks.push('自由現金流為負值，DCF 估值可靠性降低');
  }

  // PER 風險
  if (per.available) {
    if (per.position === '昂貴') {
      risks.push(`當前 PER ${per.currentPE}x 超過歷史均值+1SD（${round(per.avgPE + per.stdPE)}x），估值偏高`);
    }
  }

  // 股利風險
  if (dividend.available) {
    if (dividend.payoutSafety.latestGrade === 'WARNING') {
      risks.push(`配息率過高（${dividend.payoutSafety.latestPayoutRatio}%），配息可能不可持續`);
    }
    if (dividend.consistency.consecutiveYears < 3) {
      risks.push('連續配息年數不足 3 年，配息穩定性存疑');
    }
  }

  // CapEx 風險
  if (capex?.available) {
    if (capex.recentCapExGrowth < -15) {
      risks.push(`公司正在大幅減少資本支出（YoY ${capex.recentCapExGrowth}%），未來成長可能受限`);
    }
    if (capex.capExIntensity > 25) {
      risks.push(`CapEx 強度極高（${capex.capExIntensity}%），若投資回報不如預期將嚴重影響獲利`);
    }
    if (capex.transmissionRatio < 0.3) {
      risks.push(`CapEx → 營收傳導效率偏低（${capex.transmissionRatio}），資本投入轉化為營收的效率不佳`);
    }
  }

  if (risks.length === 0) {
    risks.push('未發現重大風險提示');
  }

  return risks;
}
