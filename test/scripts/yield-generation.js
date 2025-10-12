/*
 Core logic extracted from test/07-yield-generation.test.js
 - Reads market from markets.json (specify MARKET_ID env var)
 - Advances time to simulate yield accrual on a Polygon fork
 - Prints vault yield status, aUSDC totals, and simple yield analysis

 Usage (recommended on Polygon fork):
   export POLYGON_RPC_URL="https://rpc.ankr.com/polygon"
   npx hardhat node --fork $POLYGON_RPC_URL --chain-id 137 &
   # Required: export MARKET_ID=588fa06c-fb08-4eb4-87c3-eda1b33704c8
   npx hardhat run scripts/yield-generation.js --network localhost
*/

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { POLYGON } = require("./config");
const config = require("./config");

const POLYGON_ADDRESSES = {
  AUSDC: POLYGON.AUSDC,
};


const aTokenABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
];

async function main() {
  // Get market from environment variable
  const targetMarketId = process.env.MARKET_ID;
  if (!targetMarketId) {
    throw new Error("MARKET_ID environment variable is required");
  }
  
  const market = await config.getMarketById(targetMarketId);
  if (!market) {
    throw new Error(`Market with ID ${targetMarketId} not found in markets.json`);
  }
  
  const ymVaultAddress = market.ymVaultAddress;
  if (!ymVaultAddress || ymVaultAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error(`Market ${targetMarketId} does not have a deployed vault address`);
  }
  
  console.log(`Testing yield generation for market: ${market.question}`);
  console.log(`Market ID: ${targetMarketId}`);
  console.log(`Vault address: ${ymVaultAddress}`);
  
  const chain = await ethers.provider.getNetwork();

  const [deployer, userA, userB, userC] = await ethers.getSigners();

  const ymVault = await ethers.getContractAt("YMVault", ymVaultAddress);
  const aToken = new ethers.Contract(POLYGON_ADDRESSES.AUSDC, aTokenABI, deployer);

  console.log("Using:");
  console.log(`- YMVault: ${ymVaultAddress}`);
  console.log(`- aUSDC:   ${POLYGON_ADDRESSES.AUSDC}`);

  // Step 1: Initial yield status
  const initialBlock = await ethers.provider.getBlock("latest");
  const initialTimestamp = initialBlock.timestamp;
  console.log(`\nInitial timestamp: ${initialTimestamp} (${new Date(Number(initialTimestamp) * 1000).toISOString()})`);

  const initialYieldStatus = await ymVault.getYieldStatus();
  console.log("\nInitial Yield Status:");
  console.log(`- Total aTokens:    ${ethers.formatUnits(initialYieldStatus.totalATokens, 6)}`);
  console.log(`- Total Collateral: ${ethers.formatUnits(initialYieldStatus.totalCollateral, 6)}`);
  console.log(`- Accrued Yield:    ${ethers.formatUnits(initialYieldStatus.accruedYield, 6)}`);

  // Step 2: Advance time by 30 days
  const timeAdvance = 30 * 24 * 60 * 60;
  console.log(`\nAdvancing time by ${timeAdvance / (24 * 60 * 60)} days...`);
  await network.provider.send("evm_increaseTime", [timeAdvance]);
  await network.provider.send("evm_mine");

  const newBlock = await ethers.provider.getBlock("latest");
  const newTimestamp = newBlock.timestamp;
  console.log(`New timestamp: ${newTimestamp} (${new Date(Number(newTimestamp) * 1000).toISOString()})`);
  console.log(`Time advanced by: ${(newTimestamp - initialTimestamp) / (24 * 60 * 60)} days`);

  // Step 3: Current yield status
  const yieldStatus = await ymVault.getYieldStatus();
  console.log("\nCurrent Yield Status:");
  console.log(`- Total aTokens:    ${ethers.formatUnits(yieldStatus.totalATokens, 6)}`);
  console.log(`- Total Collateral: ${ethers.formatUnits(yieldStatus.totalCollateral, 6)}`);
  console.log(`- Accrued Yield:    ${ethers.formatUnits(yieldStatus.accruedYield, 6)}`);

  // Step 4: AAVE aToken checkpoints
  try {
    const aTokenTotalSupply = await aToken.totalSupply();
    console.log(`\naUSDC Total Supply: ${ethers.formatUnits(aTokenTotalSupply, 6)}`);
  } catch (e) {
    console.log(`Warning: could not read aUSDC totalSupply: ${e.message}`);
  }

  try {
    const vaultATokenBalance = await aToken.balanceOf(ymVaultAddress);
    console.log(`Vault aUSDC Balance: ${ethers.formatUnits(vaultATokenBalance, 6)}`);
  } catch (e) {
    console.log(`Warning: could not read vault aUSDC balance: ${e.message}`);
  }

  // Step 5: Yield accrual quick analysis
  const totalYesDeposits = await ymVault.totalYesDeposits();
  const totalNoDeposits = await ymVault.totalNoDeposits();
  const totalMatched = await ymVault.totalMatched();
  const totalYielding = await ymVault.totalYielding();

  console.log("\nVault State Analysis:");
  console.log(`- Total YES Deposits: ${ethers.formatUnits(totalYesDeposits, 6)}`);
  console.log(`- Total NO Deposits:  ${ethers.formatUnits(totalNoDeposits, 6)}`);
  console.log(`- Total Matched:      ${ethers.formatUnits(totalMatched, 6)}`);
  console.log(`- Total Yielding:     ${ethers.formatUnits(totalYielding, 6)}`);

  if (Number(totalYielding) > 0) {
    const rate = Number(yieldStatus.accruedYield) / Math.max(1, Number(yieldStatus.totalCollateral));
    console.log(`- Yield Rate (approx): ${(rate * 100).toFixed(4)}%`);
  } else {
    console.log("- No yielding positions yet");
  }

  // Step 6: Additional time advance (15 days)
  const more = 15 * 24 * 60 * 60;
  console.log(`\nAdvancing additional ${more / (24 * 60 * 60)} days...`);
  await network.provider.send("evm_increaseTime", [more]);
  await network.provider.send("evm_mine");
  const nb = await ethers.provider.getBlock("latest");
  console.log(`New timestamp: ${nb.timestamp} (${new Date(Number(nb.timestamp) * 1000).toISOString()})`);

  // Step 7: Expected yield illustration (not on-chain)
  const principal = ethers.parseUnits("100", 6);
  const annualRate = 0.05;
  const totalDays = 45;
  const timeInYears = totalDays / 365;
  const expectedYield = Math.floor(
    parseFloat(ethers.formatUnits(principal, 6)) * annualRate * timeInYears * 1e6,
  );
  console.log("\nExpected Yield (illustrative):");
  console.log(`- Principal: ${ethers.formatUnits(principal, 6)} USDC`);
  console.log(`- Annual Rate: ${(annualRate * 100).toFixed(2)}%`);
  console.log(`- Period: ${totalDays} days (${timeInYears.toFixed(4)} years)`);
  console.log(`- Expected Yield: ${ethers.formatUnits(expectedYield, 6)} USDC`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


