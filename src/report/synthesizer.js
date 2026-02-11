// ── 雙模型綜合判斷引擎 ──
// 根據 DCF 和股利分析結果，判斷股票類型並產出綜合建議

/**
 * 綜合兩個模型的結果
 *
 * @param {object} params
 * @param {object} params.dcf      - calculateDCF() 的結果
 * @param {object} params.dividend - analyzeDividend() 的結果
 * @param {string} params.ticker
 * @param {number} params.currentPrice
 * @returns {object} SynthesisResult
 */
export function synthesize({ dcf, dividend, ticker, currentPrice }) {
  // ── 1. 判斷股票類型 ──
  const classification = classifyStock(dcf, dividend);

  // ── 2. 加權估值 ──
  const weightedValuation = calculateWeightedValuation(dcf, dividend, classification);

  // ── 3. 綜合建議 ──
  const recommendation = generateRecommendation(dcf, dividend, classification, weightedValuation, currentPrice);

  // ── 4. 風險提示 ──
  const risks = identifyRisks(dcf, dividend);

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
    },
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
    timestamp: new Date().toISOString(),
  };
}

/**
 * 股票分類邏輯
 */
function classifyStock(dcf, dividend) {
  const growthRate = dcf.details.growthRate || 0;
  const hasDiv = dividend.available;
  const yieldRate = hasDiv ? dividend.currentYield : 0;
  const isStable = hasDiv && dividend.consistency.consecutiveYears >= 5;
  const payoutOk = hasDiv && dividend.payoutSafety.latestGrade !== 'WARNING';

  // 成長股：成長率 > 10% 且殖利率 < 2%
  if (growthRate > 10 && yieldRate < 2) {
    return {
      type: '成長股',
      description: '高成長、低配息，DCF 模型更具參考價值',
      dcfWeight: 0.80,
      divWeight: 0.20,
    };
  }

  // 存股：殖利率 > 4% 且配息穩定
  if (yieldRate >= 4 && isStable && payoutOk) {
    return {
      type: '存股',
      description: '穩定配息、殖利率佳，股利模型更具參考價值',
      dcfWeight: 0.30,
      divWeight: 0.70,
    };
  }

  // 價值股：殖利率 3-4% 且有一定成長
  if (yieldRate >= 3 && growthRate >= 5) {
    return {
      type: '價值成長股',
      description: '兼具成長與配息，兩模型並重',
      dcfWeight: 0.50,
      divWeight: 0.50,
    };
  }

  // 高配息但不穩定
  if (yieldRate >= 4 && !payoutOk) {
    return {
      type: '高配息風險股',
      description: '殖利率高但配息率偏高，需留意配息可持續性',
      dcfWeight: 0.60,
      divWeight: 0.40,
    };
  }

  // 預設：混合型
  return {
    type: '混合型',
    description: '特徵不明顯，建議兩模型並行參考',
    dcfWeight: 0.55,
    divWeight: 0.45,
  };
}

/**
 * 加權估值
 */
function calculateWeightedValuation(dcf, dividend, classification) {
  const dcfFair = dcf.fairValue || 0;
  const divFair = (dividend.available && dividend.fairValue) ? dividend.fairValue : null;
  // 金融保險業的營運現金流含存放款，不適用 FCF-based DCF
  const isFinancial = dcf.sector === '金融保險';
  const dcfReliable = !isFinancial && dcfFair > 0 && dcf.details.fcfBase > 0;

  // 若股利模型不可用，100% 使用 DCF
  if (!divFair) {
    return {
      fairValue: round(dcfFair),
      method: dcfReliable ? '僅 DCF（股利數據不足）' : '僅 DCF（股利數據不足，且 FCF 為負，參考性低）',
      dcfWeight: 1.0,
      divWeight: 0.0,
    };
  }

  // 若 DCF 不可靠（FCF 為負，常見於金融業），改用股利模型為主
  if (!dcfReliable) {
    return {
      fairValue: round(divFair),
      method: '僅股利模型（DCF 不適用：自由現金流為負）',
      dcfWeight: 0.0,
      divWeight: 1.0,
      dcfFairValue: round(dcfFair),
      divFairValue: round(divFair),
    };
  }

  const weighted = dcfFair * classification.dcfWeight + divFair * classification.divWeight;

  return {
    fairValue: round(weighted),
    method: `DCF ${pct(classification.dcfWeight)} + 股利 ${pct(classification.divWeight)}`,
    dcfWeight: classification.dcfWeight,
    divWeight: classification.divWeight,
    dcfFairValue: round(dcfFair),
    divFairValue: round(divFair),
  };
}

/**
 * 綜合建議
 */
function generateRecommendation(dcf, dividend, classification, weighted, currentPrice) {
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

  return {
    action,
    confidence,
    upside: round(upside),
    fairValue: weighted.fairValue,
    reasons,
  };
}

/**
 * 風險提示
 */
function identifyRisks(dcf, dividend) {
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

  // 股利風險
  if (dividend.available) {
    if (dividend.payoutSafety.latestGrade === 'WARNING') {
      risks.push(`配息率過高（${dividend.payoutSafety.latestPayoutRatio}%），配息可能不可持續`);
    }
    if (dividend.consistency.consecutiveYears < 3) {
      risks.push('連續配息年數不足 3 年，配息穩定性存疑');
    }
  }

  if (risks.length === 0) {
    risks.push('未發現重大風險提示');
  }

  return risks;
}

function round(n, d = 2) {
  return Math.round(n * 10 ** d) / 10 ** d;
}

function pct(n) {
  return `${Math.round(n * 100)}%`;
}
