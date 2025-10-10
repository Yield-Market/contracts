require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
const fs = require("fs");
const path = require("path");

// Function to load markets from markets.json
function loadMarketsFromJson() {
  try {
    const marketsPath = path.join(__dirname, "markets.json");
    const marketsData = fs.readFileSync(marketsPath, "utf8");
    return JSON.parse(marketsData);
  } catch (error) {
    console.error("Error loading markets.json:", error.message);
    return [];
  }
}

module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.19",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      {
        version: "0.8.23",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    ],
  },
  networks: {
    hardhat: {
      chainId: 1337,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        count: 20,
        accountsBalance: "10000000000000000000000", // 10,000 ETH per account
      },
      initialBaseFeePerGas: 0,
      // Polygon mainnet forking configuration
      forking: {
        url: process.env.POLYGON_RPC_URL || "https://rpc.ankr.com/polygon",
        blockNumber: 76396017,
        enabled: false, // Disable forking for local testing
      },
      // Configure hardfork history for Polygon
      chains: {
        137: {
          hardforkHistory: {
            "byzantium": 0,
            "constantinople": 0,
            "petersburg": 0,
            "istanbul": 3395000,
            "berlin": 14750000,
            "london": 23850000,
          }
        }
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 1337,
    },
    polygonFork: {
      url: "http://127.0.0.1:8545",
      chainId: 137,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        accountsBalance: "10000000000000000000000",
      },
      forking: {
        url: process.env.POLYGON_RPC_URL || "https://rpc.ankr.com/polygon",
        enabled: false, // Disable forking for local testing
      },
      chains: {
        137: {
          hardforkHistory: {
            "byzantium": 0,
            "constantinople": 0,
            "petersburg": 0,
            "istanbul": 3395000,
            "berlin": 14750000,
            "london": 23850000,
          }
        }
      },
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 120000, // 2 minutes for fork operations
  },
  // Add markets configuration
  markets: loadMarketsFromJson(),
};
