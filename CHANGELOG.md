# Changelog

台股七模型估值分析系統開發日誌。

## [4.4.1] - 2026-02-14

### Fixed
- **每週估值工作流資料流中斷與容錯修復**
  - 修正「準備 LLM Prompt」從 `$input.first().json` 改為 `$('合併結果與統計').first().json`，解決插入回測/回饋 HTTP 節點後資料來源錯誤
  - 6 個增強型 HTTP 節點加入 `onError: "continueRegularOutput"` 容錯：觸發回測掃描、取得回饋權重、LLM 分類、Apply LLM Weights、取得回測摘要、取得投組績效
  - 3 個 Code 節點（LLM Prompt / Telegram / Email）改用防禦性 `try/catch` 取值回饋權重，避免上游 HTTP 錯誤物件導致 crash
  - 分層容錯策略：核心資料節點 fail-stop，增強節點 onError 繼續，確保通知必達

## [4.4.0] - 2026-02-14

### Added
- **回測回饋調權系統** (`src/feedback/`)
  - `adaptive-weights.js`：依回測 MAE 計算各分類自適應權重，多時間維度加權（30d 25% + 90d 50% + 180d 25%）
  - `cache.js`：記憶體快取管理，24h 自動過期 + lazy refresh
  - `resynthesize-feedback.js`：混合權重重新計算合理價（預設 30% 回饋 + 70% 預設）
  - API 端點：`GET /api/feedback/weights`、`GET /api/feedback/weights/:type`、`POST /api/feedback/refresh`
- **每週工作流整合回饋調權**
  - 新增「觸發回測掃描」和「取得回饋權重」節點
  - LLM system prompt 包含回饋權重表格供 AI 參考
  - Telegram/Email 報告顯示回饋狀態與信心度指標

### Changed
- 每週估值工作流改為分批處理（10 檔/批 + 7 分鐘間隔），避免 FinMind API 限流

## [4.3.0] - 2026-02-14

### Added
- **通知新增股票名稱**：從 `stockInfo` 轉發 `stock_name` 至 CLI、API、Telegram、Email 所有輸出管道

### Fixed
- Telegram Bot `N8N_WEBHOOK_URL` undefined 問題，加入 fallback 機制
- 增強 LLM 分類回覆格式

## [4.2.0] - 2026-02-14

### Added
- **Telegram Bot 工作流** (`telegram-bot.json`)：對話式操作所有估值功能，支援 20+ 指令
  - 分析：`/analyze`、`/a`
  - 追蹤：`/add`、`/remove`、`/list`
  - 持倉：`/hold`、`/sell`、`/holdings`、`/analytics`
  - 警示：`/alert`、`/alerts`、`/check`、`/alert_off`
  - 回測：`/backtest`、`/bt`
  - 說明：`/help`

### Fixed
- 每週估值分析移除有問題的 splitInBatches 迴圈，修正路由順序
- 每週報告資料顯示 N/A：解包 resynthesize 回應 + 修正 recommendation 過濾邏輯

## [4.1.0] - 2026-02-14

### Changed
- **n8n 工作流全面適配 n8n v2.7.4 (Zeabur Self-Hosted)**
  - Switch / If / Respond to Webhook 節點統一改用 Code 節點
  - GET 請求 `sendBody` 改用動態表達式控制
  - 移除 gpt-5-mini 不支援的 temperature 參數
  - 環境變數統一使用 `$env` 存取

## [4.0.0] - 2026-02-12

### Added
- **Phase 3 功能模組**
  - 回測準確度驗證 (`src/backtest/`)：漸進式回測（30d/90d/180d），計算 hit rate、MAE、模型排名
  - 智慧投組管理 (`src/portfolio/analytics.js`)：持倉追蹤、產業配置、風險指標、估值分組
  - 警示系統 (`src/portfolio/alerts.js`)：4 種觸發條件（price_above/below、upside_above、classification_change）
  - Phase 3 管理工作流 (`phase3-management.json`)：Webhook 驅動，11 種操作
  - 每日警示推播工作流 (`daily-alerts.json`)：Cron 每日 18:00 + Telegram 通知

### Added (Phase 2)
- **LLM 智慧分類** (`src/llm/`)
  - `guardrails.js`：驗證 LLM 輸出（分類類型、權重範圍、加總）
  - `resynthesize.js`：LLM 權重重新合成引擎
  - 即時估值工作流 (`on-demand-analysis.json`)：Webhook + LLM 分類 + Guardrails
  - 追蹤清單管理工作流 (`portfolio-management.json`)
  - 每週估值報告工作流 (`weekly-valuation.json`)：Cron 排程 + LLM + Telegram/Email

### Added (API)
- **HTTP 微服務** (`src/server.js`)：Express + SQLite 持久化
  - 單股/批次分析、歷史比較、LLM 重新合成
  - 追蹤清單 CRUD、持倉管理、投組分析
  - 回測驗證、警示 CRUD
- **Docker 容器化**：Dockerfile + docker-compose.yml

## [3.1.0] - 2026-02-12

### Changed
- 升級為五模型估值系統：新增 EV/EBITDA + PSR 模型
- Code review 修復：改善錯誤處理與邊界條件

## [1.0.0] - 2026-02-12

### Added
- 台股雙軌估值分析系統初始版本
- DCF 折現現金流模型
- 股利殖利率 + Gordon Growth Model
- PER 本益比河流圖
- PBR 股價淨值比
- CapEx 資本支出前瞻估值
- CLI 介面：Terminal 彩色輸出 / Markdown / JSON
- FinMind API 整合：並行抓取 8 種數據集
- 智慧加權引擎：7 類股票分類 + 信心度動態調整
- QA 測試框架：0050 ETF 50 檔成份股 benchmark
