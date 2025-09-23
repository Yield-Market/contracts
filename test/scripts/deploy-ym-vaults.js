/*
 Test-only script: deploy YMVault for MARKET from config.js on a local fork.

 Requirements:
   - ALLOW_TEST_SCRIPTS=true
   - Local hardhat or forked network (chainId 1337/31337)

 Config:
   - Uses POLYGON.* and MARKET from test/scripts/config.js

 Usage:
   export POLYGON_RPC_URL="https://rpc.ankr.com/polygon"
   npx hardhat node --fork $POLYGON_RPC_URL --chain-id 1337 &
   ALLOW_TEST_SCRIPTS=true hardhat run test/scripts/deploy-ym-vaults.js --network localhost
*/

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { MARKET, POLYGON, LOCAL_CHAIN_IDS, TEST } = require("./config");

// Market now provided via config

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Polygon mainnet addresses
const POLYGON_CTF = POLYGON.CTF;
const POLYGON_AUSDC = POLYGON.AUSDC;

function assertAddress(name, value) {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} is missing or invalid: ${value}`);
  }
}

function loadMarkets() {
  return { raw: null, json: [MARKET] };
}

// Replace only ymVaultAddress within the object containing the specific id, preserving whitespace
function replaceVaultAddressPreservingWhitespace(rawText, id, newAddress) {
  const idEsc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `("id"\s*:\s*"${idEsc}")([\\\s\S]*?)("ymVaultAddress"\s*:\s*")0x[0-9a-fA-F]{40}(\")`,
    "m",
  );
  const match = rawText.match(re);
  if (!match) throw new Error(`Could not locate ymVaultAddress for id=${id}`);
  const before = rawText.slice(0, match.index);
  const after = rawText.slice(match.index + match[0].length);
  const replaced = `${match[1]}${match[2]}${match[3]}${newAddress}${match[4]}`;
  return before + replaced + after;
}

async function main() {
  if (process.env.ALLOW_TEST_SCRIPTS !== "true") {
    throw new Error("Refusing to run: set ALLOW_TEST_SCRIPTS=true to allow test scripts");
  }
  const chain = await ethers.provider.getNetwork();
  const chainId = Number(chain.chainId);
  if (![1337, 31337].includes(chainId)) {
    throw new Error(`Refusing to run on non-local chainId=${chainId}. Use a local hardhat node or fork.`);
  }
  const ctf = POLYGON_CTF;
  const aToken = POLYGON_AUSDC;
  assertAddress("ConditionalTokens (CTF)", ctf);

  const { raw: rawMarkets, json: markets } = loadMarkets();

  // Use private key if configured, otherwise use default signer
  let deployer;
  if (TEST.PRIVATE_KEY) {
    console.log("Using configured private key for deployment");
    const wallet = new ethers.Wallet(TEST.PRIVATE_KEY, ethers.provider);
    deployer = wallet;
  } else {
    console.log("Using default signer for deployment");
    deployer = (await ethers.getSigners())[0];
  }

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network chainId: ${chainId}`);
  console.log(`CTF: ${ctf}`);
  console.log(`aUSDC: ${aToken}`);

  const YMVaultImplFactory = await ethers.getContractFactory("YMVault");
  const YMVaultFactoryFactory = await ethers.getContractFactory("YMVaultFactory");

  const deployments = [];
  for (const market of markets) {
    const currentAddr = market.ymVaultAddress;

    const collateralToken = market.collateralToken;
    assertAddress("collateralToken", collateralToken);

    const aavePool = market.yieldStrategy; // expected to be Aave v3 Pool
    assertAddress("yieldStrategy (Aave Pool)", aavePool);

    const conditionId = market.conditionId;
    if (!/^0x[0-9a-fA-F]{64}$/.test(conditionId)) {
      throw new Error(`Invalid conditionId for ${market.id}: ${conditionId}`);
    }

    // Position IDs may be large, pass as BigInt
    const yesPositionId = BigInt(market.yesPositionId);
    const noPositionId = BigInt(market.noPositionId);

    console.log(`\nDeploying YMVault for market: ${market.id}`);
    console.log(`  collateralToken: ${collateralToken}`);
    console.log(`  aavePool:        ${aavePool}`);
    console.log(`  aToken:          ${aToken}`);
    console.log(`  conditionId:     ${conditionId}`);
    console.log(`  yesPositionId:   ${yesPositionId}`);
    console.log(`  noPositionId:    ${noPositionId}`);

    // Deploy implementation if needed (idempotent for test use; in prod keep a single implementation)
    const impl = await YMVaultImplFactory.connect(deployer).deploy();
    await impl.waitForDeployment();
    const factory = await YMVaultFactoryFactory.connect(deployer).deploy(
      await impl.getAddress(),
      deployer.address
    );
    await factory.waitForDeployment();

    const tx = await factory.createVault(
      ctf,
      aavePool,
      collateralToken,
      aToken,
      conditionId,
      yesPositionId,
      noPositionId,
      deployer.address
    );
    const rcpt = await tx.wait();
    let deployedAddress;
    for (const log of rcpt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed && parsed.name === "VaultProxyCreated") {
          deployedAddress = parsed.args.proxy;
          break;
        }
      } catch {}
    }
    console.log(`${market.id}  -> Deployed proxy at: ${deployedAddress}`);

  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});


