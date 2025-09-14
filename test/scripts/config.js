// Shared configuration for test-only scripts (local fork usage only)

// Load environment variables
require('dotenv').config();

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
    YES_RECEIVER: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",      // if null, first local signer will be used
    NO_RECEIVER: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",       // if null, first local signer will be used
    USDC_AMOUNT: "1000",    // default USDC amount for scripts

    // Defaults for send_position_token.js
    POSITION_SIDE: "YES",   // deprecated (script auto-handles both sides)
    TRANSFER_AMOUNT: 1000,   // string integer in 6-dec units; null means full balance
    PRIVATE_KEY: process.env.TEST_PRIVATE_KEY,        // hex private key for signing txs in scripts (0x...) - loaded from .env file
  },
  // Single market definition used by test scripts
  MARKET: {
    id: "will-ethereum-reach-5200-in-september",
    conditionId: "0xf8a33b3f58a7d0d654956706f5a61d0357b6bdd4ad36d7b4f407ce69ea4d367a",
    collateralToken: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    ymVaultAddress: "0xF2C003B74C0b67E6ad94680Ca14c37e65FC6CC29",
    yesPositionId: "103876993696082015861066702475715382351460866745353292325352058543913353423996",
    noPositionId: "66791453988360573698055776507286198215418878555761749237780394013860292613668",
    yieldStrategy: "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
  },
};


