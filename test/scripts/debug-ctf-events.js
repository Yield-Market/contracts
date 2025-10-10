/*
 Debug script: Query CTF contract events to verify market data

 This script queries ConditionalTokens events to:
 1. Find ConditionPreparation events for our condition ID
 2. Calculate correct position IDs using CTF contract logic
 3. Compare with our markets.json data

 Usage:
   CONDITION_ID=0x... ALLOW_TEST_SCRIPTS=true npx hardhat run test/scripts/debug-ctf-events.js --network localhost
*/

const { ethers } = require("hardhat");
const { POLYGON } = require("./config");

const CTF_ADDRESS = POLYGON.CTF;
const USDC_ADDRESS = POLYGON.USDC;

// CTF ABI (events only)
const CTF_ABI = [
  "event ConditionPreparation(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint outcomeSlotCount)",
  "event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint outcomeSlotCount, uint[] payoutNumerators)",
  "event PositionSplit(address indexed stakeholder, address collateralToken, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint[] partition, uint amount)",
  "function getConditionId(address oracle, bytes32 questionId, uint outcomeSlotCount) external pure returns (bytes32)",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint indexSet) external view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint)",
  "function getOutcomeSlotCount(bytes32 conditionId) external view returns (uint)",
  "function payoutNumerators(bytes32 conditionId, uint index) external view returns (uint)",
  "function payoutDenominator(bytes32 conditionId) external view returns (uint)"
];

// Helper functions to calculate position IDs like CTF contract
function getCollectionId(parentCollectionId, conditionId, indexSet) {
  // Mimics CTHelpers.getCollectionId
  if (parentCollectionId === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    // keccak256(abi.encodePacked(conditionId, indexSet))
    return ethers.keccak256(ethers.solidityPacked(["bytes32", "uint256"], [conditionId, indexSet]));
  } else {
    // keccak256(abi.encodePacked(parentCollectionId, conditionId, indexSet))
    return ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32", "uint256"], [parentCollectionId, conditionId, indexSet]));
  }
}

function getPositionId(collateralToken, collectionId) {
  // Mimics CTHelpers.getPositionId
  // uint(keccak256(abi.encodePacked(collateralToken, collectionId)))
  return BigInt(ethers.keccak256(ethers.solidityPacked(["address", "bytes32"], [collateralToken, collectionId])));
}

async function main() {
  if (process.env.ALLOW_TEST_SCRIPTS !== "true") {
    throw new Error("Set ALLOW_TEST_SCRIPTS=true to allow test scripts");
  }

  const conditionId = process.env.CONDITION_ID;
  if (!conditionId) {
    throw new Error("CONDITION_ID environment variable is required");
  }

  console.log("🔍 Debugging CTF events for condition:", conditionId);
  console.log("CTF Contract:", CTF_ADDRESS);
  console.log("USDC Address:", USDC_ADDRESS);

  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, ethers.provider);

  console.log("\n=== 1. Querying ConditionPreparation events ===");
  
  try {
    // Query ConditionPreparation events
    const filter = ctf.filters.ConditionPreparation(conditionId);
    const events = await ctf.queryFilter(filter, 0, "latest");
    
    if (events.length === 0) {
      console.log("❌ No ConditionPreparation events found for this condition ID");
      console.log("   This means either:");
      console.log("   1. The condition ID is incorrect");
      console.log("   2. The condition hasn't been prepared yet");
      console.log("   3. We're on the wrong network");
      return;
    }

    console.log(`✅ Found ${events.length} ConditionPreparation event(s)`);
    
    for (const event of events) {
      console.log("\n--- Event Details ---");
      console.log("Block:", event.blockNumber);
      console.log("Transaction:", event.transactionHash);
      console.log("Oracle:", event.args.oracle);
      console.log("Question ID:", event.args.questionId);
      console.log("Outcome Slot Count:", event.args.outcomeSlotCount.toString());
    }

    const prepEvent = events[0]; // Use first event
    const outcomeSlotCount = Number(prepEvent.args.outcomeSlotCount);
    
    console.log("\n=== 2. Calculating Position IDs ===");
    
    // For a typical binary market (YES/NO), outcomeSlotCount should be 2
    console.log("Outcome slot count:", outcomeSlotCount);
    
    if (outcomeSlotCount !== 2) {
      console.log("⚠️  Warning: Expected 2 outcomes for YES/NO market, got", outcomeSlotCount);
    }

    // Calculate position IDs for YES (index 0) and NO (index 1)
    const parentCollectionId = "0x0000000000000000000000000000000000000000000000000000000000000000"; // bytes32(0)
    
    // YES position: indexSet = 1 (binary 01 = outcome 0)
    const yesIndexSet = 1;
    const yesCollectionId = getCollectionId(parentCollectionId, conditionId, yesIndexSet);
    const yesPositionId = getPositionId(USDC_ADDRESS, yesCollectionId);
    
    // NO position: indexSet = 2 (binary 10 = outcome 1)  
    const noIndexSet = 2;
    const noCollectionId = getCollectionId(parentCollectionId, conditionId, noIndexSet);
    const noPositionId = getPositionId(USDC_ADDRESS, noCollectionId);

    console.log("\n--- Calculated Position IDs ---");
    console.log("YES (outcome 0, indexSet 1):");
    console.log("  Collection ID:", yesCollectionId);
    console.log("  Position ID:", yesPositionId.toString());
    
    console.log("NO (outcome 1, indexSet 2):");
    console.log("  Collection ID:", noCollectionId);
    console.log("  Position ID:", noPositionId.toString());

    console.log("\n=== 3. Verifying with Contract ===");
    
    try {
      // Verify our calculations match the contract
      const contractOutcomeSlotCount = await ctf.getOutcomeSlotCount(conditionId);
      console.log("Contract outcome slot count:", contractOutcomeSlotCount.toString());
      
      const contractYesCollectionId = await ctf.getCollectionId(parentCollectionId, conditionId, yesIndexSet);
      const contractYesPositionId = await ctf.getPositionId(USDC_ADDRESS, contractYesCollectionId);
      
      const contractNoCollectionId = await ctf.getCollectionId(parentCollectionId, conditionId, noIndexSet);
      const contractNoPositionId = await ctf.getPositionId(USDC_ADDRESS, contractNoCollectionId);
      
      console.log("\n--- Contract Verification ---");
      console.log("YES Position ID from contract:", contractYesPositionId.toString());
      console.log("NO Position ID from contract:", contractNoPositionId.toString());
      
      console.log("\n--- Comparison ---");
      const yesMatch = yesPositionId.toString() === contractYesPositionId.toString();
      const noMatch = noPositionId.toString() === contractNoPositionId.toString();
      
      console.log("YES Position ID matches:", yesMatch ? "✅" : "❌");
      console.log("NO Position ID matches:", noMatch ? "✅" : "❌");
      
      if (!yesMatch) {
        console.log("  Expected:", contractYesPositionId.toString());
        console.log("  Calculated:", yesPositionId.toString());
      }
      
      if (!noMatch) {
        console.log("  Expected:", contractNoPositionId.toString());
        console.log("  Calculated:", noPositionId.toString());
      }

    } catch (error) {
      console.log("❌ Error verifying with contract:", error.message);
    }

    console.log("\n=== 4. Checking Resolution Status ===");
    
    try {
      const payoutDenominator = await ctf.payoutDenominator(conditionId);
      if (payoutDenominator > 0) {
        console.log("✅ Condition is resolved");
        console.log("Payout denominator:", payoutDenominator.toString());
        
        for (let i = 0; i < outcomeSlotCount; i++) {
          const numerator = await ctf.payoutNumerators(conditionId, i);
          console.log(`Outcome ${i} payout: ${numerator.toString()}/${payoutDenominator.toString()}`);
        }
      } else {
        console.log("⏳ Condition is not resolved yet");
      }
    } catch (error) {
      console.log("❌ Error checking resolution:", error.message);
    }

    console.log("\n=== 5. Looking for PositionSplit events ===");
    
    try {
      const splitFilter = ctf.filters.PositionSplit(null, null, null, conditionId);
      const splitEvents = await ctf.queryFilter(splitFilter, 0, "latest");
      
      if (splitEvents.length > 0) {
        console.log(`Found ${splitEvents.length} PositionSplit events for this condition`);
        
        // Show first few events
        for (let i = 0; i < Math.min(3, splitEvents.length); i++) {
          const event = splitEvents[i];
          console.log(`\nSplit Event ${i + 1}:`);
          console.log("  Block:", event.blockNumber);
          console.log("  Stakeholder:", event.args.stakeholder);
          console.log("  Collateral Token:", event.args.collateralToken);
          console.log("  Amount:", ethers.formatUnits(event.args.amount, 6), "USDC");
          console.log("  Partition:", event.args.partition.map(p => p.toString()));
        }
      } else {
        console.log("No PositionSplit events found for this condition");
      }
    } catch (error) {
      console.log("❌ Error querying PositionSplit events:", error.message);
    }

  } catch (error) {
    console.error("❌ Error querying events:", error.message);
    console.error(error);
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exitCode = 1;
});