/*
Test-only script: send Polymarket ERC1155 positions (YES/NO) to a recipient.

Requirements:
  - ALLOW_TEST_SCRIPTS=true
  - Local hardhat or forked network (chainId 1337/31337)

Behavior:
  - Uses TEST.PRIVATE_KEY as signer (owner EOA)
  - Tries to transfer from owner directly; if insufficient balance, searches owner's Safes on Polygon
  - If a Safe holds sufficient balance, builds and executes a Safe execTransaction to transfer token

Usage:
  ALLOW_TEST_SCRIPTS=true hardhat run test/scripts/send-position-token.js --network localhost

Notes:
  - Market params are fetched from Gamma API; prefers clobTokenIds
  - CTF address comes from test/scripts/config.js (POLYGON.CTF)
  - Safe lookup queries Safe Transaction Service (Polygon)
  - For execTransaction this script uses pre-validated signature if owner is a Safe owner and threshold=1
*/

const { ethers, network } = require("hardhat");
const https = require("https");
const path = require("path");
const { POLYGON, LOCAL_CHAIN_IDS, TEST } = require("./config");

const DEFAULT_POLYGON_RPC = process.env.RPC_URL || "https://polygon-rpc.com";
const CTF = POLYGON.CTF;

const CTF_ABI = [
  "function getCollectionId(bytes32 parent, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
];

const SAFE_ABI = [
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getNonce() view returns (uint256)",
  "function domainSeparator() view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
];

const SAFE_TS = "https://safe-transaction-polygon.safe.global";

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
    return input; // assume slug
  }
}

async function getSafesByOwner(owner) {
  const ownerChecksum = ethers.getAddress(owner);
  const url = `${SAFE_TS}/api/v1/owners/${ownerChecksum}/safes/`;
  const data = await getJson(url);
  return Array.isArray(data.safes) ? data.safes : [];
}

async function fetchMarketParams(arg) {
  const slug = extractSlug(arg);
  const apiUrl = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`;
  const meta = await getJson(apiUrl);
  let candidates = [];
  if (Array.isArray(meta)) candidates = meta;
  if (Array.isArray(meta?.markets)) candidates = candidates.concat(meta.markets);
  if (Array.isArray(meta?.data)) candidates = candidates.concat(meta.data);
  if (Object.prototype.toString.call(meta) === '[object Object]') candidates.push(meta);
  const pick = candidates.find((x) => x && (x.condition_id || x.conditionId));
  const m = pick || candidates[0];
  if (!m) throw new Error("No market metadata found");
  const conditionId = m.condition_id || m.conditionId;
  const collateralToken = m.erc20CollateralAddress || m.collateralToken || m.collateral_token || m.collateral || m.token || POLYGON.USDC;
  if (!conditionId) throw new Error("Missing conditionId in market metadata");

  const provider = new ethers.JsonRpcProvider(DEFAULT_POLYGON_RPC);
  const ctf = new ethers.Contract(CTF, CTF_ABI, provider);

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
    const noCol = await ctf.getCollectionId(ethers.ZeroHash, conditionId, 2);
    yesPositionId = await ctf.getPositionId(collateralToken, yesCol);
    noPositionId = await ctf.getPositionId(collateralToken, noCol);
  }
  return { conditionId, collateralToken, yesPositionId, noPositionId };
}

// No CLI args in fixed-mode

async function main() {
  if (process.env.ALLOW_TEST_SCRIPTS !== "true") {
    throw new Error("Refusing to run: set ALLOW_TEST_SCRIPTS=true to allow test scripts");
  }
  const chain = await ethers.provider.getNetwork();
  const chainId = Number(chain.chainId);
  if (!LOCAL_CHAIN_IDS.includes(chainId)) {
    throw new Error(`Refusing to run on non-local chainId=${chainId}. Use a local hardhat node or fork.`);
  }

  // Signer from TEST.PRIVATE_KEY (loaded from environment variables)
  if (!TEST.PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(TEST.PRIVATE_KEY)) {
    throw new Error("TEST_PRIVATE_KEY not set or invalid in .env file. Please check your .env configuration.");
  }
  const wallet = new ethers.Wallet(TEST.PRIVATE_KEY, ethers.provider);
  const OWNER = ethers.getAddress(wallet.address);
  const RECIPIENT = ethers.getAddress((await ethers.getSigners())[0].address);
  const blockNumber = await ethers.provider.getBlockNumber();
  console.log("Block number:", blockNumber);
  // Fixed parameters
  const MARKET_INPUT = "https://polymarket.com/event/fed-decision-in-september/fed-decreases-interest-rates-by-50-bps-after-september-2025-meeting?tid=1757740331329";
  const SIDE_MODE = "both"; // "yes" | "no" | "both"
  const AMOUNT_INPUT = null; // null = full balance; or string integer (6 decimals)

  const { yesPositionId, noPositionId } = await fetchMarketParams(MARKET_INPUT);
  console.log("YES/NO positionIds:", yesPositionId.toString(), noPositionId.toString());
  const ctf = new ethers.Contract(CTF, CTF_ABI, ethers.provider);
  const safesAtStart = await getSafesByOwner(OWNER);
  console.log("OWNER Safes:", safesAtStart.map(ethers.getAddress));
  console.log("CTF address:", CTF);
  // Query balances via local provider (requires Polygon fork)
  const codeAtCTF = await ethers.provider.getCode(CTF);
  if (codeAtCTF === "0x") {
    console.log("CTF not deployed on current network; start a Polygon fork to query balances.");
  } else {
    try {
      const ownerYes = await ctf.balanceOf(OWNER, yesPositionId);
      const ownerNo  = await ctf.balanceOf(OWNER, noPositionId);
      console.log("OWNER YES/NO balances:", ownerYes.toString(), ownerNo.toString());
    } catch (e) {
      console.log("OWNER balance query failed:", e.shortMessage || e.message);
    }
    for (const s of safesAtStart) {
      const sa = ethers.getAddress(s);
      try {
        const yBal = await ctf.balanceOf(sa, yesPositionId);
        const nBal = await ctf.balanceOf(sa, noPositionId);
        console.log(`SAFE ${sa} YES/NO balances:`, yBal.toString(), nBal.toString());
      } catch (e) {
        console.log(`SAFE ${sa} balance query failed:`, e.shortMessage || e.message);
      }
    }
  }

  async function transferFrom(from, positionId, desiredAmount, label) {
    const bal = await ctf.balanceOf(from, positionId);
    if (bal === 0n) {
      console.log(`${label}: ${from} has zero balance`);
      return false;
    }
    const amt = desiredAmount ? BigInt(desiredAmount) : bal;
    if (amt > bal) {
      console.log(`${label}: insufficient balance. have=${bal} need=${amt}`);
      return false;
    }
    console.log(`${label}: transferring ${amt} of id=${positionId.toString()} from ${from} -> ${RECIPIENT}`);
    await (
      await ctf
        .connect(wallet)
        .safeTransferFrom(from, RECIPIENT, positionId, amt, "0x")
    ).wait();
    return true;
  }

  async function tryEOAThenSafes(positionId, label) {
    const ok = await transferFrom(OWNER, positionId, AMOUNT_INPUT, `${label}/EOA`);
    if (ok) return true;
    // Fallback: find safes
    const safes = await getSafesByOwner(OWNER);
    if (!safes.length) {
      console.log(`${label}: no Safes for owner; aborting`);
      return false;
    }
    // Try each safe: only proceed if owner is an owner and threshold==1
    for (const s of safes) {
      const safeAddr = ethers.getAddress(s);
      const safe = new ethers.Contract(safeAddr, SAFE_ABI, ethers.provider);
      const bal = await ctf.balanceOf(safeAddr, positionId);
      if (bal === 0n) continue;
      const amt = AMOUNT_INPUT ? BigInt(AMOUNT_INPUT) : bal;
      if (amt > bal) {
        console.log(`${label}/SAFE ${safeAddr}: insufficient balance (have=${bal}, need=${amt})`);
        continue;
      }
      const threshold = await safe.getThreshold();
      const owners = await safe.getOwners();
      const isOwner = owners.map(ethers.getAddress).includes(OWNER);
      if (!isOwner) continue;
      if (Number(threshold) !== 1) {
        console.log(`${label}/SAFE ${safeAddr}: threshold=${threshold} != 1; skipping`);
        continue;
      }
      // Build execTransaction for ERC1155 transfer
      const data = ctf.interface.encodeFunctionData("safeTransferFrom", [safeAddr, RECIPIENT, positionId, amt, "0x"]);
      const toAddr = CTF;
      const value = 0n;
      const operation = 0; // CALL
      const safeTxGas = 0n;
      const baseGas = 0n;
      const gasPrice = 0n;
      const gasToken = ethers.ZeroAddress;
      const refundReceiver = RECIPIENT;

      // Pre-validated signature format for threshold=1 where signer is an owner:
      // bytes: r (owner address), s (zero), v = 1
      // See Safe docs: https://docs.safe.global/
      const ownerBytes32 = ethers.zeroPadValue(OWNER, 32);
      const zero32 = ethers.ZeroHash; // 32-byte zero for 's'
      const v = "0x01"; // 1
      const signatures = ethers.concat([ownerBytes32, zero32, v]);

      console.log(`${label}/SAFE ${safeAddr}: executing execTransaction...`);
      const tx = await safe
        .connect(wallet)
        .execTransaction(
          toAddr,
          value,
          data,
          operation,
          safeTxGas,
          baseGas,
          gasPrice,
          gasToken,
          refundReceiver,
          signatures
        );
      await tx.wait();
      console.log(`${label}/SAFE ${safeAddr}: executed.`);
      return true;
    }
    console.log(`${label}: no Safe with sufficient balance or executable threshold found`);
    return false;
  }

  const sides = SIDE_MODE === "both" ? ["YES", "NO"] : [SIDE_MODE.toUpperCase()];
  for (const s of sides) {
    const pid = s === "YES" ? yesPositionId : noPositionId;
    await tryEOAThenSafes(pid, s);
  }

  // Final balances check (owner and recipient)
  try {
    const ownerYesEnd = await ctf.balanceOf(OWNER, yesPositionId);
    const ownerNoEnd  = await ctf.balanceOf(OWNER, noPositionId);
    console.log("OWNER YES/NO balances (end):", ownerYesEnd.toString(), ownerNoEnd.toString());
  } catch (e) {
    console.log("OWNER end-balance query failed:", e.shortMessage || e.message);
  }

  try {
    const recvYes = await ctf.balanceOf(RECIPIENT, yesPositionId);
    const recvNo  = await ctf.balanceOf(RECIPIENT, noPositionId);
    console.log(`RECIPIENT ${RECIPIENT} YES/NO balances:", ${recvYes.toString()} ${recvNo.toString()}`);
  } catch (e) {
    console.log("RECIPIENT balance query failed:", e.shortMessage || e.message);
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


