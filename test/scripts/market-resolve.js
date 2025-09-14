/*
 Core logic extracted from test/08-market-resolution.test.js
 - Reads first non-zero YPMVault from scripts/markets.json
 - (Optional) Resolves ConditionalTokens if QUESTION_ID provided (YES wins)
 - Resolves YPMVault and prints final resolution state and vault balances

 Usage (on Polygon fork):
   export POLYGON_RPC_URL="https://rpc.ankr.com/polygon"
   npx hardhat node --fork $POLYGON_RPC_URL --chain-id 137 &
   # Optional: export QUESTION_ID=0x...
   npx hardhat run scripts/market-resolution.js --network localhost
*/

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { POLYGON, MARKET} = require("./config");

const POLYGON_ADDRESSES = {
  CTF: POLYGON.CTF,
};

const conditionalTokensABI = [
  "function reportPayouts(bytes32 questionId, uint256[] payouts)",
  "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)",
  // Event for discovering oracle/questionId
  "event ConditionPreparation(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount)",
];

async function main() {
  const ypmVault = MARKET.ypmVaultAddress;
  const conditionId = MARKET.conditionId;
  const [deployer, userA, userB, userC] = await ethers.getSigners();

  const conditionalTokens = new ethers.Contract(
    POLYGON_ADDRESSES.CTF,
    conditionalTokensABI,
    deployer,
  );
  const ypm = await ethers.getContractAt("YPMVault", ypmVault);

  console.log("Using:");
  console.log(`- ConditionalTokens: ${POLYGON_ADDRESSES.CTF}`);
  console.log(`- YPMVault:         ${ypmVault}`);
  console.log(`- Condition ID:     ${conditionId}`);

  // Step 1: Resolve CTF (optional)
  try {
    const denom = await conditionalTokens.payoutDenominator(conditionId);
    if (Number(denom) === 0) {
      // Discover oracle/questionId from on-chain logs if not provided
      if (!process.env.QUESTION_ID) {
        try {
          const iface = new ethers.Interface(conditionalTokensABI);
          const topic0 = ethers.id("ConditionPreparation(bytes32,address,bytes32,uint256)");
          const logs = await ethers.provider.getLogs({
            address: POLYGON_ADDRESSES.CTF,
            topics: [topic0, conditionId],
            fromBlock: 0,
            toBlock: "latest",
          });
          if (logs.length) {
            const parsed = iface.parseLog(logs[logs.length - 1]);
            const discoveredOracle = parsed.args.oracle;
            const discoveredQid = parsed.args.questionId;
            const outcomeSlots = parsed.args.outcomeSlotCount;
            console.log(`Discovered oracle: ${discoveredOracle}`);
            console.log(`Discovered questionId: ${discoveredQid}`);
            console.log(`Outcome slots: ${outcomeSlots}`);

            // Impersonate oracle on fork to report payouts
            await ethers.provider.send("hardhat_impersonateAccount", [discoveredOracle]);
            await ethers.provider.send("hardhat_setBalance", [
              discoveredOracle,
              "0x" + ethers.parseEther("5").toString(16),
            ]);
            const oracleSigner = await ethers.getSigner(discoveredOracle);
            questionId = discoveredQid;

            console.log("Reporting payouts to CTF (YES wins) as oracle...");
            const payouts = [1, 0];
            const tx = await conditionalTokens.connect(oracleSigner).reportPayouts(questionId, payouts);
            await tx.wait();
            console.log("CTF resolved by oracle.");
          } else {
            console.log("No ConditionPreparation logs found. If this market was created off-chain, set QUESTION_ID env to proceed.");
          }
        } catch (e) {
          console.log(`Auto-discovery failed: ${e.message}`);
        }
      }

      // Fallback: use provided QUESTION_ID env if discovery didn't resolve
      const postDenom = await conditionalTokens.payoutDenominator(conditionId);
      if (Number(postDenom) === 0 && process.env.QUESTION_ID) {
        console.log("Reporting payouts to CTF (YES wins) with env QUESTION_ID...");
        const payouts = [1, 0];
        const tx = await conditionalTokens.reportPayouts(process.env.QUESTION_ID, payouts);
        await tx.wait();
        console.log("CTF resolved.");
      } else if (Number(postDenom) === 0) {
        console.log("CTF still unresolved (no oracle/QUESTION_ID). Proceeding to vault resolution may revert.");
      }
    } else {
      console.log("CTF already resolved.");
    }
  } catch (e) {
    console.log(`Warning reading/resolving CTF: ${e.message}`);
  }

  // Step 2: Resolve YPMVault
  // no need to resolve by admin anymore
  /* 
  const beforeResolved = await ypm.isResolved();
  console.log(`Vault isResolved (before): ${beforeResolved}`);
  if (!beforeResolved) {
    console.log("Resolving YPMVault...");
    const rtx = await ypm.connect(deployer).resolveMarket();
    await rtx.wait();
    console.log("YPMVault resolved.");
  } else {
    console.log("YPMVault already resolved.");
  }
   */

  // Step 3: Print final states
  const isResolved = await ypm.isResolved();
  const yesWon = await ypm.yesWon();
  const payoutRatio = await ypm.finalPayoutRatio();
  console.log("\nYPMVault Resolution State:");
  console.log(`- Resolved: ${isResolved}`);
  console.log(`- YES Won: ${yesWon}`);
  console.log(`- Final Payout Ratio: ${payoutRatio}`);

  try {
    const denom = await conditionalTokens.payoutDenominator(conditionId);
    const p0 = await conditionalTokens.payoutNumerators(conditionId, 0);
    const p1 = await conditionalTokens.payoutNumerators(conditionId, 1);
    console.log("\nCTF Resolution State:");
    console.log(`- Denominator: ${denom}`);
    console.log(`- YES Payout:  ${p0}`);
    console.log(`- NO Payout:   ${p1}`);
  } catch (e) {
    console.log(`Warning reading CTF final state: ${e.message}`);
  }

  // Step 4: Vault balances summary
  const totalYesDeposits = await ypm.totalYesDeposits();
  const totalNoDeposits = await ypm.totalNoDeposits();
  const totalMatched = await ypm.totalMatched();
  const totalYielding = await ypm.totalYielding();
  console.log("\nVault Balances:");
  console.log(`- Total YES Deposits: ${ethers.formatUnits(totalYesDeposits, 6)}`);
  console.log(`- Total NO Deposits:  ${ethers.formatUnits(totalNoDeposits, 6)}`);
  console.log(`- Total Matched:      ${ethers.formatUnits(totalMatched, 6)}`);
  console.log(`- Total Yielding:     ${ethers.formatUnits(totalYielding, 6)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


