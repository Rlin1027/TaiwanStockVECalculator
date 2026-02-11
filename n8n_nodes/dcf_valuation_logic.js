
// Input: Expects data from FinMind nodes
// - financialData (Income Statement)
// - cashFlowData (Cash Flow Statement)
// - priceData (Current Price)
// - facts (Share count, etc. - Optional, or estimated from MarketCap/Price)

const items = $input.all();
const results = [];

// Assumptions
const DISCOUNT_RATE_WACC = 0.10; // 10% for Tech/Semi (Adjustable via input)
const TERMINAL_GROWTH_RATE = 0.02; // 2%
const PROJECTION_YEARS = 5;

for (const item of items) {
    const financials = item.json.financialData || [];
    const cashFlows = item.json.cashFlowData || [];
    const currentPrice = item.json.price || 0;

    // 1. Extract Latest Annual Data (Simplified logic: grab latest year)
    // In production, we should filter by date and sum quarters if needed.
    // Assuming inputs are sorted by date desc.

    // Find Capital Expenditure (PropertyAndPlantAndEquipment) - usually negative
    const latestCapExRecord = cashFlows.find(d => d.type === "PropertyAndPlantAndEquipment");
    const latestOpCashFlowRecord = cashFlows.find(d => d.type === "CashFlowsFromOperatingActivities"); // Verify exact key if possible, else rely on OperatingIncome + D&A proxy

    // Function to get value or default to 0
    const getVal = (record) => record ? parseFloat(record.value) : 0;

    const capEx = Math.abs(getVal(latestCapExRecord)); // Use absolute value
    const opCashFlow = getVal(latestOpCashFlowRecord); // If missing, we might need a proxy

    // Note: If OpCashFlow is missing from API, estimate it: NetIncome + Depreciation
    // For now, let's assume we have it or use OperatingIncome as a rough proxy for FCF base
    const latestOpIncomeRecord = financials.find(d => d.type === "OperatingIncome");
    const opIncome = getVal(latestOpIncomeRecord);

    // FCF Calculation
    // If we have distinct OpCashFlow, use it. Else use OpIncome * 0.7 (Tax shield roughly) - CapEx
    let freeCashFlow = 0;
    if (opCashFlow !== 0) {
        freeCashFlow = opCashFlow - capEx;
    } else {
        // Proxy: NOPAT - CapEx
        // NOPAT ~ OperatingIncome * (1 - TaxRate 20%)
        freeCashFlow = (opIncome * 0.8) - capEx;
    }

    // 2. Growth Rate Estimation (CAGR of Revenue)
    // We need at least 2 points: Current and 4 years ago
    const revenues = financials.filter(d => d.type === "Revenue").sort((a, b) => new Date(b.date) - new Date(a.date));
    let growthRate = 0.05; // Default 5%

    if (revenues.length >= 5) {
        const currentRev = parseFloat(revenues[0].value);
        const pastRev = parseFloat(revenues[4].value); // 5 years ago
        if (pastRev > 0) {
            growthRate = Math.pow(currentRev / pastRev, 1 / 4) - 1;
        }
    }

    // Cap growth rate for safety
    growthRate = Math.min(growthRate, 0.15); // Cap at 15%
    if (growthRate < 0) growthRate = 0; // No negative growth projections for DCF base

    // 3. DCF Projection
    let futureCashFlows = [];
    let sumPresentValue = 0;

    for (let i = 1; i <= PROJECTION_YEARS; i++) {
        const projectedFCF = freeCashFlow * Math.pow(1 + growthRate, i);
        const discountFactor = Math.pow(1 + DISCOUNT_RATE_WACC, i);
        const presentValue = projectedFCF / discountFactor;

        futureCashFlows.push({ year: i, fcf: projectedFCF, pv: presentValue });
        sumPresentValue += presentValue;
    }

    // 4. Terminal Value
    const lastYearFCF = futureCashFlows[PROJECTION_YEARS - 1].fcf;
    const terminalValue = (lastYearFCF * (1 + TERMINAL_GROWTH_RATE)) / (DISCOUNT_RATE_WACC - TERMINAL_GROWTH_RATE);
    const terminalValuePV = terminalValue / Math.pow(1 + DISCOUNT_RATE_WACC, PROJECTION_YEARS);

    sumPresentValue += terminalValuePV;

    // 5. Fair Value Per Share
    // We need Total Outstanding Shares. FinMind doesn't give this directly in generic endpoints easily.
    // We can infer it: MarketCap / Price. Or if we don't have MarketCap, we assume 'EquityAttributableToOwnersOfParent' / BookValuePerShare?
    // Let's rely on an input 'sharesOutstanding' or estimation.
    // Estimation: If we assume the price `currentPrice` corresponds to the latest EPS,
    // Shares = NetIncome / EPS

    const latestNetIncomeRecord = financials.find(d => d.type === "IncomeAfterTaxes"); // Or similar
    const latestEPSRecord = financials.find(d => d.type === "EPS");

    let sharesOutstanding = 1000000000; // Default 1B shares
    if (latestNetIncomeRecord && latestEPSRecord && parseFloat(latestEPSRecord.value) !== 0) {
        sharesOutstanding = parseFloat(latestNetIncomeRecord.value) / parseFloat(latestEPSRecord.value);
    }

    const equityValue = sumPresentValue + (item.json.cashAndEquivalents || 0) - (item.json.totalDebt || 0);
    const fairValuePerShare = equityValue / sharesOutstanding;

    const upside = ((fairValuePerShare - currentPrice) / currentPrice) * 100;

    results.push({
        json: {
            ticker: item.json.ticker || "UNKNOWN",
            currentPrice,
            fairValue: parseFloat(fairValuePerShare.toFixed(2)),
            upside: parseFloat(upside.toFixed(2)) + "%",
            details: {
                fcfBase: freeCashFlow,
                growthRate: (growthRate * 100).toFixed(2) + "%",
                wacc: (DISCOUNT_RATE_WACC * 100) + "%",
                terminalValuePV,
                sumPresentValue
            }
        }
    });
}

return results;
