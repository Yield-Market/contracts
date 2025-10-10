# YM Contracts

![Build](https://img.shields.io/github/actions/workflow/status/Yield-Market/contracts/slither.yml?branch=main)
![License](https://img.shields.io/github/license/Yield-Market/contracts)
![Last Commit](https://img.shields.io/github/last-commit/Yield-Market/contracts)

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
- Supports both regular USDC and Polymarket's WrappedCollateral (WCOL) tokens

## Requirements

- Node.js 18+
- npm 9+
- Hardhat 2.22+

## Market Configuration & Deployment

Markets are configured in `markets.json` with support for multi-market vault deployment.

### Quick Start

1. **Start local hardhat node:**
   ```bash
   npx hardhat node --chain-id 1337
   ```

2. **Deploy vaults:**
   ```bash
   # Deploy all markets
   ALLOW_TEST_SCRIPTS=true npx hardhat run test/scripts/deploy-ym-vaults.js --network localhost
   
   # Deploy specific market
   MARKET_ID="588fa06c-fb08-4eb4-87c3-eda1b33704c8" ALLOW_TEST_SCRIPTS=true npx hardhat run test/scripts/deploy-ym-vaults.js --network localhost
   
   # Reuse existing factory (saves gas)
   FACTORY_ADDRESS=0x... IMPL_ADDRESS=0x... ALLOW_TEST_SCRIPTS=true npx hardhat run test/scripts/deploy-ym-vaults.js --network localhost
   ```

3. **Use interactive deployment:**
   ```bash
   ./deploy-vaults.sh
   ```

### Factory Optimization

YMVaultFactory and implementation are deployed **once** and reused for all markets, optimizing gas costs and ensuring consistency.

### Wrapped Collateral Support

The vault automatically detects and handles Polymarket's WrappedCollateral (WCOL) tokens:
- **Regular USDC markets**: Collateral is supplied directly to AAVE
- **Wrapped USDC markets**: Collateral is unwrapped to USDC before supplying to AAVE
- **Automatic detection**: No manual configuration needed

Position IDs are calculated using the correct collateral token (wrapped or unwrapped) as specified in the CTF contract.

### Environment Variables

- `ALLOW_TEST_SCRIPTS=true`: Required for test scripts
- `MARKET_ID`: Target specific market by ID
- `FACTORY_ADDRESS`/`IMPL_ADDRESS`: Reuse existing contracts
- `UPDATE_MARKETS_JSON=true`: Update markets.json with deployed addresses

### Testing Market Functionality

```bash
# Test specific market (requires MARKET_ID)
MARKET_ID="market-id" ALLOW_TEST_SCRIPTS=true npx hardhat run test/scripts/split-and-transfer.js --network localhost
MARKET_ID="market-id" ALLOW_TEST_SCRIPTS=true npx hardhat run test/scripts/yield-generation.js --network localhost
MARKET_ID="market-id" ALLOW_TEST_SCRIPTS=true npx hardhat run test/scripts/market-resolve.js --network localhost
```
