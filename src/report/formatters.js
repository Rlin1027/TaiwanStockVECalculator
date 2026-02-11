// ── 報告格式化器 ──
// 三種輸出格式，都從同一個 SynthesisResult 生成

// ── JSON 格式（供後續平台整合） ──
export function toJSON(result) {
  return JSON.stringify(result, null, 2);
}

// ── Markdown 格式（含表格） ──
export function toMarkdown(result) {
  const { ticker, currentPrice, classification, weightedValuation: wv,
    recommendation: rec, risks, dcfSummary: dcf, dividendSummary: div } = result;

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

  // ── 雙模型比較 ──
  md += `## 雙模型估值比較\n\n`;
  md += `| 模型 | 合理價 | 信號 | 關鍵指標 |\n`;
  md += `|:---|---:|:---|:---|\n`;
  md += `| DCF（成長） | ${dcf.fairValue} 元 | ${signalEmoji[dcf.signal === 'UNDERVALUED' ? 'BUY' : dcf.signal === 'OVERVALUED' ? 'SELL' : 'HOLD'] || '⚪'} ${dcf.signal} | 成長率 ${dcf.growthRate}%, WACC ${dcf.wacc}% |\n`;

  if (div.available !== false) {
    md += `| 股利（存股） | ${div.fairValue ?? 'N/A'} 元 | ${signalEmoji[div.signal === 'UNDERVALUED' ? 'BUY' : div.signal === 'OVERVALUED' ? 'SELL' : 'HOLD'] || '⚪'} ${div.signal} | 殖利率 ${div.currentYield}%, ${div.yieldPosition} |\n`;
  } else {
    md += `| 股利（存股） | N/A | ⚪ | ${div.reason} |\n`;
  }
  md += '\n';

  // ── DCF 詳情 ──
  md += `## DCF 模型詳情\n\n`;
  md += `| 指標 | 數值 |\n|:---|---:|\n`;
  md += `| 合理價 | ${dcf.fairValue} 元 |\n`;
  md += `| 安全邊際價 | ${dcf.fairValueWithMargin} 元 |\n`;
  md += `| 營收 CAGR | ${dcf.growthRate}% |\n`;
  md += `| WACC | ${dcf.wacc}% |\n`;
  md += `| 潛在漲幅 | ${dcf.upside}% |\n\n`;

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

  md += `---\n*本報告由台股雙軌估值系統自動產生，僅供參考，不構成投資建議。*\n`;

  return md;
}

// ── Terminal 彩色輸出（純 ANSI codes，不依賴外部套件） ──
export function toTerminal(result) {
  const { ticker, currentPrice, classification, weightedValuation: wv,
    recommendation: rec, risks, dcfSummary: dcf, dividendSummary: div } = result;

  // ANSI 顏色
  const R = '\x1b[0m';    // Reset
  const B = '\x1b[1m';    // Bold
  const G = '\x1b[32m';   // Green
  const Y = '\x1b[33m';   // Yellow
  const RE = '\x1b[31m';  // Red
  const C = '\x1b[36m';   // Cyan
  const D = '\x1b[2m';    // Dim

  const actionColor = { BUY: G, HOLD: Y, SELL: RE };
  const ac = actionColor[rec.action] || '';

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

  // 雙模型比較
  out += `${D}──────────────────────────────────────────────${R}\n`;
  out += `${B}  雙模型估值比較${R}\n`;
  out += `${D}──────────────────────────────────────────────${R}\n\n`;

  const dcfColor = dcf.signal === 'UNDERVALUED' ? G : dcf.signal === 'OVERVALUED' ? RE : Y;
  out += `  ${C}DCF（成長）${R}\n`;
  out += `    合理價: ${B}${dcf.fairValue}${R} 元  `;
  out += `信號: ${dcfColor}${dcf.signal}${R}  `;
  out += `漲幅: ${dcf.upside > 0 ? G : RE}${dcf.upside}%${R}\n`;
  out += `    成長率: ${dcf.growthRate}%  WACC: ${dcf.wacc}%  安全邊際價: ${dcf.fairValueWithMargin} 元\n\n`;

  if (div.available !== false) {
    const divColor = div.signal === 'UNDERVALUED' ? G : div.signal === 'OVERVALUED' ? RE : Y;
    out += `  ${C}股利（存股）${R}\n`;
    out += `    合理價: ${B}${div.fairValue ?? 'N/A'}${R} 元  `;
    out += `信號: ${divColor}${div.signal}${R}  `;
    out += `殖利率: ${div.currentYield}% (${div.yieldPosition})\n`;
    out += `    配息安全: ${div.payoutGrade}  `;
    out += `連續配息: ${div.consecutiveYears} 年  `;
    out += `股利貴族: ${div.isAristocrat ? `${G}是${R}` : '否'}\n\n`;
  } else {
    out += `  ${C}股利（存股）${R}\n`;
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
  out += `${D}  * 本報告僅供參考，不構成投資建議。${R}\n\n`;

  return out;
}
