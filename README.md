# TaiwanStockVECalculator

台股七模型估值分析系統 — 基於 FinMind API 的多維度量化估值工具

## 功能概述

輸入一個台股代號，系統自動從 FinMind 抓取財報、股價、股利、現金流等數據，透過 **7 個獨立估值模型** 平行計算合理價，再以智慧權重加權合成最終建議。

```bash
# 基本用法
node src/index.js 2330

# 輸出 Markdown 報告
node src/index.js 2330 --format md --output report.md

# 輸出 JSON（供程式整合）
node src/index.js 2886 --format json
```

## 專案架構

```
src/
├── index.js                 # 主入口：參數解析 → 抓取數據 → 執行模型 → 輸出報告
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
└── report/
    ├── synthesizer.js       # 七模型綜合引擎：分類、加權、建議、風險
    └── formatters.js        # 輸出格式化：Terminal / Markdown / JSON
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

## 智慧加權引擎（Synthesizer）

### 股票分類系統

系統根據產業特性和財務數據自動將股票分為 7 類，每類有不同的模型權重配置：

| 股票類型 | DCF | PER | PBR | 股利 | CapEx | EV/EBITDA | PSR |
|:---------|----:|----:|----:|-----:|------:|----------:|----:|
| 金融業 | 0% | 28% | 40% | 32% | 0% | 0% | 0% |
| 成長股 | 30% | 20% | 0% | 10% | 20% | 10% | 10% |
| 存股 | 15% | 20% | 10% | 35% | 0% | 10% | 10% |
| 價值成長股 | 25% | 25% | 5% | 15% | 15% | 10% | 5% |
| 週期性 | 15% | 20% | 15% | 15% | 10% | 15% | 10% |
| 虧損成長股 | 0% | 0% | 10% | 0% | 10% | 20% | 60% |
| 混合型 | 20% | 20% | 10% | 15% | 10% | 15% | 10% |

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

### 設定 API Token

```bash
echo "FINMIND_API_TOKEN=你的token" > .env
```

### 執行

```bash
# 分析單一股票（Terminal 彩色輸出）
node src/index.js 2330

# 輸出 Markdown 報告
node src/index.js 2330 --format md --output output/2330.md

# 輸出 JSON
node src/index.js 2886 --format json

# QA 測試：0050 全部成份股
node src/qa-test.js

# QA 測試：僅金融股
node src/qa-test.js --sector 金融

# QA 測試：前 5 檔
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

- **純 Node.js ESM**：零外部依賴（僅 `dotenv`），無需 Python 或 R
- **並行數據抓取**：8 個 API 呼叫同時發出，減少等待時間
- **單位自動校正**：FinMind 財報數據可能以千元為單位，系統自動偵測並修正
- **動態流通股數估算**：從財報推算，無需外部股本資料
- **三種輸出格式**：Terminal（ANSI 彩色）、Markdown（GitHub 可讀）、JSON（程式整合）
- **進度訊息與報告分離**：進度用 `stderr`、報告用 `stdout`，支援 pipe

## 限制與注意事項

- WACC 為靜態查表，未包含 Beta 計算和無風險利率動態調整
- 金融股的 DCF 模型天然不適用（營業現金流包含存放款，非真實 FCF）
- 轉投資價值（如南亞持有台塑化股份）未反映在財報營收中
- FinMind 免費方案有 API 呼叫次數限制
- 本系統僅供研究參考，不構成任何投資建議

## License

MIT
