/*
 Test-only script: Test deposit functionality by transferring half of YES/NO tokens to YMVault.

 Requirements:
   - ALLOW_TEST_SCRIPTS=true
   - Local hardhat or forked network (chainId 1337/31337)
   - MARKET_ID environment variable
   - YES/NO tokens should exist from previous split-and-transfer.js

 Config:
   - Uses POLYGON.* and market from markets.json, TEST.* from config.js

 Usage:
   export POLYGON_RPC_URL="https://rpc.ankr.com/polygon"
   npx hardhat node --fork $POLYGON_RPC_URL --chain-id 1337 &
   # Required: export MARKET_ID=588fa06c-fb08-4eb4-87c3-eda1b33704c8
   ALLOW_TEST_SCRIPTS=true hardhat run test/scripts/deposit-test.js --network localhost

 Note: 
   - This script deposits half of the YES/NO tokens from TEST.YES_RECEIVER/NO_RECEIVER to the vault
   - It checks balances before and after deposit
   - It verifies the vault correctly handles the deposits
*/

const { ethers, network } = require("hardhat");
const { POLYGON, LOCAL_CHAIN_IDS, TEST } = require("./config");
const config = require("./config");

// Polygon addresses
const USDC = POLYGON.USDC;
const CTF = POLYGON.CTF;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

const YM_VAULT_ABI = [
  "function getYesYBalance(address user) view returns (uint256)",
  "function getNoYBalance(address user) view returns (uint256)",
  "function yesYTokens(address user) view returns (uint256)",
  "function noYTokens(address user) view returns (uint256)",
  "function totalYesDeposits() view returns (uint256)",
  "function totalNoDeposits() view returns (uint256)",
  "function totalMatched() view returns (uint256)",
  "function totalYielding() view returns (uint256)",
  "function getYieldStatus() view returns (uint256 totalATokens, uint256 totalCollateral, uint256 accruedYield)",
  "function isResolved() view returns (bool)",
  "function conditionId() view returns (bytes32)",
  "function yesPositionId() view returns (uint256)",
  "function noPositionId() view returns (uint256)",
  "function isWrappedCollateral() view returns (bool)",
  // Events
  "event YesTokenDeposited(address indexed user, uint256 amount, uint256 yesYMinted)",
  "event NoTokenDeposited(address indexed user, uint256 amount, uint256 noYMinted)",
  "event PositionsMatched(uint256 amount, uint256 usdcGenerated)",
  "event YieldDeposited(uint256 amount, uint256 aTokensReceived)"
];

const CTF_ABI = [
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
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
  
  console.log(`Testing deposit for market: ${market.question}`);
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
  const ctf = new ethers.Contract(CTF, CTF_ABI, ethers.provider);
  
  // Get vault configuration
  const vaultConditionId = await vault.conditionId();
  const yesPositionId = await vault.yesPositionId();
  const noPositionId = await vault.noPositionId();
  const isWrappedCollateral = await vault.isWrappedCollateral();
  
  console.log(`\n🔧 Vault Configuration:`);
  console.log(`- Condition ID: ${vaultConditionId}`);
  console.log(`- YES Position ID: ${yesPositionId}`);
  console.log(`- NO Position ID: ${noPositionId}`);
  console.log(`- Is Wrapped Collateral: ${isWrappedCollateral}`);
  
  // Verify condition ID matches
  if (vaultConditionId.toLowerCase() !== CONDITION_ID.toLowerCase()) {
    throw new Error(`Vault condition ID ${vaultConditionId} does not match market condition ID ${CONDITION_ID}`);
  }
  
  // Check initial vault state
  const isResolved = await vault.isResolved();
  console.log(`\n📊 Initial Vault State:`);
  console.log(`- Is Resolved: ${isResolved}`);
  
  if (isResolved) {
    console.log("⚠️  Warning: Market is already resolved. Deposits may not be accepted.");
  }
  
  // Get initial vault balances
  const initialTotalYes = await vault.totalYesDeposits();
  const initialTotalNo = await vault.totalNoDeposits();
  const initialMatched = await vault.totalMatched();
  const initialYielding = await vault.totalYielding();
  
  console.log(`\n💰 Initial Vault Balances:`);
  console.log(`- Total YES Deposits: ${ethers.formatUnits(initialTotalYes, 6)}`);
  console.log(`- Total NO Deposits: ${ethers.formatUnits(initialTotalNo, 6)}`);
  console.log(`- Total Matched: ${ethers.formatUnits(initialMatched, 6)}`);
  console.log(`- Total Yielding: ${ethers.formatUnits(initialYielding, 6)}`);
  
  // Test deposits for configured addresses
  const testAddresses = [
    { name: "YES_RECEIVER", address: TEST.YES_RECEIVER, preferredToken: "YES" },
    { name: "NO_RECEIVER", address: TEST.NO_RECEIVER, preferredToken: "NO" }
  ];
  
  console.log(`\n🧪 Testing Deposits:`);
  
  for (const testAddr of testAddresses) {
    const { name, address, preferredToken } = testAddr;
    
    if (!address || !ethers.isAddress(address)) {
      console.log(`⚠️  Skipping ${name}: invalid address ${address}`);
      continue;
    }
    
    console.log(`\n--- Testing ${name} (${address}) ---`);
    
    // Check user's current conditional token balances
    const yesBalance = await ctf.balanceOf(address, yesPositionId);
    const noBalance = await ctf.balanceOf(address, noPositionId);
    
    console.log(`User Conditional Token Balances:`);
    console.log(`- YES: ${ethers.formatUnits(yesBalance, 6)}`);
    console.log(`- NO: ${ethers.formatUnits(noBalance, 6)}`);
    
    if (yesBalance === 0n && noBalance === 0n) {
      console.log(`❌ ${name} has no conditional tokens to deposit`);
      continue;
    }
    
    // Check current vault balances for this user
    const currentYesY = await vault.getYesYBalance(address);
    const currentNoY = await vault.getNoYBalance(address);
    
    console.log(`Current Vault Balances:`);
    console.log(`- YES.Y: ${ethers.formatUnits(currentYesY, 6)}`);
    console.log(`- NO.Y: ${ethers.formatUnits(currentNoY, 6)}`);
    
    // Determine which tokens to deposit (half of each available)
    const depositsToMake = [];
    
    if (yesBalance > 0n) {
      const yesDepositAmount = yesBalance / 2n; // Half of YES tokens
      if (yesDepositAmount > 0n) {
        depositsToMake.push({
          tokenType: "YES",
          positionId: yesPositionId,
          amount: yesDepositAmount,
          balance: yesBalance
        });
      }
    }
    
    if (noBalance > 0n) {
      const noDepositAmount = noBalance / 2n; // Half of NO tokens
      if (noDepositAmount > 0n) {
        depositsToMake.push({
          tokenType: "NO",
          positionId: noPositionId,
          amount: noDepositAmount,
          balance: noBalance
        });
      }
    }
    
    if (depositsToMake.length === 0) {
      console.log(`⚠️  No tokens to deposit for ${name}`);
      continue;
    }
    
    // Impersonate the user
    const userSigner = await impersonate(address);
    
    // Check and set approval if needed
    const isApproved = await ctf.isApprovedForAll(address, VAULT_ADDRESS);
    if (!isApproved) {
      console.log(`🔐 Setting approval for vault to spend user's conditional tokens...`);
      const approveTx = await ctf.connect(userSigner).setApprovalForAll(VAULT_ADDRESS, true);
      await approveTx.wait();
      console.log(`✅ Approval set`);
    } else {
      console.log(`✅ Vault already approved to spend user's conditional tokens`);
    }
    
    // Perform deposits
    for (const deposit of depositsToMake) {
      const { tokenType, positionId, amount, balance } = deposit;
      
      console.log(`\n💰 Depositing ${tokenType} tokens:`);
      console.log(`- Available: ${ethers.formatUnits(balance, 6)}`);
      console.log(`- Depositing: ${ethers.formatUnits(amount, 6)} (50%)`);
      console.log(`- Position ID: ${positionId}`);
      
      try {
        // Listen for deposit events
        const eventPromises = [];
        
        if (tokenType === "YES") {
          eventPromises.push(
            new Promise((resolve) => {
              vault.once("YesTokenDeposited", (user, depositAmount, yesYMinted, event) => {
                resolve({
                  type: "YesTokenDeposited",
                  user,
                  amount: ethers.formatUnits(depositAmount, 6),
                  yesYMinted: ethers.formatUnits(yesYMinted, 6),
                  txHash: event.log.transactionHash
                });
              });
            })
          );
        } else {
          eventPromises.push(
            new Promise((resolve) => {
              vault.once("NoTokenDeposited", (user, depositAmount, noYMinted, event) => {
                resolve({
                  type: "NoTokenDeposited",
                  user,
                  amount: ethers.formatUnits(depositAmount, 6),
                  noYMinted: ethers.formatUnits(noYMinted, 6),
                  txHash: event.log.transactionHash
                });
              });
            })
          );
        }
        
        // Listen for matching/yield events
        eventPromises.push(
          new Promise((resolve) => {
            vault.once("PositionsMatched", (matchedAmount, usdcGenerated, event) => {
              resolve({
                type: "PositionsMatched",
                matchedAmount: ethers.formatUnits(matchedAmount, 6),
                usdcGenerated: ethers.formatUnits(usdcGenerated, 6),
                txHash: event.log.transactionHash
              });
            });
          })
        );
        
        eventPromises.push(
          new Promise((resolve) => {
            vault.once("YieldDeposited", (yieldAmount, aTokensReceived, event) => {
              resolve({
                type: "YieldDeposited",
                yieldAmount: ethers.formatUnits(yieldAmount, 6),
                aTokensReceived: ethers.formatUnits(aTokensReceived, 6),
                txHash: event.log.transactionHash
              });
            });
          })
        );
        
        // Set timeout for events
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Event timeout")), 10000);
        });
        
        // Execute the deposit transaction
        const tx = await ctf.connect(userSigner).safeTransferFrom(
          address,
          VAULT_ADDRESS,
          positionId,
          amount,
          "0x"
        );
        
        console.log(`Transaction Hash: ${tx.hash}`);
        
        const receipt = await tx.wait();
        console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
        console.log(`Gas Used: ${receipt.gasUsed.toString()}`);
        
        // Wait for events (with timeout)
        try {
          const raceResult = await Promise.race([
            Promise.allSettled(eventPromises),
            timeoutPromise
          ]);
          
          console.log(`\n📝 Events captured:`);
          for (const result of raceResult) {
            if (result.status === 'fulfilled' && result.value) {
              const event = result.value;
              console.log(`- ${event.type}:`);
              Object.keys(event).forEach(key => {
                if (key !== 'type') {
                  console.log(`  ${key}: ${event[key]}`);
                }
              });
            }
          }
        } catch (e) {
          console.log(`⚠️  Event capture timeout or error: ${e.message}`);
        }
        
        // Verify deposit was successful
        const newYesY = await vault.getYesYBalance(address);
        const newNoY = await vault.getNoYBalance(address);
        const newCtfBalance = await ctf.balanceOf(address, positionId);
        
        console.log(`\n✅ Deposit Results:`);
        console.log(`- New ${tokenType} CTF Balance: ${ethers.formatUnits(newCtfBalance, 6)}`);
        console.log(`- New YES.Y Balance: ${ethers.formatUnits(newYesY, 6)}`);
        console.log(`- New NO.Y Balance: ${ethers.formatUnits(newNoY, 6)}`);
        
        // Verify the math
        const expectedCtfBalance = balance - amount;
        if (newCtfBalance === expectedCtfBalance) {
          console.log(`✅ CTF balance correctly reduced by deposit amount`);
        } else {
          console.log(`⚠️  CTF balance mismatch: expected ${ethers.formatUnits(expectedCtfBalance, 6)}, got ${ethers.formatUnits(newCtfBalance, 6)}`);
        }
        
      } catch (error) {
        console.error(`❌ Deposit failed for ${tokenType}:`, error.message);
        
        // Check for common error patterns
        if (error.message.includes("Market already resolved")) {
          console.log(`💡 Market is resolved - deposits not allowed`);
        } else if (error.message.includes("Invalid token ID")) {
          console.log(`💡 Token ID mismatch - check vault configuration`);
        } else if (error.message.includes("not approved")) {
          console.log(`💡 Approval issue - check CTF approval status`);
        }
        
        continue;
      }
    }
  }
  
  // Get final vault state
  const finalTotalYes = await vault.totalYesDeposits();
  const finalTotalNo = await vault.totalNoDeposits();
  const finalMatched = await vault.totalMatched();
  const finalYielding = await vault.totalYielding();
  
  console.log(`\n📊 Final Vault State:`);
  console.log(`- Total YES Deposits: ${ethers.formatUnits(finalTotalYes, 6)} (Δ: ${ethers.formatUnits(finalTotalYes - initialTotalYes, 6)})`);
  console.log(`- Total NO Deposits: ${ethers.formatUnits(finalTotalNo, 6)} (Δ: ${ethers.formatUnits(finalTotalNo - initialTotalNo, 6)})`);
  console.log(`- Total Matched: ${ethers.formatUnits(finalMatched, 6)} (Δ: ${ethers.formatUnits(finalMatched - initialMatched, 6)})`);
  console.log(`- Total Yielding: ${ethers.formatUnits(finalYielding, 6)} (Δ: ${ethers.formatUnits(finalYielding - initialYielding, 6)})`);
  
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
  
  console.log(`\n🎯 Deposit Test Summary:`);
  console.log(`- Market: ${market.question}`);
  console.log(`- Vault Address: ${VAULT_ADDRESS}`);
  console.log(`- YES Deposits Added: ${ethers.formatUnits(finalTotalYes - initialTotalYes, 6)}`);
  console.log(`- NO Deposits Added: ${ethers.formatUnits(finalTotalNo - initialTotalNo, 6)}`);
  console.log(`- New Matched Amount: ${ethers.formatUnits(finalMatched - initialMatched, 6)} USDC`);
  console.log(`- New Yielding Amount: ${ethers.formatUnits(finalYielding - initialYielding, 6)} USDC`);
  
  console.log(`\n✅ All deposit tests completed!`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});