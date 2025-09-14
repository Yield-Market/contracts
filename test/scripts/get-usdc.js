/*
 Test-only script: fund a receiver with USDC from a Polygon whale (fork only).

 Requirements:
   - ALLOW_TEST_SCRIPTS=true
   - Local hardhat or forked network (chainId 1337/31337)

 Config:
   - Uses POLYGON.USDC, WHALES.USDC and TEST.USDC_RECEIVER/USDC_AMOUNT from config.js

 Usage:
   export POLYGON_RPC_URL="https://rpc.ankr.com/polygon"
   npx hardhat node --fork $POLYGON_RPC_URL --chain-id 1337 &
   ALLOW_TEST_SCRIPTS=true hardhat run test/scripts/get-usdc.js --network localhost

 Notes:
   - This script impersonates a known USDC whale. DO NOT run on mainnet.
*/

const { ethers, network } = require("hardhat");
const { POLYGON, WHALES, LOCAL_CHAIN_IDS, TEST } = require("./config");

// Polygon USDC and whale (on forks)
const USDC = POLYGON.USDC;
const USDC_WHALE = WHALES.USDC;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
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

  const usdc = new ethers.Contract(USDC, ERC20_ABI, ethers.provider);

  const receiver = TEST.USDC_RECEIVER || (await ethers.getSigners())[0].address;
  const amountUnits = TEST.USDC_AMOUNT || "2000"; // default USDC amount
  const targetAmount = ethers.parseUnits(amountUnits, 6);

  const whaleBal = await usdc.balanceOf(USDC_WHALE);
  console.log(`Whale USDC before: ${ethers.formatUnits(whaleBal, 6)}`);
  console.log(`Funding receiver ${receiver} with ${amountUnits} USDC...`);

  const whale = await impersonate(USDC_WHALE);
  await (await usdc.connect(whale).transfer(receiver, targetAmount)).wait();

  const recvBal = await usdc.balanceOf(receiver);
  console.log(`Receiver USDC after: ${ethers.formatUnits(recvBal, 6)}`);
  console.log(`Done.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


