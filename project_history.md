
# Project History: n8n Financial Analyst (Taiwan Stocks)

## 1. 緣起與目標 (Origin & Goal)
本專案起源於對開源專案 **Dexter** (一個基於 CLI 的美股金融研究 Agent) 的分析。
用戶希望：
1.  分析 Dexter 的運作邏輯。
2.  探討將 Dexter 移植為此 **Claude Code** 的 Plugin 或 **n8n** 自動化流程的可行性。
3.  最終決定採用 **n8n + FinMind API** 架構，並專注於 **台股市場**。
4.  實作兩套估值模型：**DCF (現金流折現)** 與 **股利分析 (Dividend Analysis)**。

## 2. 研究歷程 (Research Journey)

### 2.1 Dexter 分析
*   **Repo**: `https://github.com/virattt/dexter`
*   **核心技術**: LangChain, Bun, Ink (CLI UI).
*   **關鍵架構**:
    *   **Agent**: 負責拆解任務與呼叫工具。
    *   **Tools**: 封裝了 `financialdatasets.ai` 的 API。
    *   **Skills**: 定義了 SOP (如 `dcf-valuation` 的 Markdown 攻略)。
*   **結論**: Dexter 的核心價值在於 **Tools (數據源)** 與 **Skills (SOP)**，Agent 本體邏輯可以被 n8n 或 Claude Code 取代。

### 2.2 平台選擇 (n8n vs. Claude Plugin)
*   **Claude Plugin**: 適合互動式分析，需寫 TypeScript MCP Server。
*   **n8n**: 適合全自動化、排程執行、結合其他服務 (Slack/Email)。
*   **決定**: 採用 **n8n**，因為具備視覺化流程、Human-in-the-loop 能力，且 n8n 新版原生支援 LangChain。

### 2.3 數據源選擇 (Data Source Selection)
*   **挑戰**: Dexter 原用的 `financialdatasets.ai` 對台股支援不明確且需付費。
*   **替代方案評估**:
    *   **FMP (Financial Modeling Prep)**: 支援台股，格式標準，但需付費。
    *   **Yahoo Finance**: 免費但不穩定。
    *   **FinMind**: 台灣本土 API，支援台股財報、股利、籌碼，有免費額度，適合開發者。
*   **決定**: 採用 **FinMind**。

### 2.4 FinMind 數據驗證 (Verification)
我們撰寫了 `scripts/verify_finmind_data.js` 進行實測，確認關鍵欄位：
*   **結果**:
    *   ✅ **Stock Price**: `/TaiwanStockPrice` 正常。
    *   ✅ **Financials**: `/TaiwanStockFinancialStatements` 有 EPS, Revenue, Operating Income。
    *   ✅ **Dividend**: `/TaiwanStockDividend` 有詳細配息紀錄。
    *   ✅ **Cash Flow**: `/TaiwanStockCashFlowsStatement` 包含 `PropertyAndPlantAndEquipment` (CapEx) 與 `CashFlowsFromOperatingActivities` (營運現金流)。
*   **結論**: FinMind 資料足以支撐 DCF 與股利模型。

## 3. 架構設計 (Architecture)

### 3.1 雙軌估值模型 (Dual Valuation Models)
為了適應台股特性，我們設計了兩種觀點：

#### **Model A: Adapted DCF (成長股視角)**
*   **適用**: 台積電 (2330)、聯發科 (2454)。
*   **邏輯**:
    *   FCF = 營運現金流 - 資本支出 (CapEx)。
    *   Growth Rate = 營收 5 年 CAGR (上限 15%)。
    *   WACC = 產業代理變數 (科技業 10-12%)。
    *   Terminal Growth = 2%。

#### **Model B: Dividend Analysis (存股視角)**
*   **適用**: 中華電 (2412)、兆豐金 (2886)。
*   **邏輯**:
    *   Yield Bands (殖利率河流圖)：比較當前殖利率 vs. 5年平均。
    *   Payout Ratio Safety：配息率是否 < 100%。
    *   Dividend Consistency：連續配息年數。

## 4. 交付檔案清單 (Deliverables)

1.  **實作計畫書**: `implementation_plan.md` - 詳細的 n8n 節點規劃與邏輯。
2.  **數據驗證腳本**: `scripts/verify_finmind_data.js` - 用於確認 FinMind API 欄位。
3.  **DCF 邏輯程式碼**: `n8n_nodes/dcf_valuation_logic.js` - 預備放入 n8n Code Node 的 JavaScript 邏輯。
4.  **Task List**: `task.md` - 專案進度追蹤。

## 5. Next Steps for Next Agent
接手的 Agent 應執行以下步驟：
1.  **n8n Setup**: 根據 `implementation_plan.md` 在 n8n 建立 Workflow。
2.  **Code Injection**: 將 `n8n_nodes/dcf_valuation_logic.js` 的內容貼入 n8n Code Node。
3.  **Prompting**: 為 Dividend Analysis 撰寫 System Prompt (或用 Code Node 實作)。
4.  **Reporting**: 設計最終輸出的 Slack/Line 訊息格式。
