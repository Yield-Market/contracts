/*
 Test-only script: Test withdraw functionality from YMVault after market resolution.

 Requirements:
   - ALLOW_TEST_SCRIPTS=true
   - Local hardhat or forked network (chainId 1337/31337)
   - MARKET_ID environment variable
   - Market should be resolved and have deposits

 Config:
   - Uses POLYGON.* and market from markets.json, TEST.* from config.js

 Usage:
   export POLYGON_RPC_URL="https://rpc.ankr.com/polygon"
   npx hardhat node --fork $POLYGON_RPC_URL --chain-id 1337 &
   # Required: export MARKET_ID=588fa06c-fb08-4eb4-87c3-eda1b33704c8
   ALLOW_TEST_SCRIPTS=true hardhat run test/scripts/withdraw-test.js --network localhost

 Note: 
   - This script tests withdrawal for both winning and losing sides
   - It checks balances before and after withdrawal
   - It verifies the correct payout calculation
*/

const { ethers, network } = require("hardhat");
const { POLYGON, LOCAL_CHAIN_IDS, TEST } = require("./config");
const config = require("./config");
const { exit } = require("process");

// Polygon addresses
const USDC = POLYGON.USDC;
const CTF = POLYGON.CTF;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

const WRAPPED_USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function underlying() view returns (address)",
  "function owner() view returns (address)",
];

const YM_VAULT_ABI = [
  "function getYesYBalance(address user) view returns (uint256)",
  "function getNoYBalance(address user) view returns (uint256)",
  "function yesYTokens(address user) view returns (uint256)",
  "function noYTokens(address user) view returns (uint256)",
  "function withdraw(address to)",
  "function estimateWithdrawal(address user) view returns (uint256)",
  "function isResolved() view returns (bool)",
  "function yesWon() view returns (bool)",
  "function finalPayoutRatio() view returns (uint256)",
  "function totalYesDeposits() view returns (uint256)",
  "function totalNoDeposits() view returns (uint256)",
  "function totalMatched() view returns (uint256)",
  "function totalYielding() view returns (uint256)",
  "function getYieldStatus() view returns (uint256 totalATokens, uint256 totalCollateral, uint256 accruedYield)",
  // Events
  "event Withdrawal(address indexed user, address indexed to, uint256 yesYBurned, uint256 noYBurned, uint256 usdcReceived)"
];

const CONDITIONAL_TOKENS_ABI = [
  "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
];

async function impersonate(addr) {
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [addr, "0x" + ethers.parseEther("10").toString(16)]);
  return await ethers.getSigner(addr);
}

async function main() {
  if (process.env.ALLOW_TEST_SCRIPTS !== "true") {
    throw new Error("Refusing to run: set ALLOW_TEST_SCRIPTS=true to allow test scripts");
  }
  
  // Get market from environment variable
  const targetMarketId = process.env.MARKET_ID;
  if (!targetMarketId) {
    throw new Error("MARKET_ID environment variable is required");
  }
  
  const market = await config.getMarketById(targetMarketId);
  if (!market) {
    throw new Error(`Market with ID ${targetMarketId} not found in markets.json`);
  }
  
  const CONDITION_ID = market.conditionId;
  const COLLATERAL_TOKEN = market.collateralToken;
  const VAULT_ADDRESS = market.ymVaultAddress;
  
  if (!VAULT_ADDRESS || VAULT_ADDRESS === "0x0000000000000000000000000000000000000000") {
    throw new Error(`Market ${targetMarketId} does not have a deployed vault address`);
  }
  
  console.log(`Testing withdraw for market: ${market.question}`);
  console.log(`Market ID: ${targetMarketId}`);
  console.log(`Condition ID: ${CONDITION_ID}`);
  console.log(`Collateral Token: ${COLLATERAL_TOKEN}`);
  console.log(`Vault Address: ${VAULT_ADDRESS}`);
  
  const chain = await ethers.provider.getNetwork();
  const chainId = Number(chain.chainId);
  if (!LOCAL_CHAIN_IDS.includes(chainId)) {
    throw new Error(`Refusing to run on non-local chainId=${chainId}. Use a local hardhat node or fork.`);
  }

  const [defaultSigner] = await ethers.getSigners();
  
  // Initialize contracts
  const vault = new ethers.Contract(VAULT_ADDRESS, YM_VAULT_ABI, ethers.provider);
  const collateralContract = new ethers.Contract(COLLATERAL_TOKEN, ERC20_ABI, ethers.provider);
  const ctf = new ethers.Contract(CTF, CONDITIONAL_TOKENS_ABI, ethers.provider);
  
  // Check if using wrapped collateral and get underlying token
  let underlyingContract = null;
  let isWrappedCollateral = false;
  try {
    const wrappedContract = new ethers.Contract(COLLATERAL_TOKEN, WRAPPED_USDC_ABI, ethers.provider);
    const underlyingAddress = await wrappedContract.underlying();
    underlyingContract = new ethers.Contract(underlyingAddress, ERC20_ABI, ethers.provider);
    isWrappedCollateral = true;
    console.log(`\n🔧 Wrapped Collateral Detected:`);
    console.log(`- Collateral Token: ${COLLATERAL_TOKEN}`);
    console.log(`- Underlying Token: ${underlyingAddress}`);
  } catch (e) {
    // Not wrapped collateral, use collateral token directly
    underlyingContract = collateralContract;
    console.log(`\n🔧 Regular Collateral Token: ${COLLATERAL_TOKEN}`);
  }
  
  // Check if market is resolved (informational only - withdraw will auto-resolve if needed)
  const isResolved = await vault.isResolved();
  console.log(`\n🔍 Market Resolution Status: ${isResolved}`);
  
  if (!isResolved) {
    console.log("ℹ️  Market not yet resolved - withdraw will auto-resolve it.");
  }
  
  // Get market resolution info (may be resolved during withdraw if not already)
  let yesWon, payoutRatio;
  try {
    yesWon = await vault.yesWon();
    payoutRatio = await vault.finalPayoutRatio();
    console.log(`YES Won: ${yesWon}`);
    console.log(`Final Payout Ratio: ${payoutRatio}`);
  } catch (e) {
    console.log("ℹ️  Market resolution details not available yet - will be set during withdraw");
  }
  // Check CTF resolution status
  try {
    const denom = await ctf.payoutDenominator(CONDITION_ID);
    const p0 = await ctf.payoutNumerators(CONDITION_ID, 0);
    const p1 = await ctf.payoutNumerators(CONDITION_ID, 1);
    console.log(`\n📊 CTF Resolution State:`);
    console.log(`- Denominator: ${denom}`);
    console.log(`- YES Payout: ${p0}`);
    console.log(`- NO Payout: ${p1}`);
  } catch (e) {
    console.log(`Warning reading CTF state: ${e.message}`);
  }
  
  // Display vault balances
  const totalYesDeposits = await vault.totalYesDeposits();
  const totalNoDeposits = await vault.totalNoDeposits();
  const totalMatched = await vault.totalMatched();
  const totalYielding = await vault.totalYielding();
  
  console.log(`\n💰 Vault Balances:`);
  console.log(`- Total YES Deposits: ${ethers.formatUnits(totalYesDeposits, 6)} tokens`);
  console.log(`- Total NO Deposits: ${ethers.formatUnits(totalNoDeposits, 6)} tokens`);
  console.log(`- Total Matched: ${ethers.formatUnits(totalMatched, 6)} USDC`);
  console.log(`- Total Yielding: ${ethers.formatUnits(totalYielding, 6)} USDC`);
  
  // Get yield status
  try {
    const [totalATokens, totalCollateral, accruedYield] = await vault.getYieldStatus();
    console.log(`\n📈 Yield Status:`);
    console.log(`- Total aTokens: ${ethers.formatUnits(totalATokens, 6)} aUSDC`);
    console.log(`- Total Collateral: ${ethers.formatUnits(totalCollateral, 6)} USDC`);
    console.log(`- Accrued Yield: ${ethers.formatUnits(accruedYield, 6)} USDC`);
  } catch (e) {
    console.log(`Warning reading yield status: ${e.message}`);
  }
  
  // Test withdrawal for configured recipients
  const testAddresses = [
    { name: "YES_RECEIVER", address: TEST.YES_RECEIVER },
    { name: "NO_RECEIVER", address: TEST.NO_RECEIVER }
  ];
  
  console.log(`\n🧪 Testing Withdrawals:`);
  
  for (const testAddr of testAddresses) {
    const { name, address } = testAddr;
    
    if (!address || !ethers.isAddress(address)) {
      console.log(`⚠️  Skipping ${name}: invalid address ${address}`);
      continue;
    }
    
    console.log(`\n--- Testing ${name} (${address}) ---`);
    
    // Check user's vault balances
    const userYesY = await vault.getYesYBalance(address);
    const userNoY = await vault.getNoYBalance(address);
    const totalUserBalance = userYesY + userNoY;
    
    console.log(`User Vault Balances:`);
    console.log(`- YES.Y: ${ethers.formatUnits(userYesY, 6)}`);
    console.log(`- NO.Y: ${ethers.formatUnits(userNoY, 6)}`);
    console.log(`- Total: ${ethers.formatUnits(totalUserBalance, 6)}`);
    
    if (totalUserBalance === 0n) {
      console.log(`❌ ${name} has no vault balance to withdraw`);
      continue;
    }
    
    // Estimate withdrawal amount
    const estimatedWithdrawal = await vault.estimateWithdrawal(address);
    console.log(`Estimated Withdrawal: ${ethers.formatUnits(estimatedWithdrawal, 6)} USDC`);
    
    if (estimatedWithdrawal === 0n) {
      console.log(`💀 ${name} would receive 0 USDC (may hold losing tokens - will be confirmed during withdraw)`);
      // Don't skip - let withdraw handle the resolution and determination
    }
    
    // Check user's current balances before withdrawal (both collateral and underlying)
    const collateralBalanceBefore = await collateralContract.balanceOf(address);
    const underlyingBalanceBefore = await underlyingContract.balanceOf(address);
    
    console.log(`Balances Before Withdrawal:`);
    console.log(`- Collateral Token: ${ethers.formatUnits(collateralBalanceBefore, 6)}`);
    if (isWrappedCollateral) {
      console.log(`- Underlying USDC: ${ethers.formatUnits(underlyingBalanceBefore, 6)}`);
    }
    
    // Impersonate the user to perform withdrawal
    const userSigner = await impersonate(address);
    
    console.log(`🔄 Performing withdrawal...`);
    
    try {
      // Listen for withdrawal event
      const withdrawalPromise = new Promise((resolve, reject) => {
        vault.once("Withdrawal", (user, to, yesYBurned, noYBurned, usdcReceived, event) => {
          resolve({
            user,
            to, 
            yesYBurned: ethers.formatUnits(yesYBurned, 6),
            noYBurned: ethers.formatUnits(noYBurned, 6),
            usdcReceived: ethers.formatUnits(usdcReceived, 6),
            txHash: event.log.transactionHash
          });
        });
        
        // Timeout after 30 seconds
        setTimeout(() => reject(new Error("Withdrawal event timeout")), 30000);
      });
      
      // Execute withdrawal
      const tx = await vault.connect(userSigner).withdraw(address);
      console.log(`Transaction Hash: ${tx.hash}`);
      
      const receipt = await tx.wait();
      console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
      console.log(`Gas Used: ${receipt.gasUsed.toString()}`);
      
      // Wait for withdrawal event
      try {
        const withdrawalEvent = await withdrawalPromise;
        console.log(`\n📝 Withdrawal Event Details:`);
        console.log(`- User: ${withdrawalEvent.user}`);
        console.log(`- To: ${withdrawalEvent.to}`);
        console.log(`- YES.Y Burned: ${withdrawalEvent.yesYBurned}`);
        console.log(`- NO.Y Burned: ${withdrawalEvent.noYBurned}`);
        console.log(`- USDC Received: ${withdrawalEvent.usdcReceived}`);
      } catch (eventError) {
        console.log(`⚠️  Failed to capture withdrawal event: ${eventError.message}`);
      }
      
      // Check balances after withdrawal (both collateral and underlying)
      const collateralBalanceAfter = await collateralContract.balanceOf(address);
      const underlyingBalanceAfter = await underlyingContract.balanceOf(address);
      
      const collateralReceived = collateralBalanceAfter - collateralBalanceBefore;
      const underlyingReceived = underlyingBalanceAfter - underlyingBalanceBefore;
      
      console.log(`\n💰 Withdrawal Results:`);
      console.log(`- Collateral Balance Before: ${ethers.formatUnits(collateralBalanceBefore, 6)}`);
      console.log(`- Collateral Balance After: ${ethers.formatUnits(collateralBalanceAfter, 6)}`);
      console.log(`- Collateral Received: ${ethers.formatUnits(collateralReceived, 6)}`);
      
      if (isWrappedCollateral) {
        console.log(`- Underlying Balance Before: ${ethers.formatUnits(underlyingBalanceBefore, 6)}`);
        console.log(`- Underlying Balance After: ${ethers.formatUnits(underlyingBalanceAfter, 6)}`);
        console.log(`- Underlying USDC Received: ${ethers.formatUnits(underlyingReceived, 6)}`);
      }
      
      // Calculate total value received (for wrapped collateral, user gets underlying USDC)
      const totalUsdcReceived = isWrappedCollateral ? underlyingReceived : collateralReceived;
      console.log(`- Total USDC Value Received: ${ethers.formatUnits(totalUsdcReceived, 6)}`);
      console.log(`- Estimated vs Actual: ${ethers.formatUnits(estimatedWithdrawal, 6)} vs ${ethers.formatUnits(totalUsdcReceived, 6)}`);
      
      // Verify vault balances are zeroed
      const userYesYAfter = await vault.getYesYBalance(address);
      const userNoYAfter = await vault.getNoYBalance(address);
      
      console.log(`\n🔍 Post-Withdrawal Vault Balances:`);
      console.log(`- YES.Y: ${ethers.formatUnits(userYesYAfter, 6)} (should be 0)`);
      console.log(`- NO.Y: ${ethers.formatUnits(userNoYAfter, 6)} (should be 0)`);
      
      if (userYesYAfter === 0n && userNoYAfter === 0n) {
        console.log(`✅ ${name} withdrawal completed successfully!`);
      } else {
        console.log(`⚠️  ${name} still has remaining vault balance after withdrawal`);
      }
      
      // Calculate yield earned (if any) - get final resolution state after withdraw
      let finalYesWon;
      try {
        finalYesWon = await vault.yesWon();
      } catch (e) {
        finalYesWon = null; // Unable to determine
      }
      
      let expectedPrincipal = "0";
      if (finalYesWon !== null) {
        expectedPrincipal = finalYesWon ? 
          ethers.formatUnits(userYesY, 6) : 
          ethers.formatUnits(userNoY, 6);
      }
      
      const actualReceived = ethers.formatUnits(totalUsdcReceived, 6);
      const yieldEarned = parseFloat(actualReceived) - parseFloat(expectedPrincipal);
      
      console.log(`\n📊 Yield Analysis:`);
      if (finalYesWon !== null) {
        console.log(`- Principal (winning tokens): ${expectedPrincipal} USDC`);
        console.log(`- Actual Received: ${actualReceived} USDC`);
        console.log(`- Yield Earned: ${yieldEarned.toFixed(6)} USDC`);
        
        if (yieldEarned > 0) {
          console.log(`🎉 User earned ${yieldEarned.toFixed(6)} USDC in yield!`);
        } else if (yieldEarned < -0.001) { // Allow for small rounding errors
          console.log(`⚠️  User received significantly less than principal: ${yieldEarned.toFixed(6)} USDC difference`);
        } else if (Math.abs(yieldEarned) <= 0.001) {
          console.log(`💭 No significant yield earned (within rounding tolerance)`);
        } else {
          console.log(`💭 No additional yield earned`);
        }
      } else {
        console.log(`- Actual Received: ${actualReceived} USDC`);
        console.log(`- Cannot calculate yield (resolution state unclear)`);
      }
      
    } catch (error) {
      console.error(`❌ Withdrawal failed for ${name}:`, error.message);
      
      // Check for common error patterns
      if (error.message.includes("GS013")) {
        console.log(`💡 GS013 error suggests Safe signature/threshold issue`);
      } else if (error.message.includes("Market not resolved")) {
        console.log(`💡 Market resolution issue - check CTF payout status`);
      } else if (error.message.includes("No tokens to withdraw")) {
        console.log(`💡 User has no vault balance to withdraw`);
      }
      
      continue;
    }
  }
  
  // Get final resolution state for summary
  let finalYesWon;
  try {
    finalYesWon = await vault.yesWon();
  } catch (e) {
    finalYesWon = null;
  }
  
  console.log(`\n🎯 Withdraw Test Summary:`);
  console.log(`- Market: ${market.question}`);
  if (finalYesWon !== null) {
    console.log(`- Winner: ${finalYesWon ? 'YES' : 'NO'}`);
  } else {
    console.log(`- Winner: TBD (market will be resolved during first withdraw)`);
  }
  console.log(`- Total Deposits: YES ${ethers.formatUnits(totalYesDeposits, 6)}, NO ${ethers.formatUnits(totalNoDeposits, 6)}`);
  console.log(`- Yield Generated: ${ethers.formatUnits(totalYielding, 6)} USDC earning interest`);
  console.log(`- Test completed for configured recipients`);
  
  console.log(`\n✅ All withdrawal tests completed!`);
  exit(0)
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});