// ── 警示系統 ──
// 檢查觸發條件（價格/估值/分類變化）

import { getLatestTwo } from '../db.js';

/**
 * 檢查所有警示是否被觸發
 * @param {Array} activeAlerts - 啟用中的警示紀錄
 * @param {Object} latestAnalyses - { ticker: analysisResult }
 * @param {Object} currentPrices - { ticker: number }
 */
export function checkAlerts(activeAlerts, latestAnalyses, currentPrices) {
  const triggered = [];

  for (const alert of activeAlerts) {
    const analysis = latestAnalyses[alert.ticker];
    const price = currentPrices[alert.ticker];
    const result = analysis?.result;
    const name = result?.stockName ? ' ' + result.stockName : '';

    switch (alert.alert_type) {
      case 'price_above':
        if (price != null && price >= alert.threshold) {
          triggered.push({
            alert,
            price,
            message: `${alert.ticker}${name} 股價 ${price} 已突破 ${alert.threshold}`,
          });
        }
        break;

      case 'price_below':
        if (price != null && price <= alert.threshold) {
          triggered.push({
            alert,
            price,
            message: `${alert.ticker}${name} 股價 ${price} 已跌破 ${alert.threshold}`,
          });
        }
        break;

      case 'upside_above':
        if (result?.recommendation?.upside >= alert.threshold) {
          triggered.push({
            alert,
            upside: result.recommendation.upside,
            message: `${alert.ticker}${name} 潛在上漲空間 ${result.recommendation.upside.toFixed(1)}% 超過閾值 ${alert.threshold}%`,
          });
        }
        break;

      case 'classification_change': {
        const rows = getLatestTwo(alert.ticker);
        if (rows.length >= 2) {
          const currentType = rows[0].result?.classification?.type || rows[0].result?.llmClassification?.type;
          const previousType = rows[1].result?.classification?.type || rows[1].result?.llmClassification?.type;
          if (currentType && previousType && currentType !== previousType) {
            triggered.push({
              alert,
              previousType,
              currentType,
              message: `${alert.ticker}${name} 分類從「${previousType}」變為「${currentType}」`,
            });
          }
        }
        break;
      }
    }
  }

  return triggered;
}
