# n8n 工作流匯入與設定指南

本文件說明如何將估值系統的 5 個 n8n 工作流匯入並設定完成。

## 前置條件

| 項目 | 說明 |
|------|------|
| Node.js 18+ | 估值微服務執行環境 |
| n8n v2.7+ | 工作流引擎（Zeabur Self-Hosted 或本地安裝） |
| FinMind API Token | [免費申請](https://finmindtrade.com/) |
| OpenAI API Key | gpt-5-mini LLM 分類用 |

## 架構總覽

```
n8n 工作流引擎
  ├── Webhook 觸發（即時分析 / 追蹤清單 / Phase 3 管理）
  ├── 排程觸發（每週估值報告 / 每日警示檢查）
  ├── Code 路由邏輯（替代 Switch/If 節點）
  ├── 呼叫 OpenAI gpt-5-mini（LLM 智慧分類 + 權重）
  ├── Guardrails 驗證（格式 + 業務規則）
  └── 發送通知（Telegram / Email）
          ↕
估值微服務 (Express + SQLite)
  ├── POST /api/analyze/:ticker       → 確定性七模型分析
  ├── POST /api/analyze/batch         → 批次分析
  ├── GET  /api/compare/:ticker       → 歷史差異比較
  ├── POST /api/resynthesize/:ticker  → LLM 權重重新合成
  ├── POST /api/resynthesize/batch    → 批次重新合成
  ├── GET/POST/DELETE /api/portfolio  → 追蹤清單管理
  ├── GET/PUT/DELETE /api/portfolio/holdings → 持倉管理
  ├── GET /api/portfolio/analytics    → 投組績效分析
  ├── GET/POST/DELETE /api/alerts     → 警示 CRUD
  ├── POST /api/alerts/check          → 觸發警示檢查
  ├── POST /api/backtest/run          → 執行回測
  ├── GET /api/backtest/summary       → 回測摘要
  └── GET /api/backtest/:ticker       → 個股回測紀錄
```

## Step 1: 部署估值微服務

### 方法 A: Zeabur 雲端部署（推薦）

1. Fork 或 push 本專案到 GitHub
2. 在 [Zeabur](https://zeabur.com/) 建立新 Service → 選擇 GitHub Repo
3. 設定環境變數：

| 變數 | 說明 | 範例 |
|------|------|------|
| `FINMIND_API_TOKEN` | FinMind API Token | `eyJ...` |
| `DB_PATH` | SQLite 資料庫路徑 | `/data/valuation.db` |

4. 設定 Volume（硬碟）：
   - **硬碟 ID**: `data`
   - **掛載目錄**: `/data`

5. 驗證部署成功：

```bash
curl https://your-api-url.zeabur.app/api/health
# → {"status":"ok","uptime":...,"version":"1.0.0"}
```

### 方法 B: 本地執行

```bash
cd /path/to/n8nFinMind
npm install
cp .env.example .env
# 編輯 .env，填入 FINMIND_API_TOKEN
node src/server.js
# → Valuation API running on port 3000
```

## Step 2: 設定 n8n 環境變數

n8n 工作流需要兩個環境變數，透過 `$env` 存取：

| 變數 | 說明 | 範例 |
|------|------|------|
| `VALUATION_API_URL` | 估值微服務位址 | `https://your-api.zeabur.app` 或 `http://localhost:3000` |
| `OPENAI_API_KEY` | OpenAI API Key | `sk-...` |

### Zeabur n8n（推薦）

在 n8n 服務的環境變數中加入上述兩個變數，並確保設定：

```
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
```

> **重要**：必須設定 `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`，否則 Code 節點和 HTTP Request 表達式無法透過 `$env` 存取環境變數。

### Docker Compose

```yaml
services:
  n8n:
    environment:
      - VALUATION_API_URL=http://host.docker.internal:3000
      - OPENAI_API_KEY=sk-your-key-here
      - N8N_BLOCK_ENV_ACCESS_IN_NODE=false
```

> `host.docker.internal` 讓 Docker 容器存取主機的 localhost:3000。
> Linux 需額外加 `extra_hosts: ["host.docker.internal:host-gateway"]`。

### 本地 n8n

```bash
export VALUATION_API_URL=http://localhost:3000
export OPENAI_API_KEY=sk-your-key-here
export N8N_BLOCK_ENV_ACCESS_IN_NODE=false
n8n start
```

> **注意**：n8n Settings → Variables（`$vars`）在部分版本可能無法正常運作，建議統一使用系統環境變數（`$env`）。

## Step 3: 匯入工作流

n8n UI 左側 → **Workflows** → **Add Workflow** → 右上角 **...** → **Import from File**。

### 3.1 即時估值分析 (`on-demand-analysis.json`)

```
Webhook /analyze → 驗證 Ticker → 呼叫估值 API → GET Compare
  → 準備 LLM Prompt → LLM 分類 → Guardrails 驗證 → Apply LLM Weights
```

8 個節點，Activate 後測試：

```bash
curl -s -X POST https://your-n8n-url/webhook/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker": "2330"}' | python3 -m json.tool
```

預期回應：

```json
{
  "source": "llm-enhanced",
  "ticker": "2330",
  "llmClassification": {
    "type": "成長股",
    "confidence": "HIGH",
    "narrative": "台積電以先進製程主導..."
  },
  "weightedValuation": { "fairValue": 1200 },
  "recommendation": { "action": "BUY", "upside": 14.3 }
}
```

### 3.2 追蹤清單管理 (`portfolio-management.json`)

```
Webhook /portfolio → Code 路由邏輯 → 動態 HTTP Request
```

3 個節點，支援 3 種操作：

```bash
# 新增追蹤
curl -s -X POST https://your-n8n-url/webhook/portfolio \
  -H "Content-Type: application/json" \
  -d '{"action": "add", "tickers": ["2330", "2884"]}'

# 查看清單
curl -s -X POST https://your-n8n-url/webhook/portfolio \
  -H "Content-Type: application/json" \
  -d '{"action": "list"}'

# 移除追蹤
curl -s -X POST https://your-n8n-url/webhook/portfolio \
  -H "Content-Type: application/json" \
  -d '{"action": "remove", "tickers": ["2884"]}'
```

### 3.3 Phase 3 管理 (`phase3-management.json`)

```
Webhook /phase3 → Code 路由邏輯 → 動態 HTTP Request (method/url/sendBody)
```

3 個節點，支援 11 種操作：

| 類別 | Action | 說明 |
|------|--------|------|
| 持倉 | `holdings_add` | 新增/更新持倉（需 ticker, shares, costBasis） |
| 持倉 | `holdings_remove` | 移除持倉（需 ticker） |
| 持倉 | `holdings_list` | 列出所有持倉 |
| 持倉 | `analytics` | 投組績效分析 |
| 警示 | `alert_add` | 建立警示（需 ticker, alertType, threshold） |
| 警示 | `alert_list` | 列出所有警示 |
| 警示 | `alert_check` | 觸發一次警示檢查 |
| 警示 | `alert_remove` | 停用警示（需 alertId） |
| 回測 | `backtest_run` | 執行回測掃描 |
| 回測 | `backtest_summary` | 回測準確度摘要 |
| 回測 | `backtest_ticker` | 個股回測紀錄（需 ticker） |

```bash
# 新增持倉
curl -s -X POST https://your-n8n-url/webhook/phase3 \
  -H "Content-Type: application/json" \
  -d '{"action": "holdings_add", "ticker": "2330", "shares": 1000, "costBasis": 580}'

# 建立警示
curl -s -X POST https://your-n8n-url/webhook/phase3 \
  -H "Content-Type: application/json" \
  -d '{"action": "alert_add", "ticker": "2330", "alertType": "price_below", "threshold": 550}'

# 回測摘要
curl -s -X POST https://your-n8n-url/webhook/phase3 \
  -H "Content-Type: application/json" \
  -d '{"action": "backtest_summary"}'
```

### 3.4 每週估值報告 (`weekly-valuation.json`)

```
Cron 每週一 02:00 → 取得追蹤清單 → 準備批次請求 → 批次估值分析 (5min timeout)
  → 合併結果與統計 → gpt-5-mini 分類 → Guardrails 驗證 → Apply LLM Weights
  → 取得回測摘要 → 取得投組績效
  → Telegram 摘要 + Email HTML 報告
```

13 個節點（線性流程，無迴圈）。**先不要 Activate**，用 n8n UI 的 **Test Workflow** 手動測試。

> **注意**：批次分析 15 檔約需 2-3 分鐘（API 內建 3 秒間隔），請耐心等待。

逐節點驗證：

| 節點 | 驗證要點 |
|------|---------|
| 取得追蹤清單 | 回傳 `{"tickers": [{"ticker":"2330",...}, ...]}` |
| 準備批次請求 | 提取純 ticker 字串陣列 `["2330", "2317", ...]` |
| 批次估值分析 | 回傳 `{results: [...], summary: {total, success, failed}}` |
| 合併結果與統計 | allResults 陣列 + buyCount/sellCount/holdCount 統計 |
| 準備 LLM Prompt | openaiBody 包含 system + user prompt |
| LLM 分類 | OpenAI 回傳 JSON，每股有 type + weights |
| Guardrails 驗證 | stocks 物件通過格式驗證 |
| Apply LLM Weights | resynthesize 回傳結果（stocks 為空時自動 skip） |
| Telegram / Email | 格式化訊息包含 AI 分類、估值與敘述 |

### 3.5 每日警示推播 (`daily-alerts.json`)

```
Cron 每日 18:00 → POST /api/alerts/check → Code 格式化 + 過濾 → Telegram 推播
```

4 個節點。需先設定 Telegram credentials（見 Step 4）。

> Code 節點同時處理格式化和過濾：若無觸發的警示，回傳空陣列 `[]` 停止流程，不發送 Telegram。

## Step 4: 設定通知（可選）

### Telegram

1. 與 [@BotFather](https://t.me/BotFather) 對話，`/newbot` 取得 Bot Token
2. n8n → Credentials → 新增 **Telegram API** → 填入 Bot Token
3. 取得 Chat ID：將 Bot 加入群組，發送訊息後呼叫 `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. 在每日警示和每週報告的 Telegram 節點中填入 Chat ID

### Email (Gmail)

1. n8n → Credentials → 新增 **Gmail OAuth2** 或 **SMTP**
2. Gmail OAuth2 需在 Google Cloud Console 設定 OAuth 2.0 Client
3. SMTP 可用 Google App Password（需開啟兩步驟驗證）
4. 在每週報告的 Email 節點中設定收件者

> 不設定通知不影響分析流程，只是最後的發送節點會失敗。

## n8n v2.7.4 相容性注意事項

本專案的工作流已針對 n8n v2.7.4 (Self-Hosted) 優化。以下是已知限制與解決方案：

| 問題 | 原因 | 解法 |
|------|------|------|
| Switch 節點匯入失敗 | v3.2 格式不相容 | 改用 Code 節點做路由 |
| If 節點匯入失敗 | v2 格式不相容 | 將條件邏輯合併進 Code 節點 |
| Respond to Webhook 匯入失敗 | 節點格式不相容 | 改用 `responseMode: "lastNode"` |
| GET + sendBody: true 執行錯誤 | HTTP 規範限制 | `sendBody` 用動態表達式控制 |
| gpt-5-mini temperature 錯誤 | 不支援自訂 temperature | 移除 temperature 參數 |
| `$vars` 回傳 undefined | 部分版本功能異常 | 改用 `$env` + 設定 `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` |

## 常見問題

| 問題 | 解法 |
|------|------|
| `ECONNREFUSED` 連不到估值 API | 確認 API 運行中；Docker 環境用 `host.docker.internal`；Zeabur 確認內部網路 |
| OpenAI 401 Unauthorized | 確認 `OPENAI_API_KEY` 環境變數正確且有額度 |
| LLM 分類回退至確定性結果 | 正常行為 — 表示 LLM 輸出未通過 guardrails 驗證 |
| Webhook 404 Not Found | 確認工作流已 **Activate**，webhook path 正確 |
| 批次分析超時 | HTTP Request 節點的 Timeout 已設為 120 秒 |
| FinMind API 429 | 超過免費額度限制（600 calls/hour），等待後重試 |
| `Error in workflow` (GET 請求) | 確認 `sendBody` 使用動態表達式，GET 時應為 false |
| Apply LLM Weights 400 錯誤 | stocks 為空時觸發，已用 `skipResynth` flag 處理 |

## Guardrails 雙層防護

| 層級 | 位置 | 驗證內容 |
|------|------|---------|
| 第一層 | n8n Code 節點 | JSON 解析、基本格式、類型和權重存在性 |
| 第二層 | 微服務 `/api/resynthesize` | 分類類型合法性、權重 [0, 0.50]、不可用模型 weight=0、加總 ≈ 1.0 |

任一層失敗都會安全回退至確定性結果，不會中斷流程。
