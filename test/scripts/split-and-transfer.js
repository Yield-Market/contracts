/*
 Test-only script: split USDC into YES/NO CTF tokens and transfer.

 Requirements:
   - ALLOW_TEST_SCRIPTS=true
   - Local hardhat or forked network (chainId 1337/31337)

 Config:
   - Uses POLYGON.*, MARKET.conditionId and TEST.YES_RECEIVER/NO_RECEIVER/USDC_AMOUNT from config.js

 Usage:
   export POLYGON_RPC_URL="https://rpc.ankr.com/polygon"
   npx hardhat node --fork $POLYGON_RPC_URL --chain-id 1337 &
   ALLOW_TEST_SCRIPTS=true hardhat run test/scripts/split-and-transfer.js --network localhost

 Notes:
   - If YES/NO receivers are not set in config, the first local signer is used.
   - This script impersonates a USDC whale; DO NOT run on mainnet.
*/

const { ethers, network } = require("hardhat");
const { POLYGON, WHALES, LOCAL_CHAIN_IDS, TEST, MARKET } = require("./config");

// Polygon addresses
const USDC = POLYGON.USDC;
const CTF = POLYGON.CTF;

// Condition ID to split under
const CONDITION_ID = MARKET.conditionId;

// Known USDC-rich address on Polygon (used in tests)
const USDC_WHALE = WHALES.USDC;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

const CTF_ABI = [
  "function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
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
  const chain = await ethers.provider.getNetwork();
  const chainId = Number(chain.chainId);
  if (!LOCAL_CHAIN_IDS.includes(chainId)) {
    throw new Error(`Refusing to run on non-local chainId=${chainId}. Use a local hardhat node or fork.`);
  }

  const [defaultYesTo, defaultNoTo] = await ethers.getSigners();

  const AMOUNT_USDC = TEST.USDC_AMOUNT || "1000"; // default 1000 USDC

  const usdc = new ethers.Contract(USDC, ERC20_ABI, ethers.provider);
  const ctf = new ethers.Contract(CTF, CTF_ABI, ethers.provider);

  const [actor] = await ethers.getSigners();
  console.log(`Actor: ${actor.address}`);
  console.log(`YES recipient: ${TEST.YES_RECEIVER}`);
  console.log(`NO  recipient: ${TEST.NO_RECEIVER}`);

  const amount = ethers.parseUnits(AMOUNT_USDC, 6);

  // Ensure actor has enough USDC; if not, fund from whale
  let bal = await usdc.balanceOf(actor.address);
  console.log(`Actor USDC before: ${ethers.formatUnits(bal, 6)}`);
  if (bal < amount) {
    console.log(`Funding from USDC whale...`);
    const whale = await impersonate(USDC_WHALE);
    await (await usdc.connect(whale).transfer(actor.address, amount - bal)).wait();
    bal = await usdc.balanceOf(actor.address);
  }
  console.log(`Actor USDC now: ${ethers.formatUnits(bal, 6)}`);

  // Approve CTF to spend USDC and split into YES/NO
  console.log(`Approving USDC to CTF and splitting ${AMOUNT_USDC} USDC into YES/NO...`);
  await (await usdc.connect(actor).approve(CTF, amount)).wait();
  const partition = [1, 2];
  await (
    await ctf
      .connect(actor)
      .splitPosition(USDC, ethers.ZeroHash, CONDITION_ID, partition, amount)
  ).wait();

  // Compute YES/NO tokenIds
  const yesCol = await ctf.getCollectionId(ethers.ZeroHash, CONDITION_ID, 1);
  const noCol = await ctf.getCollectionId(ethers.ZeroHash, CONDITION_ID, 2);
  const yesId = await ctf.getPositionId(USDC, yesCol);
  const noId = await ctf.getPositionId(USDC, noCol);
  console.log(`YES tokenId: ${yesId}`);
  console.log(`NO  tokenId: ${noId}`);

  const yesBal = await ctf.balanceOf(actor.address, yesId);
  const noBal = await ctf.balanceOf(actor.address, noId);
  console.log(`Actor YES balance: ${ethers.formatUnits(yesBal, 6)}`);
  console.log(`Actor NO  balance: ${ethers.formatUnits(noBal, 6)}`);

  // Transfer YES/NO to recipients
  console.log(`Transferring YES to ${TEST.YES_RECEIVER} and NO to ${TEST.NO_RECEIVER}...`);
  await (
    await ctf
      .connect(actor)
      .safeTransferFrom(actor.address, TEST.YES_RECEIVER, yesId, yesBal, "0x")
  ).wait();
  await (
    await ctf
      .connect(actor)
      .safeTransferFrom(actor.address, TEST.NO_RECEIVER, noId, noBal, "0x")
  ).wait();

  console.log(`Done.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


