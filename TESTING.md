# 測試規範

## QA Benchmark：0050 成份股

本專案使用元大台灣50 (0050) ETF 的成份股作為 QA 測試基準。

### 為什麼選擇 0050？

- 涵蓋台股市值前 50 大公司，覆蓋所有主要產業
- 成份股公開透明，每季調整一次
- 資料品質高（大型股的財報、股價數據完整）
- 覆蓋系統所有分類路徑：成長股、金融業、週期性、存股、價值成長股、混合型

### 測試命令

| 命令 | 說明 |
|:---|:---|
| `npm run test:qa` | 完整 QA（50 檔，約 4 分鐘） |
| `npm run test:qa -- --batch-size 10` | 快速測試（前 10 檔） |
| `npm run test:qa -- --sector 金融` | 只測金融股 |
| `npm run test:batch -- 2330 2886 2002` | 自訂 batch 測試 |

### 通過標準

- Level 1 結構完整性：100% 通過
- Level 2 模型可用性：≥90% 有 3+ 模型
- Level 3 數值合理性：100% 通過
- Level 4 跨模型一致性：≥80%（warning 不影響通過）
- 0 個 runtime crash

### 驗證層級

#### Level 1 — 結構完整性（必須全部通過）

- `result.ticker` 存在且符合輸入
- `result.currentPrice` > 0
- `result.classification.type` 是已知類型之一
- `result.weightedValuation.fairValue` 是有限數字（非 NaN/Infinity）
- `result.recommendation.action` 是 BUY/HOLD/SELL 之一
- `result.timestamp` 存在

#### Level 2 — 模型可用性（統計型）

- 至少 2 個模型回傳 available: true（單檔）
- 全部 50 檔中，至少 45 檔有 ≥3 個模型可用
- DCF 模型在非金融股中應 available

#### Level 3 — 數值合理性

- fairValue > 0
- upside 在 -90% ~ +500% 範圍內
- PER 值 0 < currentPE < 200
- PBR 值 0 < currentPBR < 50
- 權重加總在 0.99 ~ 1.01 之間
- 殖利率 0% ~ 30%

#### Level 4 — 跨模型一致性（warning-only）

- 若 3+ 模型判 UNDERVALUED，recommendation 應為 BUY
- 各模型 fairValue 之間的變異係數 < 2.0

### 成份股更新

0050 每季調整一次（3/6/9/12 月）。調整時更新 `src/qa-test.js` 中的
`TAIWAN_50` 常數。更新時同步更新 `src/config.js` 的 `TICKER_SECTOR`。

### 何時執行

- 修改任何模型邏輯後
- 修改 synthesizer 權重/分類後
- 修改 API 層後
- Release 前
