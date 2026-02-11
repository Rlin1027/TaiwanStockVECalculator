
// Node.js v18+ has native fetch

const API_TOKEN = process.env.FINMIND_API_TOKEN || ""; // User to provide token via env var
const TICKER = "2330";
const BASE_URL = "https://api.finmindtrade.com/api/v4/data";

async function fetchData(dataset, startDate) {
  const url = new URL(BASE_URL);
  url.searchParams.append("dataset", dataset);
  url.searchParams.append("data_id", TICKER);
  url.searchParams.append("start_date", startDate);
  if (API_TOKEN) {
    url.searchParams.append("token", API_TOKEN);
  }

  console.log(`Fetching ${dataset}...`);
  try {
    const response = await fetch(url.toString());
    const json = await response.json();
    if (json.msg === "success" && json.data.length > 0) {
      return json.data;
    } else {
      console.error(`Error fetching ${dataset}:`, json.msg || "No data returned");
      return null;
    }
  } catch (error) {
    console.error(`Network error fetching ${dataset}:`, error);
    return null;
  }
}

async function verify() {
  console.log("=== Verifying FinMind Data for DCF & Dividend Models ===\n");

  // 1. Check Financial Statements (For DCF: Operating Cash Flow, CapEx)
  console.log("[Checking TaiwanStockFinancialStatements...]");
  const financialData = await fetchData("TaiwanStockFinancialStatements", "2023-01-01");

  if (financialData) {
    // Debug: Print unique types found in the data
    const uniqueTypes = [...new Set(financialData.map(d => d.type))];
    console.log(`  DEBUG: Types found in response: ${JSON.stringify(uniqueTypes)}`);
    if (financialData.length > 0) {
      console.log(`  DEBUG: First record keys: ${Object.keys(financialData[0])}`);
    }

    const cashFlow = financialData.filter((d) => d.type === "CashFlow");
    const income = financialData.filter((d) => d.type === "ComprehensiveIncome");

    console.log(`\n[Financial Statements]`);
    console.log(`- Cash Flow Records: ${cashFlow.length}`);
    console.log(`- Income Statement Records: ${income.length}`);
  } else {
    console.log("❌ Failed to fetch Financial Statements");
  }

  // 1.5 Check Cash Flows Statement Specific Endpoint
  console.log("\n[Checking TaiwanStockCashFlowsStatement directly...]");
  const cfData = await fetchData("TaiwanStockCashFlowsStatement", "2023-01-01");
  if (cfData && cfData.length > 0) {
    console.log(`- Records found: ${cfData.length}`);
    console.log(`- Sample Keys: ${Object.keys(cfData[0])}`);
    // Check for CapEx
    console.log(`- Sample Data: ${JSON.stringify(cfData[0], null, 2)}`);
  } else {
    console.log("❌ Failed to fetch TaiwanStockCashFlowsStatement");
  }

  // 2. Check Dividend Data (For Dividend Analysis)
  const dividendData = await fetchData("TaiwanStockDividend", "2020-01-01");
  if (dividendData) {
    console.log(`\n[Dividend Data]`);
    console.log(`- Records found: ${dividendData.length}`);
    console.log("  Sample Data:", JSON.stringify(dividendData[0], null, 2));
  } else {
    console.log("❌ Failed to fetch Dividend Data");
  }

  // 3. Check Price (For Valuation)
  const priceData = await fetchData("TaiwanStockPrice", "2024-01-01");
  if (priceData) {
    console.log(`\n[Stock Price]`);
    console.log(`- Latest Price Record: ${priceData[priceData.length - 1].close}`);
  } else {
    console.log("❌ Failed to fetch Stock Price");
  }

  // 4. Check PER/PBR (For Relative Valuation)
  const perData = await fetchData("TaiwanStockPER", "2024-01-01");
  if (perData) {
    console.log(`\n[PER/PBR]`);
    console.log(`- Latest PER: ${perData[perData.length - 1].PER}`);
    console.log(`- Latest PBR: ${perData[perData.length - 1].PBR}`);
  }
}

verify();
