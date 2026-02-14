# TaiwanStockVECalculator

台股七模型估值分析系統 — 基於 FinMind API 的多維度量化估值工具，支援 HTTP API 微服務 + n8n 自動化工作流 + LLM 智慧分類 + 回測準確度驗證 + 回饋調權系統 + 智慧投組管理 + 警示推播

## 功能概述

輸入一個台股代號，系統自動從 FinMind 抓取財報、股價、股利、現金流等數據，透過 **7 個獨立估值模型** 平行計算合理價，再以智慧權重加權合成最終建議。

### 三種使用方式

```bash
# 1. CLI 單股分析（Terminal 彩色輸出）
node src/index.js 2330

# 2. HTTP API 微服務
node src/server.js
curl -X POST http://localhost:3000/api/analyze/2330

# 3. n8n 自動化工作流（每週排程 + 按需查詢 + LLM 智慧分類）
# 詳見 docs/n8n-setup-guide.md
```

## 專案架構

```
src/
├── index.js                 # CLI 入口：參數解析 → 抓取數據 → 執行模型 → 輸出報告
├── server.js                # HTTP API 微服務（Express + SQLite）
├── service.js               # 核心分析服務（單股 + 批次）
├── db.js                    # SQLite 持久化層（分析歷史、追蹤清單）
├── config.js                # 集中設定：產業 WACC、DCF 參數、產業分類對照表
├── api/
│   └── finmind.js           # FinMind API 封裝：並行抓取 8 種數據集
├── models/
│   ├── dcf.js               # Model A: 多階段 DCF 折現現金流
│   ├── dividend.js          # Model B: 股利殖利率 + Gordon Growth Model
│   ├── per.js               # Model C: PER 本益比河流圖
│   ├── pbr.js               # Model D: PBR 股價淨值比
│   ├── capex.js             # Model E: CapEx 資本支出前瞻估值
│   ├── ev-ebitda.js         # Model F: EV/EBITDA 企業價值倍數
│   ├── psr.js               # Model G: PSR 股價營收比
│   ├── momentum.js          # 營收動能分析（輔助調整 DCF 成長率）
│   └── utils.js             # 共用工具：TTM EPS、年度彙整、統計函數
├── llm/
│   ├── guardrails.js        # LLM 輸出驗證層（權重邊界、分類類型、模型可用性）
│   └── resynthesize.js      # LLM 權重重新合成引擎
├── backtest/
│   ├── engine.js            # 回測引擎：漸進式股價比對 + 90d/180d 回填
│   └── metrics.js           # 準確度指標：hit rate、MAE、模型排名
├── feedback/
│   ├── adaptive-weights.js  # 自適應權重：依回測 MAE 計算各分類最佳權重
│   ├── cache.js             # 記憶體快取：24h 過期 + lazy refresh
│   ├── resynthesize-feedback.js # 回饋重新合成：混合權重計算合理價
│   └── index.js             # 統一匯出介面
├── portfolio/
│   ├── analytics.js         # 投組分析：績效、產業配置、風險指標
│   └── alerts.js            # 警示系統：價格/估值/分類變化觸發
└── report/
    ├── synthesizer.js       # 七模型綜合引擎：分類、加權、建議、風險
    └── formatters.js        # 輸出格式化：Terminal / Markdown / JSON

n8n_workflows/
├── on-demand-analysis.json      # 按需查詢：Webhook 觸發 + LLM 分類 + 即時回傳
├── portfolio-management.json    # 追蹤清單管理：add / remove / list
├── phase3-management.json       # Phase 3 管理：持倉 / 回測 / 警示（11 種操作）
├── weekly-valuation.json        # 每週排程：批次分析 + 回測掃描 + 回饋調權 + LLM 分類 + 投組績效
├── daily-alerts.json            # 每日警示：收盤後檢查觸發條件 → Telegram 推播
└── telegram-bot.json            # Telegram Bot：對話式操作所有功能（20+ 指令）

docs/
└── n8n-setup-guide.md       # n8n 工作流匯入與設定指南
```

## 七大估值模型

### Model A: DCF 多階段折現現金流

**核心公式**：

```
合理價 = Σ(FCFt / (1+WACC)^t) + 終端價值 / (1+WACC)^n
終端價值 = FCF_n × (1+g) / (WACC - g)
```

**特點**：
- **三階段成長**：高成長期（3 年）→ 衰退期（2 年）→ 終端穩定成長（GDP 2%）
- **營收動能調整**：短期 YoY 顯著高於/低於長期 CAGR 時，動態調整第一階段成長率
- **產業 WACC**：依產業查表（半導體 10%、金融 7%、電信 7%、傳產 9% 等）
- **安全邊際**：預設 25%，提供保守估值參考
- **FCF Yield**：同時計算自由現金流殖利率，提供即時現金流視角

**適用**：自由現金流為正的非金融股

### Model B: 股利殖利率 + GGM

**殖利率法**：以歷史殖利率的平均值和標準差建立河流圖帶狀區間，判斷目前殖利率水位。

**Gordon Growth Model (GGM)**：

```
合理價 = D1 / (r - g)
D1 = 最近年度股利 × (1 + 股利成長率)
r  = 產業 WACC（要求報酬率）
g  = 股利 CAGR（上限 6%）
```

**配息安全性評估**：
- 計算配息率（Payout Ratio），分為 SAFE / MODERATE / WARNING 三級
- 追蹤連續配息年數，判定是否為「股利貴族」（≥10 年）

**適用**：穩定配息股（金控、電信、食品）

### Model C: PER 本益比河流圖

**原理**：收集近 3 年每日 PER 數據（約 750 個交易日），計算平均值與標準差，建立五層帶狀區間：

```
極度便宜 ─── -2SD ─── 便宜 ─── -1SD ─── 均值 ─── +1SD ─── 昂貴 ─── +2SD ─── 極度昂貴
```

**合理價** = 平均 PER × TTM EPS

**過濾機制**：排除 PER > 100 的極端值（如轉虧為盈的過渡期），避免污染統計分布。

**適用**：EPS 為正的所有股票

### Model D: PBR 股價淨值比

**原理**：與 PER 類似，使用近 3 年 PBR 歷史分布建立河流圖。

**合理價** = 平均 PBR × BVPS（每股淨值）

**BVPS 計算**：
1. 優先從資產負債表取得股東權益 ÷ 流通股數
2. Fallback：從最新 PBR 和股價反推

**適用**：金融股（主要）、資產密集型產業（輔助）

### Model E: CapEx 資本支出前瞻估值

**核心邏輯**：資本支出是未來產能的領先指標。

```
傳導比率 = Revenue CAGR / CapEx CAGR（T-2 年滯後）
前瞻營收成長 = CapEx 近期 YoY × 傳導比率
前瞻 EPS = TTM EPS × (1 + 前瞻盈餘成長率)
合理價 = 前瞻 EPS × 平均 PER
```

**特點**：
- **時間滯後**：CapEx 到營收貢獻通常有 1-2 年延遲，模型使用 T-2 年數據
- **產業信心度**：依 CapEx 強度（佔營收比）判斷產業資本密集程度
- **營業槓桿**：考慮固定成本放大效果

**適用**：資本密集型成長股（半導體、電子、通信設備）

### Model F: EV/EBITDA 企業價值倍數

**原理**：機構投資人常用指標，消除資本結構（負債水準）和折舊政策差異的影響。

```
EV = 市值 + 總負債 - 現金
EBITDA = 營業利益 + 折舊攤銷
合理價 = (平均 EV/EBITDA × 當期 EBITDA - 總負債 + 現金) / 流通股數
```

**河流圖**：使用近 5 年歷史 EV/EBITDA 的 mean ± SD 建立帶狀區間。

**適用**：高負債公司（電信、航運）、資本密集產業、跨國比較

### Model G: PSR 股價營收比

**原理**：針對虧損中但營收成長的公司，PER 不適用時的替代指標。

```
RPS = 年度營收 / 流通股數
合理價 = 平均 PSR × 當期 RPS
```

**適用**：虧損中的成長股、營收快速擴張但尚未獲利的公司

## 智慧加權引擎

### 雙軌分類系統

系統支援兩種分類模式，確保可靠性：

**確定性分類（Synthesizer）**：根據產業特性和財務數據自動分為 7 類，固定權重配置：

| 股票類型 | DCF | PER | PBR | 股利 | CapEx | EV/EBITDA | PSR |
|:---------|----:|----:|----:|-----:|------:|----------:|----:|
| 金融業 | 0% | 28% | 40% | 32% | 0% | 0% | 0% |
| 成長股 | 30% | 20% | 0% | 10% | 20% | 10% | 10% |
| 存股 | 15% | 20% | 10% | 35% | 0% | 10% | 10% |
| 價值成長股 | 25% | 25% | 5% | 15% | 15% | 10% | 5% |
| 週期性 | 15% | 20% | 15% | 15% | 10% | 15% | 10% |
| 虧損成長股 | 0% | 0% | 10% | 0% | 10% | 20% | 60% |
| 混合型 | 20% | 20% | 10% | 15% | 10% | 15% | 10% |

**LLM 智慧分類（Phase 2）**：透過 n8n 工作流呼叫 gpt-5-mini，根據七模型數據和歷史趨勢動態判斷分類與權重：

- 分析每股的基本面特徵（成長率、殖利率、PE、產業等）
- 動態分配 7 個模型權重（每個 weight 上限 50%，加總 = 100%）
- 提供繁體中文分析敘述和信心度評估
- Guardrails 雙層驗證確保輸出合規，失敗時安全回退至確定性結果

### 信心度動態調整

權重並非固定不變，會根據模型內部信心度進行微調：

- **DCF 終端價值佔比 > 85%**：權重打 6 折（短期現金流支撐不足）
- **DCF 終端價值佔比 > 75%**：權重打 8 折
- **FCF 為負值**：DCF 權重打 3 折
- **CapEx 產業信心度 LOW**：權重打 5 折
- **CapEx 產業信心度 HIGH**：權重乘 1.2 倍

調整後權重會重新正規化，確保加總 = 100%。

### 建議生成

| 建議 | 條件 |
|:-----|:-----|
| BUY（強烈） | upside ≥ 30% |
| BUY（一般） | upside ≥ 10% |
| HOLD（中性） | -10% < upside < 10% |
| SELL（一般） | upside ≤ -10% |
| SELL（強烈） | upside ≤ -20% |

## HTTP API 微服務

估值系統提供 RESTful API，供 n8n 工作流或其他系統整合使用。

```bash
# 啟動
node src/server.js
# → Valuation API running on port 3000
```

### API 端點

| 方法 | 路徑 | 說明 |
|:-----|:-----|:-----|
| GET | `/api/health` | 健康檢查 |
| POST | `/api/analyze/:ticker` | 單股七模型分析 |
| POST | `/api/analyze/batch` | 批次分析（body: `{"tickers": [...]}`) |
| GET | `/api/history/:ticker` | 歷史分析紀錄 |
| GET | `/api/compare/:ticker` | 最近兩次分析差異比較 |
| POST | `/api/resynthesize/:ticker` | LLM 權重重新合成 |
| POST | `/api/resynthesize/batch` | 批次 LLM 重新合成 |
| GET | `/api/portfolio` | 取得追蹤清單 |
| POST | `/api/portfolio` | 新增追蹤（body: `{"tickers": [...]}`) |
| DELETE | `/api/portfolio/:ticker` | 移除追蹤 |
| **回測驗證** | | |
| POST | `/api/backtest/run` | 觸發回測掃描（比對歷史預測 vs 實際股價） |
| GET | `/api/backtest/summary` | 聚合準確度統計（hit rate、MAE、模型排名） |
| GET | `/api/backtest/:ticker` | 特定股票的回測紀錄與指標 |
| **回饋調權** | | |
| GET | `/api/feedback/weights` | 所有分類類型的回饋權重（含樣本數、信心度） |
| GET | `/api/feedback/weights/:type` | 特定分類的詳細權重（預設 vs 回饋 vs 混合） |
| POST | `/api/feedback/refresh` | 強制重算回饋快取（可自訂 minSamples、blendRatio） |
| **投組管理** | | |
| GET | `/api/portfolio/holdings` | 取得所有持倉明細 |
| PUT | `/api/portfolio/holdings/:ticker` | 新增/更新持倉（body: `{"shares", "costBasis", "notes"}`) |
| DELETE | `/api/portfolio/holdings/:ticker` | 移除持倉 |
| GET | `/api/portfolio/analytics` | 投組績效分析（配置、風險、估值摘要） |
| **警示系統** | | |
| GET | `/api/alerts` | 列出所有啟用中的警示 |
| POST | `/api/alerts` | 建立警示（body: `{"ticker", "alertType", "threshold"}`) |
| DELETE | `/api/alerts/:id` | 停用警示 |
| POST | `/api/alerts/check` | 觸發一次警示檢查，回傳已觸發列表 |

### 使用範例

```bash
# 分析台積電
curl -X POST http://localhost:3000/api/analyze/2330

# 批次分析
curl -X POST http://localhost:3000/api/analyze/batch \
  -H "Content-Type: application/json" \
  -d '{"tickers": ["2330", "2884", "2317"]}'

# 歷史差異比較
curl http://localhost:3000/api/compare/2330

# LLM 權重重新合成
curl -X POST http://localhost:3000/api/resynthesize/2330 \
  -H "Content-Type: application/json" \
  -d '{
    "llmClassification": {
      "type": "成長股",
      "weights": {"dcf":0.40,"per":0.25,"pbr":0,"div":0.05,"capex":0.15,"evEbitda":0.10,"psr":0.05},
      "confidence": "HIGH",
      "narrative": "台積電高成長特性"
    }
  }'

# 管理追蹤清單
curl -X POST http://localhost:3000/api/portfolio \
  -H "Content-Type: application/json" \
  -d '{"tickers": ["2330", "2884"]}'

# === Phase 3: 回測 + 投組 + 警示 ===

# 建立持倉
curl -X PUT http://localhost:3000/api/portfolio/holdings/2330 \
  -H "Content-Type: application/json" \
  -d '{"shares": 100, "costBasis": 950, "notes": "長期持有"}'

# 查看投組績效
curl http://localhost:3000/api/portfolio/analytics

# 觸發回測掃描
curl -X POST http://localhost:3000/api/backtest/run \
  -H "Content-Type: application/json" \
  -d '{"minDaysAgo": 30}'

# 查看回測摘要
curl http://localhost:3000/api/backtest/summary

# 建立價格警示
curl -X POST http://localhost:3000/api/alerts \
  -H "Content-Type: application/json" \
  -d '{"ticker": "2330", "alertType": "price_above", "threshold": 1100}'

# 檢查警示觸發
curl -X POST http://localhost:3000/api/alerts/check
```

## 回測準確度驗證

系統會用 DB 中已儲存的歷史分析，比對實際後續股價，計算各模型和分類的準確度。

### 運作方式

1. **漸進式回測**：分析紀錄滿 30 天後自動納入回測，後續 90 天、180 天到期時回填更長期數據
2. **方向正確性**：BUY 預測 → 股價上漲 = correct；SELL → 下跌 = correct；HOLD → 變化 < ±5% = correct
3. **MAE（平均絕對誤差）**：`|預測合理價 - 實際價格| / 實際價格 × 100%`，用於評估預測精準度
4. **模型排名**：依各模型的 MAE 由低到高排名，找出最準確的估值方法

### 回測摘要結構

```json
{
  "overall": { "hitRate30d": 72, "hitRate90d": 68, "avgMAE30d": 12.5 },
  "byType": { "成長股": { "hitRate30d": 80, "count": 15 } },
  "byModel": { "per": { "avgMAE30d": 8.3 } },
  "leaderboard": [{ "rank": 1, "model": "per", "avgMAE": 8.3 }]
}
```

## 回饋調權系統

系統根據回測結果自動學習各估值模型的準確度，動態調整模型權重，形成「預測 → 回測 → 回饋 → 優化」的閉環。

### 運作原理

1. **MAE 計算**：收集各分類（成長股、存股等）下每個模型的平均絕對誤差（MAE）
2. **反比權重**：MAE 越低的模型獲得越高權重（`weight = 1/MAE`，正規化後加總 = 1）
3. **多時間維度**：綜合 30d（25%）、90d（50%）、180d（25%）三個回測窗口
4. **混合策略**：回饋權重與預設權重按比例混合（預設 30% 回饋 + 70% 預設），避免過擬合

### 回饋注入點

| 注入點 | 說明 |
|:-------|:-----|
| `analyzeStock()` | 即時分析時自動注入回饋權重，結果含 `feedbackMetadata` |
| `analyzeBatch()` | 批次開始前刷新快取，所有股票共用同一回饋快取 |
| 每週工作流 | LLM system prompt 包含回饋權重表格供 AI 參考 |
| Telegram/Email | 報告顯示回饋狀態、調權來源、信心度指標 |

### 回饋權重 API

```bash
# 查看所有分類的回饋權重
curl http://localhost:3000/api/feedback/weights

# 查看特定分類的詳細權重（預設 vs 回饋 vs 混合）
curl http://localhost:3000/api/feedback/weights/成長股

# 強制重算（可自訂參數）
curl -X POST http://localhost:3000/api/feedback/refresh \
  -H "Content-Type: application/json" \
  -d '{"minSamples": 20, "blendRatio": 0.40}'
```

### 信心度分級

| 等級 | 樣本數 | 說明 |
|:-----|-------:|:-----|
| HIGH | > 100 筆 | 權重穩定可靠 |
| MEDIUM | 30–100 筆 | 參考價值中等 |
| LOW | < 30 筆 | 僅供參考，預設權重為主 |

### 相關環境變數

| 變數 | 預設值 | 說明 |
|:-----|:-------|:-----|
| `FEEDBACK_ENABLED` | `true` | 是否啟用回饋調權 |
| `FEEDBACK_MIN_SAMPLES` | `10` | 各分類最少回測樣本數 |
| `FEEDBACK_BLEND_RATIO` | `0.30` | 回饋權重佔比（0–1） |

## 智慧投組管理

在原有追蹤清單之上，新增完整的持倉管理功能。

### 投組分析指標

| 類別 | 指標 | 說明 |
|:-----|:-----|:-----|
| 總覽 | totalValue / totalCost / unrealizedPnL | 總市值、總成本、未實現損益 |
| 個股 | marketValue / pnl / weight | 各持倉市值、損益、佔比 |
| 產業配置 | sectorAllocation | 各產業的市值佔比與持股數 |
| 風險 | concentrationTop3 / sectorConcentration | 前 3 大持股集中度、最大產業佔比 |
| 估值 | undervalued / overvalued / fairlyValued | 依 upside 分組的股票清單 |

**無持股模式**：若 `shares = 0`（僅追蹤），仍顯示估值資訊但不計入投組價值。

## 警示系統

支援 4 種警示類型，搭配每日 Telegram 推播：

| 類型 | 觸發條件 | 範例 |
|:-----|:---------|:-----|
| `price_above` | 現價 ≥ 閾值 | 台積電漲到 1100 通知我 |
| `price_below` | 現價 ≤ 閾值 | 台積電跌到 900 通知我 |
| `upside_above` | 潛在上漲空間 ≥ 閾值% | 當 upside 超過 30% 通知我 |
| `classification_change` | 分類類型改變 | 從成長股變成存股時通知我 |

警示檢查流程：取所有啟用警示 → 抓最新分析 + 當前股價 → 逐一檢查觸發條件 → 更新觸發時間 → 回傳觸發列表。

## n8n 自動化工作流

系統提供六個 n8n 工作流，已針對 **n8n v2.7.4 (Zeabur Self-Hosted)** 優化部署，實現完整的自動化估值分析管道。

### 系統架構流程圖

```
┌─────────────────────────────────────────────────────────────────────┐
│                         n8n Workflow Engine                         │
│                    (https://rlin9688.zeabur.app)                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────┐ ┌────────────┐ ┌──────────────┐ ┌────────────────┐  │
│  │ Webhook   │ │ Webhook    │ │ Webhook      │ │ Telegram Bot   │  │
│  │ /analyze  │ │ /portfolio │ │ /phase3      │ │ 訊息觸發       │  │
│  └─────┬─────┘ └─────┬──────┘ └──────┬───────┘ └───────┬────────┘  │
│        │              │               │                  │           │
│        ▼              ▼               ▼                  ▼           │
│  ┌───────────┐ ┌────────────┐ ┌──────────────┐ ┌────────────────┐  │
│  │ Code: 驗證│ │ Code: 路由 │ │ Code: 路由   │ │ Code: 解析指令 │  │
│  │ +LLM 分類 │ │ add/remove │ │ holdings/    │ │ 20+ 指令路由   │  │
│  │+Guardrails│ │ /list      │ │ alert/backtest│ │ + 格式化回覆   │  │
│  └─────┬─────┘ └─────┬──────┘ │ /analytics   │ └───────┬────────┘  │
│        │              │        └──────┬───────┘         │           │
│        ▼              ▼               ▼                  ▼           │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              HTTP Request (動態 method/url/sendBody)          │  │
│  │              → $env.VALUATION_API_URL + apiPath              │  │
│  └──────────────────────────┬───────────────────────────────────┘  │
│                              │                                      │
│  ┌───────────────┐  ┌───────┴───────┐                              │
│  │ Schedule       │  │               │                              │
│  │ 每週一 02:00   │──▶ 批次估值分析  │                              │
│  │ 每日   18:00   │──▶ 警示檢查     │                              │
│  └───────────────┘  └───────┬───────┘                              │
│                              │                                      │
│                              ▼                                      │
│                    ┌──────────────────┐                             │
│                    │  Telegram / Email │                             │
│                    │  通知推播         │                             │
│                    └──────────────────┘                             │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Valuation API (Zeabur)                         │
│             (https://valuation-api-internal.zeabur.app)             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  /api/analyze/:ticker    七模型估值分析                              │
│  /api/portfolio          追蹤清單 CRUD                               │
│  /api/portfolio/holdings 持倉管理                                    │
│  /api/portfolio/analytics 投組績效分析                               │
│  /api/alerts             警示 CRUD + 觸發檢查                       │
│  /api/backtest           回測驗證 + 準確度統計                       │
│  /api/resynthesize       LLM 權重重新合成                            │
│  /api/feedback           回饋調權（自適應權重 + 快取管理）            │
│                                                                     │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐                        │
│  │ FinMind  │  │ OpenAI    │  │ SQLite   │                        │
│  │ API      │  │ gpt-5-mini│  │ (Volume) │                        │
│  └──────────┘  └───────────┘  └──────────┘                        │
└─────────────────────────────────────────────────────────────────────┘
```

### 六大工作流

#### 1. 即時估值分析 (`on-demand-analysis.json`)

```
POST /webhook/analyze {"ticker": "2330"}
  → 驗證 Ticker → 七模型分析 → 歷史差異比較
  → gpt-5-mini 分類 → Guardrails 驗證
  → LLM 重新加權 → 即時回傳結果
```

#### 2. 追蹤清單管理 (`portfolio-management.json`)

```
POST /webhook/portfolio {"action": "add", "tickers": ["2330"]}
POST /webhook/portfolio {"action": "remove", "tickers": ["2330"]}
POST /webhook/portfolio {"action": "list"}
  → Code 路由邏輯 → 動態 HTTP Request → API 回傳結果
```

#### 3. Phase 3 管理 (`phase3-management.json`)

```
POST /webhook/phase3 {"action": "<action>", ...params}
  支援 11 種操作：
  - 持倉：holdings_add / holdings_remove / holdings_list / analytics
  - 警示：alert_add / alert_list / alert_check / alert_remove
  - 回測：backtest_run / backtest_summary / backtest_ticker
  → Code 路由邏輯 → 動態 HTTP Request (method/url/sendBody) → API 回傳
```

#### 4. 每週估值報告 (`weekly-valuation.json`)

```
Cron 每週一 02:00
  → 取得追蹤清單 → 準備批次請求 → 分批估值分析 (10 檔/批 + 7 分鐘間隔)
  → 合併結果與統計
  → 觸發回測掃描 (POST /api/backtest/run)
  → 取得回饋權重 (GET /api/feedback/weights)
  → gpt-5-mini 智慧分類 + 權重分配（含回饋權重參考）
  → Guardrails 驗證 → LLM 權重重新加權
  → 取得回測摘要 + 投組績效
  → Telegram 摘要（含回饋調權狀態）+ Email HTML 報告（含回饋權重視覺化）
```

#### 5. 每日警示推播 (`daily-alerts.json`)

```
Cron 每日 18:00（收盤後）
  → POST /api/alerts/check
  → Code 格式化 + 過濾（無觸發則停止）
  → Telegram 推播觸發的警示
```

#### 6. Telegram Bot (`telegram-bot.json`)

```
Telegram 訊息觸發
  → Code 解析指令（20+ 指令對應 API 路由）
  → 動態 HTTP Request → Code 格式化回覆
  → Telegram 回覆

支援指令：
  /analyze /a     — 即時估值分析
  /add /remove /list — 追蹤清單管理
  /hold /sell /holdings /analytics — 持倉管理
  /alert /alerts /check /alert_off — 價格警示
  /backtest /bt   — 回測驗證
  /help           — 完整使用指南（含操作流程教學）
```

### 部署資訊

| 元件 | 平台 | URL |
|:-----|:-----|:----|
| Valuation API | Zeabur (Docker) | `https://valuation-api-internal.zeabur.app` |
| n8n | Zeabur (Self-Hosted) | `https://rlin9688.zeabur.app` |
| SQLite 持久化 | Zeabur Volume | Mount: `/data`, env: `DB_PATH=/data/valuation.db` |

### n8n 相容性注意事項

針對 n8n v2.7.4 (Self-Hosted) 的已知限制：

- **Switch / If / Respond to Webhook 節點**：匯入時會報 "Could not find property option"，統一用 Code 節點替代
- **GET + sendBody: true**：會造成執行錯誤，需用動態表達式 `={{ $json.apiMethod === 'POST' }}` 控制
- **gpt-5-mini**：不支援自訂 temperature，僅使用預設值
- **環境變數**：使用 `$env` 存取（需設定 `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`）

### 設定指南

完整的 n8n 匯入步驟、環境變數設定、通知設定請參閱 **[docs/n8n-setup-guide.md](docs/n8n-setup-guide.md)**。

## 數據來源

所有數據透過 [FinMind API](https://finmindtrade.com/) 取得，單次分析並行抓取以下 8 種數據集：

| 數據集 | API Endpoint | 用途 |
|:-------|:-------------|:-----|
| 股價歷史 | TaiwanStockPrice | 當前股價、歷史價格 |
| 財務報表 | TaiwanStockFinancialStatements | EPS、營業利益、營收 |
| 現金流量表 | TaiwanStockCashFlowsStatement | FCF、折舊、CapEx |
| 股利政策 | TaiwanStockDividend | 現金股利、股票股利 |
| 本益比/淨值比 | TaiwanStockPER | 每日 PER、PBR |
| 月營收 | TaiwanStockMonthRevenue | 營收動能分析 |
| 資產負債表 | TaiwanStockBalanceSheet | 負債、現金、股東權益 |
| 公司資訊 | TaiwanStockInfo | 產業分類 |

## 安裝與使用

### 前置需求

- Node.js 18+
- FinMind API Token（[免費申請](https://finmindtrade.com/)）

### 安裝

```bash
git clone https://github.com/Rlin1027/TaiwanStockVECalculator.git
cd TaiwanStockVECalculator
npm install
```

### 設定環境變數

```bash
cp .env.example .env
# 編輯 .env，填入 FINMIND_API_TOKEN
```

### 執行

```bash
# === CLI 模式 ===

# 分析單一股票（Terminal 彩色輸出）
node src/index.js 2330

# 輸出 Markdown 報告
node src/index.js 2330 --format md --output output/2330.md

# 輸出 JSON
node src/index.js 2886 --format json

# === HTTP API 模式 ===

# 啟動微服務
node src/server.js

# 單股分析
curl -X POST http://localhost:3000/api/analyze/2330

# === n8n 自動化模式 ===
# 詳見 docs/n8n-setup-guide.md

# === QA 測試 ===

# 0050 全部成份股
node src/qa-test.js

# 僅金融股
node src/qa-test.js --sector 金融

# 前 5 檔
node src/qa-test.js --batch-size 5

# 批次分析指定股票
node src/batch-test.js 2330 2454 2317
```

## QA 測試框架

`qa-test.js` 提供四層自動化驗證，以 0050 ETF 50 檔成份股為 benchmark：

| Level | 驗證內容 | 說明 |
|:------|:---------|:-----|
| L1 結構完整性 | ticker、price、classification、fairValue、action、timestamp | 報告結構是否完整 |
| L2 模型可用性 | 至少 2/7 模型可用、非金融股 DCF 應可用 | 模型是否正常啟動 |
| L3 數值合理性 | fairValue > 0、upside ∈ [-90%, 500%]、PER < 200、權重加總 = 1 | 數值是否在合理範圍 |
| L4 跨模型一致性 | 3+ 模型判 UNDERVALUED 但 action 非 BUY 時警告、fairValue CV 檢測 | 模型間是否存在矛盾 |

## 產業 WACC 設定

| 產業 | WACC | 說明 |
|:-----|-----:|:-----|
| 半導體 | 10% | 高成長但週期波動大 |
| 電子零組件 | 10% | 技術迭代快 |
| 金融保險 | 7% | 穩定但受利率影響 |
| 電信 | 7% | 穩定現金流 |
| 食品 | 8% | 防禦型產業 |
| 傳產 | 9% | 中等風險 |
| 週期性 | 10% | 景氣波動大 |

## 技術特點

- **純 Node.js ESM**：最小依賴（Express、better-sqlite3、dotenv、cors），無需 Python 或 R
- **並行數據抓取**：8 個 API 呼叫同時發出，減少等待時間
- **單位自動校正**：FinMind 財報數據可能以千元為單位，系統自動偵測並修正
- **動態流通股數估算**：從財報推算，無需外部股本資料
- **三種輸出格式**：Terminal（ANSI 彩色）、Markdown（GitHub 可讀）、JSON（程式整合）
- **進度訊息與報告分離**：進度用 `stderr`、報告用 `stdout`，支援 pipe
- **HTTP API 微服務**：Express + SQLite 持久化，支援單股/批次分析、歷史比較、追蹤清單
- **LLM 智慧分類**：gpt-5-mini 動態分類 + 權重分配，Guardrails 雙層驗證確保安全回退
- **n8n 工作流整合**：每週自動排程 + Webhook 按需查詢 + 每日警示推播 + Telegram Bot 對話式操作
- **回測準確度驗證**：漸進式回測（30d/90d/180d），計算 hit rate、MAE、模型排名
- **回饋調權系統**：根據回測 MAE 自動優化模型權重，30% 回饋 + 70% 預設混合策略，24h 快取
- **智慧投組管理**：持倉追蹤、產業配置、風險指標、估值分組，整合至週報
- **警示推播系統**：4 種觸發條件（價格/估值/分類變化），每日 Telegram 自動通知
- **零侵入式架構**：Phase 2-3 所有新功能透過新模組 + 新端點實現，不修改核心計算邏輯

## 限制與注意事項

- WACC 為靜態查表，未包含 Beta 計算和無風險利率動態調整
- 金融股的 DCF 模型天然不適用（營業現金流包含存放款，非真實 FCF）
- 轉投資價值（如南亞持有台塑化股份）未反映在財報營收中
- FinMind 免費方案有 API 呼叫次數限制
- 本系統僅供研究參考，不構成任何投資建議

## License

MIT
