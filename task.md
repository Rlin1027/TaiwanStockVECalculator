# n8n Financial Analyst (Taiwan Stock Focused)

- [/] **Phase 1: Workflow Architecture & Data Source**
  - [ ] Define n8n workflow structure (Trigger -> ID Mapping -> Quant/Analysis -> Report).
  - [/] Design FinMind API integration (Token management, API endpoints for Price, PER, Financials).
  - [ ] Implement Ticker Mapping (e.g., 2330 -> 2330.TW handling).

- [ ] **Phase 2: Valuation Model 1 - Adapted DCF (Dexter Original)**
  - [ ] Map FinMind financial statements to DCF inputs (FCF, WACC components).
  - [ ] Adapt terminal value logic for Taiwan market context.
  - [ ] Create system prompt/logic for DCF calculation in n8n.

- [ ] **Phase 3: Valuation Model 2 - Dividend Analysis (New)**
  - [ ] Define key metrics: Dividend Yield, Payout Ratio, Dividend Growth, Consecutive Years.
  - [ ] Design logic to evaluate "Dividend Safety" and "Fair Value" based on yield bands (River Chart).
  - [ ] Create system prompt/logic for Dividend Analysis in n8n.

- [ ] **Phase 4: Synthesis & Reporting**
  - [ ] Design the final report format (Dual-View Comparison).
  - [ ] Integrate "Analyst Summary" to weight the two models based on stock type (Growth vs. Income).
