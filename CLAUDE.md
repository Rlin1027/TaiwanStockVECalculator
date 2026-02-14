# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

台股七模型估值分析系統（TaiwanStockVECalculator）— 基於 FinMind API 的多維度量化估值工具。系統對單一台股代號並行抓取 8 種財務數據集，透過 7 個獨立估值模型計算合理價，再以智慧權重加權合成最終建議。

## Commands

```bash
# CLI 分析單股
node src/index.js 2330
node src/index.js 2330 --format json
node src/index.js 2330 --format md --output output/2330.md

# 啟動 HTTP API 微服務 (port 3000)
node src/server.js

# QA 測試（0050 成份股 benchmark）
npm run test:qa                          # 完整 50 檔
npm run test:qa -- --batch-size 5        # 前 5 檔快速測試
npm run test:qa -- --sector 金融         # 只測金融股

# 批次分析指定股票
npm run test:batch -- 2330 2886 2002

# Docker
docker compose up --build
```

## Architecture

**Runtime**: Node.js 18+ / ESM (`"type": "module"`)。僅四個依賴：express、better-sqlite3、dotenv、cors。

### Data Flow

```
FinMind API (8 datasets in parallel)
  → fetchAllData() [src/api/finmind.js]
    → 7 Model Calculators [src/models/*.js]
      → synthesize() [src/report/synthesizer.js]  ← 分類 + 加權 + 建議
        → formatters [src/report/formatters.js]   ← terminal / md / json
```

### Core Layers

- **`src/service.js`** — 核心分析服務，`analyzeStock()` 和 `analyzeBatch()` 供 CLI 與 API 共用。所有七模型在此執行並有獨立 try/catch fallback。
- **`src/api/finmind.js`** — FinMind API 封裝，`fetchAllData()` 用 `Promise.all` 並行抓取 8 種數據集（股價、財報、現金流、股利、PER/PBR、月營收、資產負債表、公司資訊）。每個 request 有 30 秒 AbortController timeout。
- **`src/report/synthesizer.js`** — 七模型綜合引擎。`classifyStock()` 依產業和財務特徵分為 7 類（金融業/成長股/存股/價值成長股/週期性/虧損成長股/混合型），每類有預設權重。`calculateWeightedValuation()` 依模型可用性和信心度動態調整權重後正規化。
- **`src/config.js`** — 集中設定：產業 WACC 對照表、TICKER_SECTOR 手動分類、INDUSTRY_SECTOR_MAP 自動分類、DCF/股利參數。
- **`src/db.js`** — SQLite 持久化（better-sqlite3，WAL mode）。5 個 tables：analyses、portfolio、accuracy_checks、portfolio_holdings、alerts。DB 路徑由 `DB_PATH` env 控制，預設 `./data/valuation.db`。

### Seven Models (`src/models/`)

| Model | File | Key Function | Dependencies |
|-------|------|-------------|-------------|
| DCF | `dcf.js` | `calculateDCF()` | financials, cashFlows, momentum, stockInfo |
| Dividend | `dividend.js` | `analyzeDividend()` | dividends, priceHistory, financials |
| PER | `per.js` | `analyzePER()` | per data, financials |
| PBR | `pbr.js` | `analyzePBR()` | per data, balanceSheet |
| CapEx | `capex.js` | `analyzeCapEx()` | financials, cashFlows, **PER result** |
| EV/EBITDA | `ev-ebitda.js` | `analyzeEVEBITDA()` | financials, cashFlows, balanceSheet |
| PSR | `psr.js` | `analyzePSR()` | financials |

注意：CapEx 模型依賴 PER 模型的結果（`perResult`），因此 PER 必須先計算。

### LLM Integration (`src/llm/`)

雙軌分類系統：確定性分類（synthesizer 規則）+ LLM 智慧分類（透過 n8n 呼叫 gpt-5-mini）。

- **`guardrails.js`** — 驗證 LLM 輸出：type 必須為 7 種有效分類之一、每個 weight ∈ [0, 0.50]、不可用模型 weight 必須 = 0、加總 ≈ 1.0（±0.02 容差）。
- **`resynthesize.js`** — 用 LLM 權重重新計算加權合理價，保留原始確定性結果於 `deterministicClassification` / `deterministicRecommendation` / `deterministicWeightedValuation` 欄位。

### Phase 3 Modules

- **`src/backtest/`** — 漸進式回測：30d 新建 → 90d/180d 回填。`engine.js` 取未回測分析並比對實際股價，`metrics.js` 計算 hit rate、MAE、模型排名。
- **`src/portfolio/`** — `analytics.js` 計算持倉績效、產業配置、風險指標。`alerts.js` 支援 4 種觸發條件（price_above/below、upside_above、classification_change）。

### n8n Workflows (`n8n_workflows/`)

五個 JSON workflow 檔供 n8n 匯入，已針對 n8n v2.7.4 (Zeabur Self-Hosted) 優化：

| Workflow | 觸發方式 | 說明 |
|----------|---------|------|
| `on-demand-analysis.json` | POST `/webhook/analyze` | 即時七模型 + LLM 分類 |
| `portfolio-management.json` | POST `/webhook/portfolio` | 追蹤清單 CRUD (add/remove/list) |
| `phase3-management.json` | POST `/webhook/phase3` | 持倉/回測/警示 11 種操作 |
| `weekly-valuation.json` | Cron 每週一 02:00 | 批次分析 + LLM + Telegram/Email 報告 |
| `daily-alerts.json` | Cron 每日 18:00 | 警示檢查 + Telegram 推播 |

**n8n 相容性注意**：Switch/If/Respond to Webhook 節點在 n8n v2.7.4 匯入會失敗，所有路由邏輯統一用 Code 節點實現。GET 請求不可帶 `sendBody: true`，需用動態表達式 `={{ $json.apiMethod === 'POST' }}`。設定指南在 `docs/n8n-setup-guide.md`。

## Key Conventions

- 進度訊息用 `stderr`、報告輸出用 `stdout`（支援 pipe）
- 台股代號格式驗證：`/^\d{4,6}$/`
- FinMind 財報數據可能以千元為單位，models 層自動偵測校正
- 批次分析有速率控制（`BATCH_DELAY_MS`，預設 3000ms）
- API 可選 Bearer token 或 `x-api-key` header 驗證（`API_KEY` env），health check 跳過驗證
- 所有新功能（Phase 2-3）透過新模組 + 新端點實現，不修改核心計算邏輯（零侵入式）

## QA Testing

QA benchmark 使用 0050 ETF 50 檔成份股，四層驗證：
- L1 結構完整性（100% 必須通過）
- L2 模型可用性（≥90% 有 3+ 模型）
- L3 數值合理性（100% 必須通過）
- L4 跨模型一致性（≥80%，warning 不影響通過）

修改模型邏輯、synthesizer 權重/分類、或 API 層後應執行 QA。0050 成份股每季調整（3/6/9/12 月），需同步更新 `src/qa-test.js` 的 `TAIWAN_50` 和 `src/config.js` 的 `TICKER_SECTOR`。

## Environment Variables

參見 `.env.example`。關鍵變數：
- `FINMIND_API_TOKEN` — FinMind API token（必須，免費帳號 600 calls/hour）
- `DB_PATH` — SQLite 路徑（預設 `./data/valuation.db`）
- `BATCH_DELAY_MS` / `BATCH_SIZE` — 批次分析速率控制
