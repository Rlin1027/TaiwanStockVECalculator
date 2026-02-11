# Implementation Plan: n8n Financial Analyst (Taiwan Stocks)

This plan outlines the architecture for an automated financial analysis agent running on n8n, utilizing the FinMind API for Taiwan stock data. It features two distinct valuation models: the original DCF model from Dexter (adapted) and a new Dividend Analysis model.

## User Review Required
>
> [!IMPORTANT]
> **FinMind API Token**: You will need a FinMind API token. The free tier has limits (600 calls/hour), so the workflow should be optimized to minimize requests (e.g., fetching all needed data in parallel).

## 1. System Architecture

The workflow is designed as a **Dual-Process Agent**. It gathers data once, then feeds it into two separate reasoning engines (DCF & Dividend), and finally synthesizes the results.

```mermaid
graph TD
    A[User Trigger (Ticker: 2330)] --> B{Ticker Normalizer}
    B --> C[Data Fetcher (FinMind)]
    C --> D[Data Processing]
    D --> E[Model 1: AC-DCF (Adapted Dexter)]
    D --> F[Model 2: Dividend Analysis]
    E --> G[Synthesis Agent]
    F --> G
    G --> H[Final Report]
```

## 2. Data Integration (FinMind)

We will use `HTTP Request` nodes in n8n to fetch data from FinMind.

### Key Endpoints

| Data Type | FinMind Endpoint | Purpose |
| :--- | :--- | :--- |
| **Stock Price** | `/TaiwanStockPrice` | Current price for valuation comparison. |
| **Financials** | `/TaiwanStockFinancialStatements` | Revenue, EPS, Cash Flow for DCF/Dividend safety. |
| **PER/PBR** | `/TaiwanStockPER` | Historical PE ratio for relative valuation. |
| **Dividend** | `/TaiwanStockDividend` | Cash/Stock dividend history for Yield Analysis. |

> [!TIP]
> FinMind data is often returned as a list of daily records. We will need a **Function Item** node to extract the specific latest values (e.g., TTM EPS, Latest Year Dividend).

## 3. Valuation Model 1: Adapted DCF (Growth Focus)

This model is adapted from the original Dexter `dcf-valuation` skill but tailored for available FinMind data.

### Logic Flow

1. **Calculate FCF (Free Cash Flow)**:
    * Formula: `Operating Cash Flow - Capital Expenditure`
    * *Note*: FinMind might split these. If CapEx is missing, we may estimate it as a % of Revenue or use `Cash Flow from Investing`.
2. **Growth Rate**:
    * Calculate CAGR of Revenue and Net Income over 5 years.
    * *Conservative Check*: Cap growth rate at 15% (Taiwan manufacturing average).
3. **WACC (Discount Rate)**:
    * Since calculating WACC precisely requires Beta and Risk-Free rates not easily in FinMind free tier, we will use **Sector Proxies**:
        * Tech/Semi: 10-12%
        * Finc/Trad: 6-8%
4. **Terminal Value**:
    * Perpetual Growth Rate: 2% (Long-term Taiwan GDP proxy).

## 4. Valuation Model 2: Dividend Analysis (Income Focus)

This model focuses on income stability and "River Charts" (Yield Bands), which are popular in Taiwan.

### Logic Flow

1. **Yield Analysis**:
    * `Current Yield = Cash Dividend / Current Price`
    * Compare to 5-Year Average Yield.
        * *Cheap*: Current Yield > 5Y Avg + 1 SD
        * *Expensive*: Current Yield < 5Y Avg - 1 SD
2. **Payout Ratio Safety**:
    * `Payout Ratio = Cash Dividend / EPS`
    * *Safe*: < 70% (Sustainable)
    * *Warning*: > 90% (Borrowing to pay?)
3. **Dividend Consistency**:
    * Count consecutive years of dividend issuance.
    * Check for growing dividends (Dividend Aristocrat style).

## 5. Final Reporting

 The output will provide a "Dual View" to help the investor decide.

### Sample Output Structure

**Symbol**: 2330 (TSMC)
**Price**: 153.0

| Model | Valuation | Status | Key Driver |
| :--- | :--- | :--- | :--- |
| **DCF (Growth)** | $185.0 | 🟢 Undervalued | High FCF Growth (15%) |
| **Dividend (Income)** | $140.0 | 🔴 Overvalued | Low Yield (1.8%) |

**Analyst Synthesis**:
> TSMC is a **Growth Stock**. The DCF model is more appropriate here as the company reinvests heavily (High CapEx) rather than distributing all profits. The low dividend yield is expected. **Action: Buy based on DCF upside.**
