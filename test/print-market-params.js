/*
 Utility: Print Polymarket market params (conditionId, collateralToken, yes/no positionIds) from a URL or slug.

 Usage:
   node scripts/print-market-params.js <polymarket_url_or_slug>

 Notes:
   - Uses Polygon mainnet CTF address from test/scripts/config.js
   - Reads metadata from Polymarket Gamma API by slug
   - Computes positionIds via CTF.getCollectionId/getPositionId (parentCollectionId = 0x0)
*/

const https = require("https");
const { ethers } = require("ethers");
const path = require("path");

// Reuse addresses from existing config
const { POLYGON } = require(path.resolve(__dirname, "../test/scripts/config"));

const DEFAULT_POLYGON_RPC = process.env.RPC_URL || "https://polygon-rpc.com";
const CTF = POLYGON.CTF;

const CTF_ABI = [
  "function getCollectionId(bytes32 parent, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)",
];

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const { statusCode } = res;
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        if (!statusCode || statusCode < 200 || statusCode >= 300) {
          return reject(new Error(`HTTP ${statusCode} for ${url}`));
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
  try {
    const u = new URL(input);
    const segments = u.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1];
  } catch (_) {
    return input; // assume already a slug
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node scripts/print-market-params.js <polymarket_url_or_slug>");
    process.exit(1);
  }

  const slug = extractSlug(arg);
  const apiUrl = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`;

  const meta = await getJson(apiUrl);
  // Try to find a market object containing a condition id
  let candidates = [];
  if (Array.isArray(meta)) candidates = meta;
  if (Array.isArray(meta?.markets)) candidates = candidates.concat(meta.markets);
  if (Array.isArray(meta?.data)) candidates = candidates.concat(meta.data);
  if (Object.prototype.toString.call(meta) === '[object Object]') candidates.push(meta);

  const pick = candidates.find((x) => x && (x.condition_id || x.conditionId));
  const m = pick || candidates[0];
  if (!m) {
    throw new Error("No market metadata found for given slug");
  }

  const conditionId = m.condition_id || m.conditionId;
  // Try multiple common keys for collateral token; fallback to USDC (Polygon)
  const collateralToken = m.erc20CollateralAddress || m.collateralToken || m.collateral_token || m.collateral || m.token || POLYGON.USDC;
  if (!conditionId) {
    throw new Error("Missing conditionId in market metadata");
  }

  const provider = new ethers.JsonRpcProvider(DEFAULT_POLYGON_RPC);
  const ctf = new ethers.Contract(CTF, CTF_ABI, provider);

  // Prefer clobTokenIds from API if present (stringified JSON array of two ids: [YES, NO])
  let yesPositionId, noPositionId;
  try {
    let clob = m.clobTokenIds;
    if (typeof clob === "string") {
      clob = JSON.parse(clob);
    }
    if (Array.isArray(clob) && clob.length >= 2) {
      yesPositionId = BigInt(clob[0]);
      noPositionId = BigInt(clob[1]);
    }
  } catch (_) {
    // ignore, fallback to compute below
  }

  // Fallback to computing via CTF if clobTokenIds not found
  if (yesPositionId === undefined || noPositionId === undefined) {
    const yesCol = await ctf.getCollectionId(ethers.ZeroHash, conditionId, 1);
    const noCol = await ctf.getCollectionId(ethers.ZeroHash, conditionId, 2);
    yesPositionId = await ctf.getPositionId(collateralToken, yesCol);
    noPositionId = await ctf.getPositionId(collateralToken, noCol);
  }

  const out = {
    conditionId,
    collateralToken,
    yesPositionId: yesPositionId.toString(),
    noPositionId: noPositionId.toString(),
    ctf: CTF,
    rpc: DEFAULT_POLYGON_RPC,
    slug,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


