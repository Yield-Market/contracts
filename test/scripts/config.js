// Shared configuration for test-only scripts (local fork usage only)

// Load environment variables
require('dotenv').config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

// CTF ABI for querying events
const CTF_ABI = [
  "event PositionSplit(address indexed stakeholder, address collateralToken, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint[] partition, uint amount)"
];

// Function to load markets from markets.json
function loadMarketsFromJson() {
  try {
    const marketsPath = path.join(__dirname, "../../markets.json");
    const marketsData = fs.readFileSync(marketsPath, "utf8");
    return JSON.parse(marketsData);
  } catch (error) {
    console.error("Error loading markets.json:", error.message);
    return [];
  }
}

// Get the correct collateral token by querying CTF PositionSplit events
async function getCollateralTokenFromEvents(conditionId) {
  try {
    const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // Polygon CTF
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, ethers.provider);
    
    // Query PositionSplit events for this condition
    const filter = ctf.filters.PositionSplit(null, null, null, conditionId);
    const events = await ctf.queryFilter(filter, 0, "latest");
    
    if (events.length > 0) {
      // Use collateral token from the first PositionSplit event
      const collateralToken = events[0].args.collateralToken;
      console.log(`Found collateral token for condition ${conditionId}: ${collateralToken}`);
      return collateralToken;
    } else {
      console.log(`No PositionSplit events found for condition ${conditionId}, using default USDC`);
      return "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Default to USDC
    }
  } catch (error) {
    console.error(`Error querying collateral token for ${conditionId}:`, error.message);
    return "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Fallback to USDC
  }
}

// Transform markets.json data to match expected format for deployment scripts
// Note: This function is now async due to event querying
async function transformMarketData(market) {
  const collateralToken = await getCollateralTokenFromEvents(market.condition_id);
  
  return {
    id: market.id,
    conditionId: market.condition_id,
    questionId: market.question_id,
    // Use the actual collateral token from CTF events
    collateralToken: collateralToken,
    ymVaultAddress: market.vault_address || "0x0000000000000000000000000000000000000000",
    // Use position IDs from markets.json (these are the correct CTF position IDs)
    yesPositionId: market.clob_token_id_yes,
    noPositionId: market.clob_token_id_no,
    yieldStrategy: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Aave v3 Pool on Polygon
    question: market.question,
    status: market.status,
    active: market.active,
    closed: market.closed,
    tickSize: market.clob_tick_size,
    negRisk: market.clob_neg_risk,
    enableOrderBook: market.enable_order_book
  };
}

// Get the correct collateral token by querying CTF PositionSplit events

module.exports = {
  // Polygon mainnet addresses (used on forks)
  POLYGON: {
    USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    CTF: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
    AUSDC: "0x625E7708f30cA75bfd92586e17077590C60eb4cD",
  },
  // Known whales for funding on forks (do NOT use on mainnet)
  WHALES: {
    USDC: "0xe7804c37c13166fF0b37F5aE0BB07A3aEbb6e245",
  },
  // Local/fork allowed chainIds
  LOCAL_CHAIN_IDS: [1337, 31337],
  // Test config (set to string addresses or values as needed)
  TEST: {
    USDC_RECEIVER: null,     // if null, first local signer will be used
    YES_RECEIVER: "0xD2e818b5d645742B2ffE671F0ABBDEe1478464BF",      // if null, first local signer will be used
    NO_RECEIVER: "0xD2e818b5d645742B2ffE671F0ABBDEe1478464BF",       // if null, first local signer will be used
    USDC_AMOUNT: "100",    // default USDC amount for scripts

    // Defaults for send_position_token.js
    POSITION_SIDE: "YES",   // deprecated (script auto-handles both sides)
    TRANSFER_AMOUNT: 1000,   // string integer in 6-dec units; null means full balance
    PRIVATE_KEY: process.env.TEST_PRIVATE_KEY,        // hex private key for signing txs in scripts (0x...) - loaded from .env file
  },
  // Single market definition used by test scripts
  // MARKET: {
  //   id: "btc-above-100k-till-2025-end",
  //   conditionId: "0xa76a7ecac374e7e37f9dd7eacda947793f23d2886ffe0dc28fcc081a7f61423c",
  //   questionId: "0x9f2c4f3d3a5e6b1e2c3d4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8", // Optional; used for CTF resolution
  //   collateralToken: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  //   ymVaultAddress: "0xac10F0c144D987c5Ef9d30eceF1330323d8e5C47",
  //   yesPositionId: "38880531420851293294206408195662191626124315938743706007994446557347938404169",
  //   noPositionId: "8902773313329801867635874809325551791076524253457589174917607919810586320674",
  //   yieldStrategy: "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
  // },

  // Additional markets from frontend config (commented out for reference)
  // MARKET: {
  //   id: "ethereum-all-time-high-by-september-30",
  //   conditionId: "0x20d4f65ffc90fdea0332de4737411388e89d5fd37572d124b42f64427424d01e",
  //   collateralToken: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  //   ymVaultAddress: "0x8ffd58163cFB4a4CFABE02dceb2F8f320F257f04",
  //   yesPositionId: "71287908215328385101243686516545514858979037224060325310874110368820268322602",
  //   noPositionId: "73577829751434584490325969575598204407858161556711771005899527705770966560534",
  //   yieldStrategy: "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
  // },

  // MARKET: {
  //   id: "dogecoin-all-time-high-before-2026",
  //   conditionId: "0x94f3b700e10d974d9b571b6c98e6fb658ce69cbcfcf57f8d54ff800d3a2a0f19",
  //   collateralToken: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  //   ymVaultAddress: "0xfc6FCe7bC9BF56b3eCcB059613B0ad6DeA4589A4",
  //   yesPositionId: "15039659828541293785211004728324821300190016086130262041626710325455209031990",
  //   noPositionId: "81204160537787845181699193749235809600864273503816425834349855505215440863165",
  //   yieldStrategy: "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
  // },

  // MARKET: {
  //   id: "will-trump-pardon-changpeng-zhao-by-september-30",
  //   conditionId: "0x87d40b8131f2720d90235d8fa8e94b3acba8671b5bf94f6a48a3366684220bda",
  //   collateralToken: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  //   ymVaultAddress: "0x5EB95143420B3ec603B4d1EC91029a604A44e143",
  //   yesPositionId: "64198885426011547532599716642543176190216105584458400729471673552804291327648",
  //   noPositionId: "106791290077455579039045683723549617186440013815866034029690507361228666394818",
  //   yieldStrategy: "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
  // },

  // MARKET: {
  //   id: "hyperliquid-daily-fees-above-8m-in-2025",
  //   conditionId: "0x8eff77c559ceb1141d32741d418b923b613b84d5a6e701d22466bb374b20156a",
  //   collateralToken: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  //   ymVaultAddress: "0x6eDF5B6Bbf2A3677aC827FA565dcB805c624E2Cc",
  //   yesPositionId: "97257759985013402617661559388768149128799929108374480474885228293016665796689",
  //   noPositionId: "88747915775193520968087293930277588686308934898905310163489992909007647305232",
  //   yieldStrategy: "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
  // },
  
  // Load markets from markets.json and get all markets or specific market
  getAllMarkets: async function() {
    const rawMarkets = loadMarketsFromJson();
    const transformedMarkets = [];
    
    for (const market of rawMarkets) {
      const transformed = await transformMarketData(market);
      transformedMarkets.push(transformed);
    }
    
    return transformedMarkets;
  },
  
  getMarketById: async function(marketId) {
    const rawMarkets = loadMarketsFromJson();
    const market = rawMarkets.find(m => m.id === marketId);
    return market ? await transformMarketData(market) : null;
  },
  
  // For backward compatibility, you can still use MARKET for single market deployment
  // MARKET: transformMarketData(loadMarketsFromJson()[0] || {}),
};


