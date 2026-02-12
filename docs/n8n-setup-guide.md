# n8n 工作流匯入與設定指南

本文件說明如何將估值系統的 n8n 工作流匯入並設定完成，包括每週自動排程和按需查詢兩個工作流。

## 前置條件

| 項目 | 說明 |
|------|------|
| Node.js 18+ | 估值微服務執行環境 |
| n8n | 工作流引擎（Docker 或本地安裝皆可） |
| FinMind API Token | [免費申請](https://finmindtrade.com/) |
| OpenAI API Key | GPT-4o LLM 分類用 |

## 架構總覽

```
n8n 工作流
  ├── 呼叫估值 API（確定性七模型）
  ├── 呼叫 OpenAI GPT-4o（LLM 智慧分類 + 權重）
  ├── Guardrails 驗證（格式 + 業務規則）
  ├── 呼叫 resynthesize API（LLM 權重重新加權）
  └── 發送通知（Telegram / Email）
          ↕
估值微服務 (Express + SQLite)
  ├── POST /api/analyze/:ticker     → 確定性七模型分析
  ├── POST /api/analyze/batch       → 批次分析
  ├── GET  /api/compare/:ticker     → 歷史差異比較
  ├── POST /api/resynthesize/:ticker → LLM 權重重新合成
  ├── POST /api/resynthesize/batch  → 批次重新合成
  ├── GET  /api/history/:ticker     → 歷史紀錄
  └── GET/POST/DELETE /api/portfolio → 追蹤清單管理
```

## Step 1: 啟動估值微服務

```bash
cd /path/to/n8nFinMind

# 安裝依賴
npm install

# 設定環境變數
cp .env.example .env
# 編輯 .env，填入 FINMIND_API_TOKEN

# 啟動
node src/server.js
# → Valuation API running on port 3000
```

驗證服務正常：

```bash
curl http://localhost:3000/api/health
# → {"status":"ok","uptime":...,"version":"1.0.0"}
```

## Step 2: 設定 n8n 環境變數

n8n 工作流需要兩個環境變數：

| 變數 | 說明 | 範例 |
|------|------|------|
| `VALUATION_API_URL` | 估值微服務位址 | `http://localhost:3000` |
| `OPENAI_API_KEY` | OpenAI API Key | `sk-...` |

### 方法 A: Docker Compose（推薦）

在 `docker-compose.yml` 的 n8n service 加入：

```yaml
services:
  n8n:
    environment:
      - VALUATION_API_URL=http://host.docker.internal:3000
      - OPENAI_API_KEY=sk-your-key-here
```

> `host.docker.internal` 讓 Docker 容器存取主機的 localhost:3000。
> Linux 需額外加 `extra_hosts: ["host.docker.internal:host-gateway"]`。

### 方法 B: n8n 本地執行

```bash
export VALUATION_API_URL=http://localhost:3000
export OPENAI_API_KEY=sk-your-key-here
n8n start
```

### 方法 C: n8n UI 設定

Settings → Variables → 新增上述兩個變數。

## Step 3: 匯入 On-Demand 工作流（按需查詢）

1. n8n UI 左側 → **Workflows** → **Add Workflow**
2. 右上角 **...** 選單 → **Import from File**
3. 選擇 `n8n_workflows/on-demand-analysis.json`
4. 確認 9 個節點的連線順序：

```
Webhook 接收查詢 → 驗證 Ticker 格式 → 呼叫估值 API → GET Compare
  → 準備 LLM Prompt → LLM 分類 → Guardrails 驗證
  → Apply LLM Weights → 回傳分析結果
```

5. 點擊 **Save**，然後 **Activate**（右上角開關打開）

### 測試觸發

```bash
curl -s -X POST http://localhost:5678/webhook/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker": "2330"}' | python3 -m json.tool
```

### 預期回應

```json
{
  "source": "llm-enhanced",
  "ticker": "2330",
  "currentPrice": 1050,
  "llmClassification": {
    "type": "成長股",
    "confidence": "HIGH",
    "narrative": "台積電以先進製程主導..."
  },
  "weightedValuation": {
    "fairValue": 1200,
    "method": "DCF 40% + PER 25% + ... (LLM)"
  },
  "recommendation": {
    "action": "BUY",
    "confidence": "一般",
    "upside": 14.3
  }
}
```

> 數值為示意，實際值取決於最新財報數據。

## Step 4: 匯入 Weekly Valuation 工作流（每週排程）

1. 同上方式匯入 `n8n_workflows/weekly-valuation.json`
2. 確認 14 個節點的連線：

```
Cron 每週觸發 → 取得追蹤清單 → 批次分析 → 合併結果與統計
  → 準備 LLM Prompt → LLM 分類 → Guardrails 驗證 → Apply LLM Weights
  → 產生 Telegram 訊息 → 發送 Telegram
  → 產生 Email 報告 → 發送 Email
```

3. **先不要 Activate**，先用手動測試

### 設定追蹤清單

```bash
# 新增追蹤股票
curl -s -X POST http://localhost:3000/api/portfolio \
  -H "Content-Type: application/json" \
  -d '{"tickers": ["2330", "2884", "2317"]}'

# 確認清單
curl -s http://localhost:3000/api/portfolio
# → {"tickers":["2330","2884","2317"]}
```

### 手動測試

在 n8n UI 開啟 weekly-valuation 工作流 → 點擊頂部 **Test Workflow** 按鈕。

### 逐節點驗證

| 節點 | 驗證要點 |
|------|---------|
| 取得追蹤清單 | 回傳 `{"tickers": ["2330", "2884", ...]}` |
| 批次分析 | 每股有完整七模型結果 |
| 合併結果與統計 | allResults 陣列 + stats 統計 |
| 準備 LLM Prompt | openaiBody 包含 system + user prompt |
| LLM 分類 | OpenAI 回傳 JSON，每股有 type + weights |
| Guardrails 驗證 | stocks 物件通過格式驗證 |
| Apply LLM Weights | batch resynthesize 回傳 enhanced/fallback 結果 |
| Telegram/Email | 格式化訊息包含 AI 分類與敘述 |

## Step 5: 設定通知（可選）

### Telegram

1. 建立 Telegram Bot：與 [@BotFather](https://t.me/BotFather) 對話，`/newbot` 取得 Bot Token
2. n8n → Credentials → 新增 **Telegram API** → 填入 Bot Token
3. 取得 Chat ID：將 Bot 加入群組，發送訊息後呼叫 `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. 在 n8n 環境變數設定 `TELEGRAM_CHAT_ID`

### Email (Gmail)

1. n8n → Credentials → 新增 **Gmail OAuth2** 或 **SMTP**
2. Gmail OAuth2 需在 Google Cloud Console 設定 OAuth 2.0 Client
3. SMTP 可用 Google App Password（需開啟兩步驟驗證）

> 不設定通知不影響分析流程，只是最後的發送節點會失敗。

## 常見問題

| 問題 | 解法 |
|------|------|
| `ECONNREFUSED` 連不到估值 API | 確認 `node src/server.js` 運行中；Docker 環境用 `host.docker.internal` |
| OpenAI 401 Unauthorized | 確認 `OPENAI_API_KEY` 環境變數正確且有額度 |
| LLM 分類回退至確定性結果 | 正常行為 — 表示 LLM 輸出未通過 guardrails 驗證，查看 `guardrailErrors` |
| Webhook 404 Not Found | 確認工作流已 **Activate**，webhook path 為 `analyze` |
| 批次分析超時 | 增加 n8n HTTP Request 節點的 Timeout 設定（建議 120 秒） |
| FinMind API 429 | 超過免費額度限制（600 calls/hour），等待後重試或升級方案 |
| 金融股缺少 DCF/CapEx 模型 | 正常行為 — 金融股這些模型天然不適用，LLM 應分配 weight=0 |

## 資料流詳解

### On-Demand 單股流程

```
使用者 POST {"ticker":"2330"}
  → Webhook 接收
  → 驗證格式（4-6 位數字）
  → POST /api/analyze/2330（確定性七模型，結果存入 SQLite）
  → GET /api/compare/2330（取歷史差異）
  → 構建 GPT-4o prompt（七模型數據 + 歷史差異）
  → GPT-4o 回傳分類 + 權重（JSON mode）
  → Guardrails 驗證（類型、權重範圍、加總、模型可用性）
  → POST /api/resynthesize/2330（LLM 權重重新加權）
  → 回傳增強結果
```

### Weekly 批次流程

```
Cron 每週日 09:00 觸發
  → GET /api/portfolio（取追蹤清單）
  → POST /api/analyze/batch（批次分析全部股票）
  → 合併結果 + 計算統計
  → 構建 GPT-4o prompt（全部股票數據）
  → GPT-4o 批次分類
  → Guardrails 驗證
  → POST /api/resynthesize/batch（批次重新加權）
  → 格式化 Telegram 摘要 + Email 詳細報告
  → 發送通知
```

### Guardrails 雙層防護

| 層級 | 位置 | 驗證內容 |
|------|------|---------|
| 第一層 | n8n Code 節點 | JSON 解析、基本格式、類型和權重存在性 |
| 第二層 | 微服務 `/api/resynthesize` | 分類類型合法性、權重 [0, 0.50]、不可用模型 weight=0、加總 ≈ 1.0 |

任一層失敗都會安全回退至確定性結果，不會中斷流程。
