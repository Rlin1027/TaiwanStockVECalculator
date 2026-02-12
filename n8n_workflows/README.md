# n8nFinMind 估值系統 — n8n 工作流

本資料夾包含三個可匯入 n8n 的 workflow JSON 檔案，用於自動化台股七模型估值分析。

## 環境變數設定

### n8n 環境變數

在 n8n 的 **Settings > Environment Variables** 中設定：

| 變數 | 說明 | 範例 |
|------|------|------|
| `VALUATION_API_URL` | 估值微服務 URL | `http://valuation-api.zeabur.internal:3000` |

> Zeabur 內網互通時使用 `http://valuation-api.zeabur.internal:3000`。
> 本機測試時使用 `http://localhost:3000`。

### n8n Credentials 設定

以下 credentials 需在 n8n 的 **Credentials** 頁面自行建立：

| Credential | 用途 | 設定方式 |
|------------|------|----------|
| **Telegram Bot API** | 發送估值摘要通知 | 輸入 Bot Token 和 Chat ID |
| **Gmail OAuth2** | 發送 HTML 估值報告 | 連結 Google 帳號並授權 |

## 匯入步驟

1. 開啟 n8n 控制台
2. 點擊左上角 **+** 或進入 **Workflows** 頁面
3. 點擊 **Import Workflow**（或使用快捷鍵 Ctrl+O）
4. 選擇本資料夾中的 JSON 檔案
5. 匯入後，前往 **Settings > Environment Variables** 設定 `VALUATION_API_URL`
6. 前往 **Credentials** 設定 Telegram Bot API 和 Gmail OAuth2
7. 在各 workflow 的 Telegram / Gmail 節點中選擇對應的 credential

## 工作流說明

### 1. weekly-valuation.json — 每週台股估值排程

- **觸發方式**：每週一凌晨 02:00（Asia/Taipei）自動執行
- **功能**：
  - 取得追蹤清單中的所有股票
  - 分批執行七模型估值分析（每批 10 檔，批次間等待 30 秒）
  - 合併結果並產生統計摘要
  - 透過 Telegram 發送精簡摘要（買入推薦 + 警示股票）
  - 透過 Gmail 發送完整 HTML 報告（含估值總覽表格與個股詳情）

### 2. on-demand-analysis.json — 按需單股查詢

- **觸發方式**：Webhook `POST /webhook/analyze`
- **請求格式**：`{ "ticker": "2330" }`
- **功能**：驗證股票代碼格式後，呼叫 API 執行單股分析並回傳完整結果

### 3. portfolio-management.json — 追蹤清單管理

- **觸發方式**：Webhook `POST /webhook/portfolio`
- **請求格式**：`{ "action": "add|remove|list", "tickers": ["2330", "2454"] }`
- **功能**：新增、移除或列出追蹤清單中的股票

## API 端點參考

| 方法 | 路徑 | 描述 |
|------|------|------|
| `GET` | `/api/health` | 健康檢查 |
| `POST` | `/api/analyze/:ticker` | 單股分析 |
| `POST` | `/api/analyze/batch` | 批次分析 |
| `GET` | `/api/history/:ticker` | 歷史分析紀錄 |
| `GET` | `/api/portfolio` | 取得追蹤清單 |
| `POST` | `/api/portfolio` | 新增追蹤股票 |
| `DELETE` | `/api/portfolio/:ticker` | 移除追蹤股票 |
