/*
 Test-only script: query if an owner EOA has any Safe (Gnosis Safe) addresses on Polygon.

 Requirements:
   - ALLOW_TEST_SCRIPTS=true
   - Local hardhat or forked network (chainId 1337/31337)
   - Node.js 18+ (global fetch available)

 Usage:
   export OWNER="0xYourEOA"
   ALLOW_TEST_SCRIPTS=true npx hardhat run scripts/check-owner-safes.js --network localhost

 Notes:
   - This script is read-only and calls Safe Transaction Service (Polygon) over HTTPS.
   - If OWNER is not provided, it will use the first local signer address (likely no Safes).
*/

const { ethers, network } = require("hardhat");
const { LOCAL_CHAIN_IDS } = require("./scripts/config");
const https = require("https");

const SAFE_TS_BASES = {
  polygon: "https://safe-transaction-polygon.safe.global",
};

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const { statusCode } = res;
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        if (!statusCode || statusCode < 200 || statusCode >= 300) {
          const bodyPreview = raw && raw.length > 0 ? ` Body: ${raw}` : "";
          return reject(new Error(`HTTP ${statusCode} for ${url}.${bodyPreview}`));
        }
        try {
          const json = JSON.parse(raw);
          resolve(json);
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("Request timed out"));
    });
  });
}

async function getSafesByOwner(owner) {
  const url = `${SAFE_TS_BASES.polygon}/api/v1/owners/${owner}/safes/`;
  const data = await getJson(url);
  return Array.isArray(data.safes) ? data.safes : [];
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

  const [firstSigner] = await ethers.getSigners();
  let OWNER_INPUT = process.env.OWNER || firstSigner.address;
  let OWNER;
  try {
    // Normalize to EIP-55 checksum; throws if invalid
    OWNER = ethers.getAddress(OWNER_INPUT);
  } catch (e) {
    throw new Error(`Invalid OWNER address provided: ${OWNER_INPUT}`);
  }

  console.log("Querying Safe addresses on Polygon for owner:", OWNER);

  try {
    const safes = await getSafesByOwner(OWNER);
    const hasSafe = safes.length > 0;
    console.log("Has Safe:", hasSafe);
    console.log("Safes:");
    safes.forEach((s) => console.log("-", s));
    if (!hasSafe) {
      console.log("No Safes found for this owner on Polygon.");
    }
  } catch (e) {
    console.error("Failed to query Safe Transaction Service:", e.message);
    process.exitCode = 1;
  }
}

main();


