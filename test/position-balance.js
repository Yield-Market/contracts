/*
 Utility: Print Polymarket ERC1155 position balances for a wallet (and its Safes) on Polygon.

 Usage:
   node scripts/position-balance.js <owner_eoa>

 Behavior:
   - Queries Safe Transaction Service to find the owner's Safes
   - Scans CTF TransferSingle/TransferBatch logs to discover recent positionIds sent to the owner/Safes
   - For each discovered positionId, prints balances for the owner and each Safe

 Notes:
   - Uses Polygon mainnet CTF address from test/scripts/config.js
   - RPC defaults to https://polygon-rpc.com (override with RPC_URL)
*/

const { ethers } = require("ethers");
const https = require("https");
const path = require("path");

const { POLYGON } = require(path.resolve(__dirname, "../test/scripts/config"));

const DEFAULT_POLYGON_RPC = process.env.RPC_URL || "https://polygon-rpc.com";
const CTF = POLYGON.CTF;

const CTF_ABI = [
  "function getCollectionId(bytes32 parent, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
];

const SAFE_TS = "https://safe-transaction-polygon.safe.global";

// Fixed market URL to inspect
const MARKET_URL = "https://polymarket.com/event/fed-decision-in-september/fed-decreases-interest-rates-by-50-bps-after-september-2025-meeting?tid=1757740331329";

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const { statusCode } = res;
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        if (!statusCode || statusCode < 200 || statusCode >= 300) {
          return reject(new Error(`HTTP ${statusCode} for ${url} Body: ${raw}`));
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
    req.setTimeout(15000, () => req.destroy(new Error("Request timed out")));
  });
}

function extractSlug(input) {
  const u = new URL(input);
  const segments = u.pathname.split("/").filter(Boolean);
  return segments[segments.length - 1];
}

async function getSafesByOwner(owner) {
  const ownerChecksum = ethers.getAddress(owner);
  const url = `${SAFE_TS}/api/v1/owners/${ownerChecksum}/safes/`;
  const data = await getJson(url);
  return Array.isArray(data.safes) ? data.safes : [];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("Usage:\n  node scripts/position-balance.js <owner>");
    process.exit(1);
  }

  const owner = ethers.getAddress(args[0]);
  const provider = new ethers.JsonRpcProvider(DEFAULT_POLYGON_RPC);
  const ctf = new ethers.Contract(CTF, CTF_ABI, provider);

  let info = { ctf: CTF, rpc: DEFAULT_POLYGON_RPC };
  // 1) Discover owner's safes
  const safes = await getSafesByOwner(owner);
  const holders = [owner, ...safes.map(ethers.getAddress)];

  // 2) Fetch market metadata for fixed market
  const slug = extractSlug(MARKET_URL);
  const apiUrl = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`;
  const meta = await getJson(apiUrl);
  let candidates = [];
  if (Array.isArray(meta)) candidates = meta;
  if (Array.isArray(meta?.markets)) candidates = candidates.concat(meta.markets);
  if (Array.isArray(meta?.data)) candidates = candidates.concat(meta.data);
  if (Object.prototype.toString.call(meta) === '[object Object]') candidates.push(meta);
  const pick = candidates.find((x) => x && (x.condition_id || x.conditionId));
  const m = pick || candidates[0];
  if (!m) throw new Error("No market metadata found for fixed market URL");

  const conditionId = m.condition_id || m.conditionId;
  const collateralToken = m.erc20CollateralAddress || m.collateralToken || m.collateral_token || m.collateral || m.token || POLYGON.USDC;
  if (!conditionId) throw new Error("Missing conditionId in market metadata");

  // 3) Prefer API-provided clobTokenIds if present (stringified JSON array [YES, NO])
  let yesPositionId, noPositionId;
  try {
    let clob = m.clobTokenIds;
    if (typeof clob === "string") clob = JSON.parse(clob);
    if (Array.isArray(clob) && clob.length >= 2) {
      yesPositionId = BigInt(clob[0]);
      noPositionId = BigInt(clob[1]);
    }
  } catch {}

  if (yesPositionId === undefined || noPositionId === undefined) {
    const yesCol = await ctf.getCollectionId(ethers.ZeroHash, conditionId, 1);
    const noCol  = await ctf.getCollectionId(ethers.ZeroHash, conditionId, 2);
    yesPositionId = await ctf.getPositionId(collateralToken, yesCol);
    noPositionId  = await ctf.getPositionId(collateralToken, noCol);
  }
  const positionIds = [yesPositionId, noPositionId];
  info = { ...info, slug, conditionId, collateralToken, yesPositionId: yesPositionId.toString(), noPositionId: noPositionId.toString() };

  // Holders: owner + safes
  // holders already defined

  // Query balances for each id
  const results = [];
  for (const h of holders) {
    const balances = {};
    for (const pid of positionIds) {
      const bal = await ctf.balanceOf(h, pid);
      balances[pid.toString()] = bal.toString();
    }
    results.push({ holder: h, balances });
  }

  console.log(JSON.stringify({ ...info, holders: results }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


