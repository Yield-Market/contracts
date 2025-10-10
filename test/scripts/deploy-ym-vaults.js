/*
 Test-only script: deploy YMVault for all markets from markets.json on a local fork.

 Requirements:
   - ALLOW_TEST_SCRIPTS=true
   - Local hardhat or forked network (chainId 1337/31337)

 Config:
   - Uses POLYGON.* from test/scripts/config.js
   - Reads markets from markets.json

 Usage:
   export POLYGON_RPC_URL="https://rpc.ankr.com/polygon"
   npx hardhat node --fork $POLYGON_RPC_URL --chain-id 1337 &
   ALLOW_TEST_SCRIPTS=true hardhat run test/scripts/deploy-ym-vaults.js --network localhost
   
   # Deploy specific market:
   MARKET_ID="588fa06c-fb08-4eb4-87c3-eda1b33704c8" ALLOW_TEST_SCRIPTS=true hardhat run test/scripts/deploy-ym-vaults.js --network localhost
   
   # Reuse existing factory and implementation:
   FACTORY_ADDRESS=0x... IMPL_ADDRESS=0x... ALLOW_TEST_SCRIPTS=true hardhat run test/scripts/deploy-ym-vaults.js --network localhost
   
   # Update markets.json with deployed addresses:
   UPDATE_MARKETS_JSON=true ALLOW_TEST_SCRIPTS=true hardhat run test/scripts/deploy-ym-vaults.js --network localhost

 Note: 
   - YMVaultFactory and implementation are deployed once and reused for all markets
   - Use FACTORY_ADDRESS and IMPL_ADDRESS env vars to reuse existing contracts
*/

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { POLYGON, LOCAL_CHAIN_IDS, TEST } = require("./config");

// Load all markets or specific market from environment
const config = require("./config");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Polygon mainnet addresses
const POLYGON_CTF = POLYGON.CTF;
const POLYGON_AUSDC = POLYGON.AUSDC;

function assertAddress(name, value) {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} is missing or invalid: ${value}`);
  }
}

async function loadMarkets() {
  // Check if specific market ID is provided via environment variable
  const targetMarketId = process.env.MARKET_ID;
  
  if (targetMarketId) {
    const market = await config.getMarketById(targetMarketId);
    if (!market) {
      throw new Error(`Market with ID ${targetMarketId} not found in markets.json`);
    }
    console.log(`Deploying for specific market: ${targetMarketId}`);
    return { raw: null, json: [market] };
  } else {
    // Deploy for all markets
    const markets = await config.getAllMarkets();
    console.log(`Deploying for ${markets.length} markets from markets.json`);
    return { raw: null, json: markets };
  }
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

  const { raw: rawMarkets, json: markets } = await loadMarkets();

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

  // Check if we should use existing factory or deploy new one
  let factory, impl, factoryAddress, implAddress;
  
  const existingFactoryAddress = process.env.FACTORY_ADDRESS;
  const existingImplAddress = process.env.IMPL_ADDRESS;
  
  if (existingFactoryAddress && existingImplAddress) {
    console.log("\n=== Using existing contracts ===");
    console.log(`Using existing YMVault implementation: ${existingImplAddress}`);
    console.log(`Using existing YMVaultFactory: ${existingFactoryAddress}`);
    
    factory = YMVaultFactoryFactory.attach(existingFactoryAddress);
    impl = YMVaultImplFactory.attach(existingImplAddress);
    factoryAddress = existingFactoryAddress;
    implAddress = existingImplAddress;
  } else {
    // Deploy implementation and factory once for all markets
    console.log("\n=== Deploying shared contracts ===");
    console.log("Deploying YMVault implementation...");
    impl = await YMVaultImplFactory.connect(deployer).deploy();
    await impl.waitForDeployment();
    implAddress = await impl.getAddress();
    console.log(`YMVault implementation deployed at: ${implAddress}`);

    console.log("Deploying YMVaultFactory...");
    factory = await YMVaultFactoryFactory.connect(deployer).deploy(
      implAddress,
      deployer.address,
      ""
    );
    await factory.waitForDeployment();
    factoryAddress = await factory.getAddress();
    console.log(`YMVaultFactory deployed at: ${factoryAddress}`);
    
    console.log("\n💡 To reuse these contracts in future deployments, use:");
    console.log(`   FACTORY_ADDRESS=${factoryAddress} IMPL_ADDRESS=${implAddress} ...`);
  }

  const deployments = [];
  console.log("\n=== Deploying market vaults ===");
  
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
    // Minters already set by factory
    
    deployments.push({
      marketId: market.id,
      vaultAddress: deployedAddress,
      factoryAddress: factoryAddress,
      implementationAddress: implAddress
    });
  }

  // Update markets.json with new vault addresses
  console.log("\n=== Deployment Summary ===");
  for (const deployment of deployments) {
    console.log(`Market: ${deployment.marketId}`);
    console.log(`  Vault: ${deployment.vaultAddress}`);
    console.log(`  Factory: ${deployment.factoryAddress}`);
    console.log(`  Implementation: ${deployment.implementationAddress}`);
  }

  // Optionally update markets.json with new vault addresses
  if (process.env.UPDATE_MARKETS_JSON === "true") {
    console.log("\nUpdating markets.json with new vault addresses...");
    updateMarketsJson(deployments);
  } else {
    console.log("\nSkipping markets.json update. Set UPDATE_MARKETS_JSON=true to update the file.");
  }
}

function updateMarketsJson(deployments) {
  try {
    const marketsPath = path.join(__dirname, "../../markets.json");
    const marketsData = JSON.parse(fs.readFileSync(marketsPath, "utf8"));
    
    // Update vault addresses
    for (const deployment of deployments) {
      const market = marketsData.find(m => m.id === deployment.marketId);
      if (market) {
        market.vault_address = deployment.vaultAddress;
      }
    }
    
    // Write back to file with proper formatting
    fs.writeFileSync(marketsPath, JSON.stringify(marketsData, null, 2));
    console.log("Successfully updated markets.json");
  } catch (error) {
    console.error("Failed to update markets.json:", error.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});


