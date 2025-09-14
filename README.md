# YM Contracts

Yield-Enhanced Prediction Market Vaults (YM). This package contains the core smart contract (`YMVault.sol`) plus developer scripts and tests to reproduce the vault workflow against a Polygon mainnet fork.

## Contents

- `contracts/YMVault.sol`: Core vault that accepts Polymarket outcome tokens (YES/NO), internally matches pairs, merges into USDC, supplies to Aave, and pays winners principal + yield.
- `test/`: Unit and integration tests, plus test-only scripts under `test/scripts/` for local-fork workflows.
- `hardhat.config.js`: Hardhat configuration (viaIR + optimizer, Polygon fork support).

## Contract Overview

`YMVault` implements:

- ERC1155 Receiver: users can directly `safeTransferFrom` YES/NO position tokens to the vault; the vault credits YES.Y/NO.Y internal balances.
- Matching & Merge: matches YES/NO equally, merges into USDC via ConditionalTokens, and supplies USDC to Aave to earn yield.
- Resolution & Payouts:
  - Reads final payouts from ConditionalTokens.
  - On `withdraw()`, if the market is not resolved yet, it auto-resolves once and finalizes yield.
  - Payouts are proportional to `aToken.balanceOf(vault)` based on user share of the winning side.
  - Withdrawal amount is capped by currently available underlying to avoid over-withdrawals/DoS.

Key external dependencies (addresses must be correct for your network/fork):

- ConditionalTokens (Polymarket/Gnosis CTF)
- Aave v3 Pool (Polygon)
- aUSDC (Polygon)

## Requirements

- Node.js 18+
- npm 9+
- Hardhat 2.22+

## Installation

```bash
npm install --legacy-peer-deps
```

## Environment Setup

Before running the project, you need to configure environment variables:

1. Copy the environment template:
```bash
cp .env.example .env
```

2. Edit `.env` file and fill in your values:
```bash
# Test Private Key for local development and testing
TEST_PRIVATE_KEY=0x263fbdbfa1a0767d8da53f1a0cd9e5df86f4dfc7058b121b9f2f0ffe12bebe96

# Polygon RPC URL for forking and testing
POLYGON_RPC_URL=https://polygon-mainnet.infura.io/v3/YOUR_API_KEY
```

**Security Note**: The `.env` file contains sensitive information and is automatically ignored by git. Never commit this file to version control.

## Build / Compile

```bash
npm run compile
```

## Local Fork Quick Start

```bash
export POLYGON_RPC_URL="https://polygon-mainnet.infura.io/v3/<YOUR_KEY>"
npx hardhat node --fork $POLYGON_RPC_URL --fork-block-number 76000000
```

### Test-Only Scripts (local fork ONLY)

All scripts in `test/scripts/` are guarded and require:

- `ALLOW_TEST_SCRIPTS=true`
- Running on chainId 1337/31337 (local hardhat or fork)

Shared configuration is centralized in `test/scripts/config.js`:

- `POLYGON`: USDC/CTF/aUSDC mainnet addresses (used on forks)
- `MARKET`: single market object (conditionId, positionIds, yield strategy)
- `TEST`: test addresses and amounts (USDC_RECEIVER, YES_RECEIVER, NO_RECEIVER, USDC_AMOUNT)

Available commands (examples):

```bash
# Deploy YMVault for MARKET
ALLOW_TEST_SCRIPTS=true npx hardhat run test/scripts/deploy-ym-vaults.js --network localhost

# Fund a receiver with USDC from a whale
ALLOW_TEST_SCRIPTS=true npx hardhat run test/scripts/get-usdc.js --network localhost

# Split USDC into YES/NO outcome tokens and transfer
ALLOW_TEST_SCRIPTS=true npx hardhat run test/scripts/split-and-transfer.js --network localhost
```

## NPM Scripts

```bash
npm run compile            # hardhat compile
npm run test               # hardhat test
npm run node               # hardhat node
npm run console            # hardhat console
npm run clean              # hardhat clean
npm run coverage           # solidity-coverage
npm run typechain          # typechain

# Local-fork helpers (under scripts/)
npm run deploy:vaults      # deploy YMVault(s) on localhost
npm run yield              # simulate yield (read-only)
npm run market:resolve     # resolve market + vault (read-only helper)
npm run get:usdc           # fund receiver with USDC (if present in scripts/)
```

## Testing

```bash
npm run test
```

Unit/integration tests cover vault accounting, matching/merging, resolution, and withdrawal math (including loser-path behavior). See `test/WithdrawalPayoutTest.js` and `test/PolygonIntegrationTest.js`.

## Security

- **Private Key Security**: Private keys are now loaded from environment variables (`.env` file) instead of being hardcoded. The `.env` file is automatically ignored by git to prevent accidental commits of sensitive information.
- Do not expose private keys or mnemonics in code or docs. Use environment variables or Hardhat accounts.
- Test scripts impersonate whales and modify state via Hardhat JSON-RPC methods; they are strictly for local forks. Never run them on mainnet.
- External dependencies (CTF/Aave/aUSDC) are trusted contracts; verify addresses before deployment.
- `withdraw()` uses proportional payouts based on `aToken.balanceOf(vault)` with a cap at available underlying and auto-resolution if needed.

If you find a security issue, please open an issue or contact maintainers privately.

## License

MIT
