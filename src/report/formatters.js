import { pct } from '../models/utils.js';

// ── 報告格式化器 ──
// 三種輸出格式，都從同一個 SynthesisResult 生成

// ── JSON 格式（供後續平台整合） ──
export function toJSON(result) {
  return JSON.stringify(result, null, 2);
}

/** 信號 → 表格用 emoji */
function sigEmoji(signal) {
  const map = { UNDERVALUED: '🟢', FAIR: '🟡', OVERVALUED: '🔴' };
  return `${map[signal] || '⚪'} ${signal}`;
}

// ── Markdown 格式（含表格） ──
export function toMarkdown(result) {
  const { ticker, currentPrice, classification, weightedValuation: wv,
    recommendation: rec, risks, dcfSummary: dcf, perSummary: per,
    pbrSummary: pbr, capexSummary: capex, dividendSummary: div, momentumSummary: mom } = result;

  const signalEmoji = { BUY: '🟢', HOLD: '🟡', SELL: '🔴' };
  const gradeEmoji = { SAFE: '🟢', MODERATE: '🟡', WARNING: '🔴', 'N/A': '⚪' };

  let md = '';
  md += `# ${ticker} 估值分析報告\n\n`;
  md += `> 分析時間：${result.timestamp}\n\n`;

  // ── 總覽 ──
  md += `## 總覽\n\n`;
  md += `| 項目 | 數值 |\n|:---|:---|\n`;
  md += `| 股票代號 | **${ticker}** |\n`;
  md += `| 目前股價 | **${currentPrice}** 元 |\n`;
  md += `| 股票類型 | ${classification.type} |\n`;
  md += `| 加權合理價 | **${wv.fairValue}** 元 |\n`;
  md += `| 估值方法 | ${wv.method} |\n`;
  md += `| 綜合建議 | ${signalEmoji[rec.action] || '⚪'} **${rec.action}**（${rec.confidence}）|\n`;
  md += `| 潛在空間 | ${rec.upside > 0 ? '+' : ''}${rec.upside}% |\n\n`;

  // ── 營收動能（若有） ──
  if (mom?.available) {
    md += `## 營收動能信號\n\n`;
    md += `| 指標 | 數值 |\n|:---|---:|\n`;
    md += `| 近 3 月 YoY 中位數 | ${mom.shortTermGrowth}% |\n`;
    md += `| 近 12 月 YoY 中位數 | ${mom.mediumTermGrowth}% |\n`;
    md += `| 動能加速度 | ${mom.acceleration > 0 ? '+' : ''}${mom.acceleration}pp |\n`;
    md += `| 信號 | ${mom.signal} |\n\n`;
  }

  // ── 五模型比較 ──
  md += `## 五模型估值比較\n\n`;
  md += `| 模型 | 合理價 | 信號 | 權重 | 關鍵指標 |\n`;
  md += `|:---|---:|:---|---:|:---|\n`;

  // DCF
  const dcfGrowthPhases = dcf.growthPhases;
  let dcfPhaseStr = `成長率 ${dcf.growthRate}%`;
  if (dcfGrowthPhases && dcfGrowthPhases.length > 0) {
    const phase1 = dcfGrowthPhases[0].growth;
    const phaseLast = dcfGrowthPhases[dcfGrowthPhases.length - 1].growth;
    dcfPhaseStr = `${phase1}% → ${phaseLast}%`;
  }
  if (dcf.momentumAdjustment) dcfPhaseStr += ` (動能${dcf.momentumAdjustment > 0 ? '+' : ''}${dcf.momentumAdjustment}pp)`;
  md += `| DCF（多階段） | ${dcf.fairValue} 元 | ${sigEmoji(dcf.signal)} | ${pct(wv.dcfWeight)} | ${dcfPhaseStr}, WACC ${dcf.wacc}% |\n`;

  // PER
  if (per.available !== false) {
    md += `| PER（本益比） | ${per.fairValue} 元 | ${sigEmoji(per.signal)} | ${pct(wv.perWeight)} | PE ${per.currentPE}x, 均值 ${per.avgPE}x, ${per.position} |\n`;
  } else {
    md += `| PER（本益比） | N/A | ⚪ | ${pct(wv.perWeight)} | ${per.reason} |\n`;
  }

  // PBR
  if (pbr?.available !== false && pbr) {
    md += `| PBR（淨值比） | ${pbr.fairValue} 元 | ${sigEmoji(pbr.signal)} | ${pct(wv.pbrWeight)} | PBR ${pbr.currentPBR}x, 均值 ${pbr.avgPBR}x, ${pbr.position} |\n`;
  } else {
    md += `| PBR（淨值比） | N/A | ⚪ | ${pct(wv.pbrWeight)} | ${pbr?.reason || 'PBR 不可用'} |\n`;
  }

  // CapEx
  if (capex?.available !== false && capex) {
    md += `| CapEx（資本支出） | ${capex.fairValue} 元 | ${sigEmoji(capex.signal)} | ${pct(wv.capexWeight)} | CAGR ${capex.capExCAGR}%, 強度 ${capex.capExIntensity}%, 傳導比 ${capex.transmissionRatio} |\n`;
  } else {
    md += `| CapEx（資本支出） | N/A | ⚪ | ${pct(wv.capexWeight)} | ${capex?.reason || 'CapEx 不可用'} |\n`;
  }

  // 股利
  if (div.available !== false) {
    md += `| 股利（存股） | ${div.fairValue ?? 'N/A'} 元 | ${sigEmoji(div.signal)} | ${pct(wv.divWeight)} | 殖利率 ${div.currentYield}%, ${div.yieldPosition} |\n`;
  } else {
    md += `| 股利（存股） | N/A | ⚪ | ${pct(wv.divWeight)} | ${div.reason} |\n`;
  }
  md += '\n';

  // ── DCF 詳情 ──
  md += `## DCF 模型詳情（多階段成長）\n\n`;
  md += `| 指標 | 數值 |\n|:---|---:|\n`;
  md += `| 合理價 | ${dcf.fairValue} 元 |\n`;
  md += `| 安全邊際價 | ${dcf.fairValueWithMargin} 元 |\n`;
  md += `| 成長率 | ${dcfPhaseStr} |\n`;
  md += `| WACC | ${dcf.wacc}% |\n`;
  md += `| 潛在漲幅 | ${dcf.upside}% |\n\n`;

  // ── PER 詳情 ──
  if (per.available !== false) {
    md += `## PER 本益比河流圖\n\n`;
    md += `| 指標 | 數值 |\n|:---|---:|\n`;
    md += `| 合理價 | ${per.fairValue} 元 |\n`;
    md += `| 當前 PER | ${per.currentPE}x |\n`;
    md += `| 歷史平均 PER | ${per.avgPE}x |\n`;
    md += `| PER 標準差 | ${per.stdPE}x |\n`;
    md += `| 估值位置 | ${per.position} |\n\n`;
  }

  // ── 股利詳情 ──
  if (div.available !== false) {
    md += `## 股利分析詳情\n\n`;
    md += `| 指標 | 數值 |\n|:---|---:|\n`;
    md += `| 目前殖利率 | ${div.currentYield}% |\n`;
    md += `| 殖利率位置 | ${div.yieldPosition} |\n`;
    md += `| 配息安全性 | ${gradeEmoji[div.payoutGrade]} ${div.payoutGrade} |\n`;
    md += `| 連續配息年數 | ${div.consecutiveYears} 年 |\n`;
    md += `| 股利貴族 | ${div.isAristocrat ? '✅ 是' : '❌ 否'} |\n`;
    if (div.fairValue) {
      md += `| 股利合理價 | ${div.fairValue} 元 |\n`;
    }
    md += '\n';
  }

  // ── CapEx 詳情 ──
  if (capex?.available !== false && capex) {
    md += `## CapEx 資本支出分析\n\n`;
    md += `| 指標 | 數值 |\n|:---|---:|\n`;
    md += `| 合理價 | ${capex.fairValue} 元 |\n`;
    md += `| CapEx CAGR | ${capex.capExCAGR}% |\n`;
    md += `| 近期 CapEx YoY | ${capex.recentCapExGrowth}% |\n`;
    md += `| CapEx 強度 | ${capex.capExIntensity}%（${capex.sectorConfidence}）|\n`;
    md += `| 傳導比率 | ${capex.transmissionRatio} |\n`;
    md += `| 營業槓桿 | ${capex.operatingLeverage}x |\n`;
    md += `| 前瞻營收成長 | ${capex.forwardRevenueGrowth}% |\n`;
    md += `| 前瞻盈餘成長 | ${capex.forwardEarningsGrowth}% |\n`;
    md += `| TTM EPS | ${capex.ttmEPS} 元 |\n`;
    md += `| 前瞻 EPS | ${capex.forwardEPS} 元 |\n`;
    md += `| 使用 PER | ${capex.avgPE}x（${capex.peSource}）|\n\n`;
  }

  // ── 建議理由 ──
  md += `## 綜合分析\n\n`;
  for (const reason of rec.reasons) {
    md += `- ${reason}\n`;
  }
  md += '\n';

  // ── 風險提示 ──
  md += `## 風險提示\n\n`;
  for (const risk of risks) {
    md += `- ⚠️ ${risk}\n`;
  }
  md += '\n';

  // ── PBR 詳情 ──
  if (pbr?.available !== false && pbr) {
    md += `## PBR 股價淨值比分析\n\n`;
    md += `| 指標 | 數值 |\n|:---|---:|\n`;
    md += `| 合理價 | ${pbr.fairValue} 元 |\n`;
    md += `| 每股淨值 (BVPS) | ${pbr.bvps} 元 |\n`;
    md += `| 當前 PBR | ${pbr.currentPBR}x |\n`;
    md += `| 歷史平均 PBR | ${pbr.avgPBR}x |\n`;
    md += `| PBR 標準差 | ${pbr.stdPBR}x |\n`;
    md += `| 估值位置 | ${pbr.position} |\n\n`;
  }

  md += `---\n*本報告由台股五模型估值系統自動產生，僅供參考，不構成投資建議。*\n`;

  return md;
}

// ── Terminal 彩色輸出（純 ANSI codes，不依賴外部套件） ──
export function toTerminal(result) {
  const { ticker, currentPrice, classification, weightedValuation: wv,
    recommendation: rec, risks, dcfSummary: dcf, perSummary: per,
    pbrSummary: pbr, capexSummary: capex, dividendSummary: div, momentumSummary: mom } = result;

  // ANSI 顏色
  const R = '\x1b[0m';    // Reset
  const B = '\x1b[1m';    // Bold
  const G = '\x1b[32m';   // Green
  const Y = '\x1b[33m';   // Yellow
  const RE = '\x1b[31m';  // Red
  const C = '\x1b[36m';   // Cyan
  const D = '\x1b[2m';    // Dim

  const actionColor = { BUY: G, HOLD: Y, SELL: RE };
  const sigColor = (s) => s === 'UNDERVALUED' ? G : s === 'OVERVALUED' ? RE : Y;
  const momColor = (s) => s === 'ACCELERATING' ? G : s === 'DECELERATING' ? RE : Y;
  const ac = actionColor[rec.action] || '';

  // 成長階段摘要
  const dcfGrowthPhases = dcf.growthPhases;
  let dcfPhaseStr = `${dcf.growthRate}%`;
  if (dcfGrowthPhases && dcfGrowthPhases.length > 0) {
    const phase1 = dcfGrowthPhases[0].growth;
    const phaseLast = dcfGrowthPhases[dcfGrowthPhases.length - 1].growth;
    dcfPhaseStr = `${phase1}% → ${phaseLast}%`;
  }
  if (dcf.momentumAdjustment) dcfPhaseStr += ` (動能${dcf.momentumAdjustment > 0 ? '+' : ''}${dcf.momentumAdjustment}pp)`;

  let out = '';
  out += `\n${B}${C}══════════════════════════════════════════════${R}\n`;
  out += `${B}${C}  ${ticker} 估值分析報告${R}\n`;
  out += `${B}${C}══════════════════════════════════════════════${R}\n\n`;

  // 總覽
  out += `${B}  目前股價${R}    ${B}${currentPrice}${R} 元\n`;
  out += `${B}  股票類型${R}    ${classification.type}\n`;
  out += `${B}  加權合理價${R}  ${B}${wv.fairValue}${R} 元  (${wv.method})\n`;
  out += `${B}  綜合建議${R}    ${ac}${B}${rec.action}${R} (${rec.confidence})  `;
  out += `潛在空間: ${rec.upside > 0 ? G : RE}${rec.upside > 0 ? '+' : ''}${rec.upside}%${R}\n\n`;

  // 營收動能（若有）
  if (mom?.available) {
    out += `${D}──────────────────────────────────────────────${R}\n`;
    out += `${B}  營收動能信號${R}\n`;
    out += `${D}──────────────────────────────────────────────${R}\n\n`;
    out += `  近 3 月 YoY: ${mom.shortTermGrowth > 0 ? G : RE}${mom.shortTermGrowth}%${R}  `;
    out += `近 12 月 YoY: ${mom.mediumTermGrowth > 0 ? G : RE}${mom.mediumTermGrowth}%${R}  `;
    out += `加速度: ${mom.acceleration > 0 ? G + '+' : RE}${mom.acceleration}pp${R}  `;
    out += `信號: ${momColor(mom.signal)}${mom.signal}${R}\n\n`;
  }

  // 五模型比較
  out += `${D}──────────────────────────────────────────────${R}\n`;
  out += `${B}  五模型估值比較${R}\n`;
  out += `${D}──────────────────────────────────────────────${R}\n\n`;

  // DCF
  out += `  ${C}DCF（多階段）${R}  [${pct(wv.dcfWeight)}]\n`;
  out += `    合理價: ${B}${dcf.fairValue}${R} 元  `;
  out += `信號: ${sigColor(dcf.signal)}${dcf.signal}${R}  `;
  out += `漲幅: ${dcf.upside > 0 ? G : RE}${dcf.upside}%${R}\n`;
  out += `    成長率: ${dcfPhaseStr}  WACC: ${dcf.wacc}%  安全邊際價: ${dcf.fairValueWithMargin} 元\n\n`;

  // PER
  if (per.available !== false) {
    out += `  ${C}PER（本益比）${R}  [${pct(wv.perWeight)}]\n`;
    out += `    合理價: ${B}${per.fairValue}${R} 元  `;
    out += `信號: ${sigColor(per.signal)}${per.signal}${R}  `;
    out += `漲幅: ${per.upside > 0 ? G : RE}${per.upside}%${R}\n`;
    out += `    當前 PE: ${per.currentPE}x  平均 PE: ${per.avgPE}x  位置: ${per.position}\n\n`;
  } else {
    out += `  ${C}PER（本益比）${R}  [${pct(wv.perWeight)}]\n`;
    out += `    ${D}${per.reason}${R}\n\n`;
  }

  // PBR
  if (pbr?.available !== false && pbr) {
    out += `  ${C}PBR（淨值比）${R}  [${pct(wv.pbrWeight)}]\n`;
    out += `    合理價: ${B}${pbr.fairValue}${R} 元  `;
    out += `信號: ${sigColor(pbr.signal)}${pbr.signal}${R}  `;
    out += `漲幅: ${pbr.upside > 0 ? G : RE}${pbr.upside}%${R}\n`;
    out += `    當前 PBR: ${pbr.currentPBR}x  平均 PBR: ${pbr.avgPBR}x  BVPS: ${pbr.bvps} 元  位置: ${pbr.position}\n\n`;
  } else {
    out += `  ${C}PBR（淨值比）${R}  [${pct(wv.pbrWeight)}]\n`;
    out += `    ${D}${pbr?.reason || 'PBR 不可用'}${R}\n\n`;
  }

  // CapEx
  if (capex?.available !== false && capex) {
    out += `  ${C}CapEx（資本支出）${R}  [${pct(wv.capexWeight)}]\n`;
    out += `    合理價: ${B}${capex.fairValue}${R} 元  `;
    out += `信號: ${sigColor(capex.signal)}${capex.signal}${R}  `;
    out += `漲幅: ${capex.upside > 0 ? G : RE}${capex.upside}%${R}\n`;
    out += `    CapEx CAGR: ${capex.capExCAGR}%  強度: ${capex.capExIntensity}% (${capex.sectorConfidence})  傳導比: ${capex.transmissionRatio}\n`;
    out += `    前瞻營收成長: ${capex.forwardRevenueGrowth > 0 ? G : RE}${capex.forwardRevenueGrowth}%${R}  `;
    out += `前瞻盈餘成長: ${capex.forwardEarningsGrowth > 0 ? G : RE}${capex.forwardEarningsGrowth}%${R}  `;
    out += `前瞻 EPS: ${capex.forwardEPS}\n\n`;
  } else {
    out += `  ${C}CapEx（資本支出）${R}  [${pct(wv.capexWeight)}]\n`;
    out += `    ${D}${capex?.reason || 'CapEx 不可用'}${R}\n\n`;
  }

  // 股利
  if (div.available !== false) {
    out += `  ${C}股利（存股）${R}  [${pct(wv.divWeight)}]\n`;
    out += `    合理價: ${B}${div.fairValue ?? 'N/A'}${R} 元  `;
    out += `信號: ${sigColor(div.signal)}${div.signal}${R}  `;
    out += `殖利率: ${div.currentYield}% (${div.yieldPosition})\n`;
    out += `    配息安全: ${div.payoutGrade}  `;
    out += `連續配息: ${div.consecutiveYears} 年  `;
    out += `股利貴族: ${div.isAristocrat ? `${G}是${R}` : '否'}\n\n`;
  } else {
    out += `  ${C}股利（存股）${R}  [${pct(wv.divWeight)}]\n`;
    out += `    ${D}${div.reason}${R}\n\n`;
  }

  // 建議理由
  out += `${D}──────────────────────────────────────────────${R}\n`;
  out += `${B}  綜合分析${R}\n`;
  out += `${D}──────────────────────────────────────────────${R}\n\n`;
  for (const reason of rec.reasons) {
    out += `  • ${reason}\n`;
  }

  // 風險提示
  out += `\n${D}──────────────────────────────────────────────${R}\n`;
  out += `${B}  ${Y}風險提示${R}\n`;
  out += `${D}──────────────────────────────────────────────${R}\n\n`;
  for (const risk of risks) {
    out += `  ${Y}⚠${R}  ${risk}\n`;
  }

  out += `\n${D}  分析時間: ${result.timestamp}${R}\n`;
  out += `${D}  * 本報告由台股五模型估值系統自動產生，僅供參考，不構成投資建議。${R}\n\n`;

  return out;
}
