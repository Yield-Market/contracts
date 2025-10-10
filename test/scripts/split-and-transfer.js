/*
 Test-only script: split USDC into YES// Wrapped USDC ABI (from the contract you provided)
const WRAPPED_USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)", 
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function underlying() view returns (address)",
  "function owner() view returns (address)",
  "function wrap(address _to, uint256 _amount) external", // Only owner can call
  "function unwrap(address _to, uint256 _amount) external",
  "function mint(uint256 _amount) external", // Only owner can call
  "function burn(uint256 _amount) external", // Only owner can call
  "function release(address _to, uint256 _amount) external" // Only owner can call
];s and transfer.

 Requirements:
   - ALLOW_TEST_SCRIPTS=true
   - Local hardhat or forked network (chainId 1337/31337)
   - MARKET_ID environment variable

 Config:
   - Uses POLYGON.* and market from markets.json, TEST.YES_RECEIVER/NO_RECEIVER/USDC_AMOUNT from config.js

 Usage:
   export POLYGON_RPC_URL="https://rpc.ankr.com/polygon"
   npx hardhat node --fork $POLYGON_RPC_URL --chain-id 1337 &
   # Required: export MARKET_ID=588fa06c-fb08-4eb4-87c3-eda1b33704c8
   ALLOW_TEST_SCRIPTS=true hardhat run test/scripts/split-and-transfer.js --network localhost

 Notes:
   - If YES/NO receivers are not set in config, the first local signer is used.
   - This script impersonates a USDC whale; DO NOT run on mainnet.
*/

const { ethers, network } = require("hardhat");
const { POLYGON, WHALES, LOCAL_CHAIN_IDS, TEST } = require("./config");
const config = require("./config");

// Polygon addresses
const USDC = POLYGON.USDC;
const CTF = POLYGON.CTF;

// Known USDC-rich address on Polygon (used in tests)
const USDC_WHALE = WHALES.USDC;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

// Wrapped USDC ABI (Polymarket's wrapper interface)
// Wrapped USDC ABI (based on actual contract)
const WRAPPED_USDC_ABI = [
  "function wrap(address _to, uint256 _amount) external", // Only owner can call
  "function unwrap(address _to, uint256 _amount) external",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function underlying() view returns (address)",
  "function owner() view returns (address)",
  "function mint(uint256 _amount) external", // Only owner can call
  "function burn(uint256 _amount) external", // Only owner can call
  "function release(address _to, uint256 _amount) external", // Only owner can call
];

const CTF_ABI = [
  "function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
];

// ERC1155Receiver interface for checking contract compatibility
const ERC1155_RECEIVER_ABI = [
  "function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data) external returns (bytes4)",
  "function onERC1155BatchReceived(address operator, address from, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external returns (bytes4)",
  "function supportsInterface(bytes4 interfaceId) external view returns (bool)",
];

async function impersonate(addr) {
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [addr, "0x" + ethers.parseEther("10").toString(16)]);
  return await ethers.getSigner(addr);
}

async function checkERC1155ReceiverSupport(address) {
  try {
    const contract = new ethers.Contract(address, ERC1155_RECEIVER_ABI, ethers.provider);

    // Check if contract supports ERC1155Receiver interface
    // Interface ID for ERC1155Receiver: 0x4e2312e0
    const interfaceId = "0x4e2312e0";
    const supportsInterface = await contract.supportsInterface(interfaceId);

    return {
      isContract: true,
      supportsERC1155Receiver: supportsInterface,
      hasOnERC1155Received: true, // We'll check this separately
      hasOnERC1155BatchReceived: true // We'll check this separately
    };
  } catch (error) {
    return {
      isContract: true,
      supportsERC1155Receiver: false,
      hasOnERC1155Received: false,
      hasOnERC1155BatchReceived: false,
      error: error.message
    };
  }
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
  const COLLATERAL_TOKEN = market.collateralToken; // Use the correct collateral token from market data
  console.log(`Using market: ${market.question}`);
  console.log(`Market ID: ${targetMarketId}`);
  console.log(`Condition ID: ${CONDITION_ID}`);
  console.log(`Collateral Token: ${COLLATERAL_TOKEN}`);
  
  const chain = await ethers.provider.getNetwork();
  const chainId = Number(chain.chainId);
  if (!LOCAL_CHAIN_IDS.includes(chainId)) {
    throw new Error(`Refusing to run on non-local chainId=${chainId}. Use a local hardhat node or fork.`);
  }

  const [defaultYesTo, defaultNoTo] = await ethers.getSigners();

  const AMOUNT_USDC = TEST.USDC_AMOUNT || "1000"; // default 1000 USDC

  const collateralContract = new ethers.Contract(COLLATERAL_TOKEN, ERC20_ABI, ethers.provider);
  const ctf = new ethers.Contract(CTF, CTF_ABI, ethers.provider);

  const [actor] = await ethers.getSigners();
  console.log(`Actor: ${actor.address}`);
  console.log(`YES recipient: ${TEST.YES_RECEIVER}`);
  console.log(`NO  recipient: ${TEST.NO_RECEIVER}`);

  const amount = ethers.parseUnits(AMOUNT_USDC, 6);

  // Ensure actor has enough collateral tokens; if not, fund from whale
  let bal = await collateralContract.balanceOf(actor.address);
  console.log(`Actor collateral before: ${ethers.formatUnits(bal, 6)}`);
  
  if (bal < amount) {
    if (COLLATERAL_TOKEN === USDC) {
      // Regular USDC - fund from whale
      console.log(`Funding from USDC whale...`);
      const whale = await impersonate(USDC_WHALE);
      await (await collateralContract.connect(whale).transfer(actor.address, amount - bal)).wait();
    } else {
      // Wrapped USDC - use the owner to wrap regular USDC
      console.log(`Need wrapped USDC, getting from owner...`);
      const wrappedUsdcOwner = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"; // Provided owner address
      
      // First, get regular USDC for the owner
      const usdcContract = new ethers.Contract(USDC, ERC20_ABI, ethers.provider);
      const whale = await impersonate(USDC_WHALE);
      const owner = await impersonate(wrappedUsdcOwner);
      
      const neededAmount = amount - bal;
      console.log(`Need to wrap ${ethers.formatUnits(neededAmount, 6)} USDC`);
      
      // Transfer USDC to owner
      await (await usdcContract.connect(whale).transfer(wrappedUsdcOwner, neededAmount)).wait();
      
      // Owner approves wrapped contract to spend USDC
      await (await usdcContract.connect(owner).approve(COLLATERAL_TOKEN, neededAmount)).wait();
      
      // Owner wraps USDC and sends wrapped USDC to actor
      const wrappedContract = new ethers.Contract(COLLATERAL_TOKEN, WRAPPED_USDC_ABI, ethers.provider);
      await (await wrappedContract.connect(owner).wrap(actor.address, neededAmount)).wait();
      
      console.log(`✅ Successfully wrapped ${ethers.formatUnits(neededAmount, 6)} USDC`);
    }
    
    bal = await collateralContract.balanceOf(actor.address);
  }
  console.log(`Actor collateral now: ${ethers.formatUnits(bal, 6)}`);

  // Approve CTF to spend collateral and split into YES/NO
  console.log(`Approving collateral to CTF and splitting ${AMOUNT_USDC} collateral into YES/NO...`);
  await (await collateralContract.connect(actor).approve(CTF, amount)).wait();

  // Set approval for all ERC1155 tokens (required for safeTransferFrom)
  console.log(`Setting approval for all ERC1155 tokens...`);
  await (await ctf.connect(actor).setApprovalForAll(actor.address, true)).wait();
  const partition = [1, 2];
  await (
    await ctf
      .connect(actor)
      .splitPosition(COLLATERAL_TOKEN, ethers.ZeroHash, CONDITION_ID, partition, amount)
  ).wait();

  // Compute YES/NO tokenIds
  const yesCol = await ctf.getCollectionId(ethers.ZeroHash, CONDITION_ID, 1);
  const noCol = await ctf.getCollectionId(ethers.ZeroHash, CONDITION_ID, 2);
  const yesId = await ctf.getPositionId(COLLATERAL_TOKEN, yesCol);
  const noId = await ctf.getPositionId(COLLATERAL_TOKEN, noCol);
  console.log(`YES tokenId: ${yesId}`);
  console.log(`NO  tokenId: ${noId}`);

  const yesBal = await ctf.balanceOf(actor.address, yesId);
  const noBal = await ctf.balanceOf(actor.address, noId);
  console.log(`Actor YES balance: ${ethers.formatUnits(yesBal, 6)}`);
  console.log(`Actor NO  balance: ${ethers.formatUnits(noBal, 6)}`);

  // Debug: Check token balances and addresses
  console.log(`Actor address: ${actor.address}`);
  console.log(`YES receiver: ${TEST.YES_RECEIVER}`);
  console.log(`NO receiver: ${TEST.NO_RECEIVER}`);
  console.log(`YES tokenId: ${yesId}`);
  console.log(`NO tokenId: ${noId}`);
  console.log(`YES balance: ${yesBal}`);
  console.log(`NO balance: ${noBal}`);

  // Validate addresses
  if (!ethers.isAddress(TEST.YES_RECEIVER)) {
    throw new Error(`Invalid YES_RECEIVER address: ${TEST.YES_RECEIVER}`);
  }
  if (!ethers.isAddress(TEST.NO_RECEIVER)) {
    throw new Error(`Invalid NO_RECEIVER address: ${TEST.NO_RECEIVER}`);
  }

  // Check if target addresses are contracts and their ERC1155Receiver support
  console.log(`\n🔍 Checking receiver addresses...`);

  const yesReceiverCode = await ethers.provider.getCode(TEST.YES_RECEIVER);
  const noReceiverCode = await ethers.provider.getCode(TEST.NO_RECEIVER);

  const isYesReceiverContract = yesReceiverCode !== "0x";
  const isNoReceiverContract = noReceiverCode !== "0x";

  console.log(`YES_RECEIVER (${TEST.YES_RECEIVER}):`);
  console.log(`  - Is contract: ${isYesReceiverContract}`);

  if (isYesReceiverContract) {
    const yesReceiverInfo = await checkERC1155ReceiverSupport(TEST.YES_RECEIVER);
    console.log(`  - Supports ERC1155Receiver: ${yesReceiverInfo.supportsERC1155Receiver}`);
    if (yesReceiverInfo.error) {
      console.log(`  - Error checking interface: ${yesReceiverInfo.error}`);
    }

    if (!yesReceiverInfo.supportsERC1155Receiver) {
      console.log(`  ⚠️  WARNING: YES_RECEIVER is a contract but doesn't support ERC1155Receiver interface!`);
      console.log(`  ⚠️  This may cause the transfer to fail.`);
    }
  } else {
    console.log(`  - EOA (Externally Owned Account) - no special handling needed`);
  }

  console.log(`\nNO_RECEIVER (${TEST.NO_RECEIVER}):`);
  console.log(`  - Is contract: ${isNoReceiverContract}`);

  if (isNoReceiverContract) {
    const noReceiverInfo = await checkERC1155ReceiverSupport(TEST.NO_RECEIVER);
    console.log(`  - Supports ERC1155Receiver: ${noReceiverInfo.supportsERC1155Receiver}`);
    if (noReceiverInfo.error) {
      console.log(`  - Error checking interface: ${noReceiverInfo.error}`);
    }

    if (!noReceiverInfo.supportsERC1155Receiver) {
      console.log(`  ⚠️  WARNING: NO_RECEIVER is a contract but doesn't support ERC1155Receiver interface!`);
      console.log(`  ⚠️  This may cause the transfer to fail.`);
    }
  } else {
    console.log(`  - EOA (Externally Owned Account) - no special handling needed`);
  }

  // Check if balances are valid
  if (yesBal === 0n) {
    throw new Error("YES balance is zero, cannot transfer");
  }
  if (noBal === 0n) {
    throw new Error("NO balance is zero, cannot transfer");
  }

  // Additional balance verification
  const yesBalCheck = await ctf.balanceOf(actor.address, yesId);
  const noBalCheck = await ctf.balanceOf(actor.address, noId);
  console.log(`Balance verification - YES: ${yesBalCheck}, NO: ${noBalCheck}`);

  if (yesBalCheck !== yesBal) {
    throw new Error(`YES balance mismatch: expected ${yesBal}, got ${yesBalCheck}`);
  }
  if (noBalCheck !== noBal) {
    throw new Error(`NO balance mismatch: expected ${noBal}, got ${noBalCheck}`);
  }

  // Check if trying to transfer to self
  if (actor.address.toLowerCase() === TEST.YES_RECEIVER.toLowerCase()) {
    console.log("⚠️  Warning: YES_RECEIVER is the same as actor address");
  }
  if (actor.address.toLowerCase() === TEST.NO_RECEIVER.toLowerCase()) {
    console.log("⚠️  Warning: NO_RECEIVER is the same as actor address");
  }

  // Final safety check for contract receivers
  console.log(`\n🛡️  Final safety checks...`);

  if (isYesReceiverContract) {
    const yesReceiverInfo = await checkERC1155ReceiverSupport(TEST.YES_RECEIVER);
    if (!yesReceiverInfo.supportsERC1155Receiver) {
      console.log(`❌ ERROR: YES_RECEIVER is a contract but doesn't support ERC1155Receiver interface!`);
      console.log(`❌ This will cause the transfer to fail. Please use a different address or ensure the contract implements ERC1155Receiver.`);
      throw new Error(`YES_RECEIVER contract doesn't support ERC1155Receiver interface`);
    }
  }

  if (isNoReceiverContract) {
    const noReceiverInfo = await checkERC1155ReceiverSupport(TEST.NO_RECEIVER);
    if (!noReceiverInfo.supportsERC1155Receiver) {
      console.log(`❌ ERROR: NO_RECEIVER is a contract but doesn't support ERC1155Receiver interface!`);
      console.log(`❌ This will cause the transfer to fail. Please use a different address or ensure the contract implements ERC1155Receiver.`);
      throw new Error(`NO_RECEIVER contract doesn't support ERC1155Receiver interface`);
    }
  }

  console.log(`✅ All safety checks passed!`);

  // Transfer YES/NO to recipients
  console.log(`Transferring YES to ${TEST.YES_RECEIVER} and NO to ${TEST.NO_RECEIVER} ...`);

  // Try YES transfer first
  try {
    console.log(`Attempting YES transfer: from=${actor.address}, to=${TEST.YES_RECEIVER}, id=${yesId}, amount=${yesBal}`);

    // Double-check balance right before transfer
    const finalYesBal = await ctf.balanceOf(actor.address, yesId);
    console.log(`Final YES balance check: ${finalYesBal}`);

    if (finalYesBal < yesBal) {
      throw new Error(`Insufficient YES balance: have ${finalYesBal}, need ${yesBal}`);
    }

    const tx = await ctf
      .connect(actor)
      .safeTransferFrom(actor.address, TEST.YES_RECEIVER, yesId, yesBal, "0x");
    console.log(`YES transfer tx hash: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ YES transfer successful`);
  } catch (error) {
    console.error(`❌ YES transfer failed:`, error.message);
    console.error(`Error details:`, error);
    throw error;
  }

  try {
    console.log(`Attempting NO transfer: from=${actor.address}, to=${TEST.NO_RECEIVER}, id=${noId}, amount=${noBal}`);

    // Double-check balance right before transfer
    const finalNoBal = await ctf.balanceOf(actor.address, noId);
    console.log(`Final NO balance check: ${finalNoBal}`);

    if (finalNoBal < noBal) {
      throw new Error(`Insufficient NO balance: have ${finalNoBal}, need ${noBal}`);
    }

    const tx = await ctf
      .connect(actor)
      .safeTransferFrom(actor.address, TEST.NO_RECEIVER, noId, noBal, "0x");
    console.log(`NO transfer tx hash: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ NO transfer successful`);
  } catch (error) {
    console.error(`❌ NO transfer failed:`, error.message);
    console.error(`Error details:`, error);
    throw error;
  }

  console.log(`Done.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


