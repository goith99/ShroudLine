// ShroudLine background worker — continuous market creation + adaptive resolution.
//
// Two independent loops in one long-running Node process (Railway-friendly):
//   LOOP A (every MARKET_CREATION_INTERVAL_MS): create a Market for every
//           upcoming World Cup fixture that doesn't have one yet.
//   LOOP B (base tick SHORT_POLL_INTERVAL_MS, with per-market backoff): resolve
//           markets as soon as their match finalises on the TxLINE feed.
//
// It reuses the exact logic already proven in the repo's one-shot scripts:
//   * schedule fetch + market creation  -> scripts/sync-schedule.mjs
//   * final-proof fetch (game_finalised) -> scripts/fetch-proof.ts
//   * outcome derivation + resolve_match_v2 -> scripts/resolve-market.mjs
// (kept in sync here rather than imported, because those are a ts-mocha file and
// top-level-await scripts, not importable modules — see the DONE report note).
//
// IMPORTANT — this targets the DEPLOYED (old-layout) program. It decodes Market
// accounts with scripts/idl-live-snapshot.json — a FROZEN copy of the live
// program's IDL (77-byte Market), confirmed to decode the on-chain accounts.
// It deliberately does NOT read target/idl/shroudline.json, which `arcium build`
// overwrites (the parimutuel redesign in this repo regenerates it to the new
// 94-byte layout). Freezing the snapshot keeps the worker correct regardless of
// what happens to target/idl later. init_market / resolve_match_v2 instruction
// shapes are identical across both layouts, so building those txs is unaffected.
//
// Run:  node worker/index.mjs           (real)
//       DRY_RUN=1 node worker/index.mjs (read-only: fetch, decode, log — never send)
//
// ---------------------------------------------------------------------------
// ENVIRONMENT VARIABLES (see worker/README.md for full details)
//   TXLINE_API_TOKEN          (required) TxLINE X-Api-Token.
//   ANCHOR_PROVIDER_URL       (required) devnet RPC URL.
//   WORKER_FUNDER_KEYPAIR     (required on Railway) JSON array of 64 secret-key
//                             bytes — funds fees + tops up per-fixture authorities.
//   WORKER_AUTHORITY_SEED     (required) STABLE master seed for deterministic
//                             per-fixture authorities. MUST NEVER change or be
//                             lost — any market created under it becomes
//                             permanently unresolvable if the seed is lost.
//   WORKER_EXISTING_AUTHORITIES (optional) Keys for markets created BEFORE this
//                             worker (their random authorities can't be re-derived
//                             from the seed). Needed to resolve the pre-existing
//                             backlog on Railway, where the local
//                             scripts/demo-market-authority-<fixtureId>.json files
//                             don't exist. Exact shape: a JSON object mapping the
//                             fixture id (string) to that market's authority
//                             secret key as a 64-number array — e.g.
//                               {"18175918":[12,244,...,7],"18179549":[9,1,...,88]}
//                             Generate it locally with:
//                               node scripts/pack-existing-authorities.mjs
//                             (writes the value to a gitignored file; never prints
//                             the secret bytes). Locally the *-authority-*.json
//                             files are used directly, so this is only for Railway.
//   COMPETITION_ID            (optional, default 72 = World Cup)
//   PE_HOME_KEY / PE_AWAY_KEY (optional, default 6001/6002)
//   DRY_RUN=1                 (optional) read-only: fetch/decode/log, never send.
// ---------------------------------------------------------------------------

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import BNmod from "bn.js";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const { AnchorProvider, Program, Wallet } = anchor;
const BN = BNmod.default ?? BNmod;

// ===========================================================================
// TUNABLES — all polling/timing knobs live here so they're easy to find & change
// ===========================================================================
const MARKET_CREATION_INTERVAL_MS = 10 * 60 * 1000; // LOOP A cadence: 10 minutes
const SHORT_POLL_INTERVAL_MS = 25_000;              // LOOP B base tick / "match likely just ended" cadence
const LONG_POLL_INTERVAL_MS = 300_000;              // LOOP B backoff cadence once a match is long overdue

const RESOLVE_MIN_AGE_MS = 80 * 60 * 1000;          // don't attempt before kickoff + 80 min
const RESOLVE_ACTIVE_UNTIL_MS = 4 * 60 * 60 * 1000; // "active" resolution window ends kickoff + 4h
const CREATE_CUTOFF_MS = 48 * 60 * 60 * 1000;       // never create a market >48h after kickoff

const DEFAULT_STAKE_LAMPORTS = 10_000_000;          // 0.01 SOL fixed per-prediction stake
const AUTHORITY_FUNDING_LAMPORTS = 0.05 * LAMPORTS_PER_SOL; // top-up target for a per-fixture authority
const MIN_AUTHORITY_BALANCE_LAMPORTS = 0.02 * LAMPORTS_PER_SOL; // top up when below this

// ASSUME_KNOCKOUT — every market this worker creates is is_knockout=true.
// !!! REVISIT !!! Valid ONLY because, as of this worker's creation (July 2026),
// the World Cup competition (id 72) is PAST the group stage: every remaining
// fixture is a knockout tie that can go to extra time / penalties, and a
// knockout market can never settle as a DRAW. If a group-stage-only competition
// is ever added, this MUST become per-fixture (derived from the round) or group
// draws will be unresolvable. Grep this file for ASSUME_KNOCKOUT.
const ASSUME_KNOCKOUT = true;

// ===========================================================================
// CONSTANTS (match the existing scripts exactly)
// ===========================================================================
const API_ORIGIN = "https://txline-dev.txodds.com";
const COMPETITION_ID = Number(process.env.COMPETITION_ID || "72"); // 72 = World Cup
const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

// Penalty-shootout goal keys (+6000 offset). Inferred, overridable via env — same
// caveat as scripts/fetch-proof.ts (not yet verified against a real FPE fixture).
const PE_HOME_KEY = Number(process.env.PE_HOME_KEY || "6001");
const PE_AWAY_KEY = Number(process.env.PE_AWAY_KEY || "6002");

const KEY_HOME_GOALS = 1;
const KEY_AWAY_GOALS = 2;
const OUTCOME_HOME = 0;
const OUTCOME_AWAY = 1;
const OUTCOME_DRAW = 2;
const OUTCOME_NAME = ["HOME_WIN", "AWAY_WIN", "DRAW"];

// Deployed (old-layout) Market account byte length: 8 disc + 69 INIT_SPACE.
const MARKET_ACCOUNT_LEN = 8 + 69;
const RESOLVE_CU_LIMIT = 1_400_000; // V2 multi-stat verification exceeds the 200k default

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

// ===========================================================================
// Logging
// ===========================================================================
const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), ...a);
const warn = (...a) => console.warn(ts(), "WARN", ...a);
const err = (...a) => console.error(ts(), "ERROR", ...a);

// ===========================================================================
// Keypairs & authorities
// ===========================================================================

// Funder wallet — pays tx fees and tops up per-fixture authorities.
// Railway: WORKER_FUNDER_KEYPAIR = JSON array of 64 secret-key bytes (same shape
// as ~/.config/solana/id.json). Local: falls back to ANCHOR_WALLET path, then
// ~/.config/solana/id.json.
function loadFunderKeypair() {
  const raw = process.env.WORKER_FUNDER_KEYPAIR;
  if (raw && raw.trim()) {
    const t = raw.trim();
    if (!t.startsWith("[")) {
      throw new Error("WORKER_FUNDER_KEYPAIR must be a JSON array of secret-key bytes");
    }
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(t)));
  }
  const file = process.env.ANCHOR_WALLET || path.join(os.homedir(), ".config/solana/id.json");
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(file, "utf8"))));
  }
  if (DRY_RUN) {
    warn("no funder keypair found; using an ephemeral one (DRY_RUN never sends)");
    return Keypair.generate();
  }
  throw new Error("No funder keypair: set WORKER_FUNDER_KEYPAIR (or ANCHOR_WALLET)");
}

// Master seed for deterministic per-fixture authority derivation. A per-fixture
// authority must be recoverable AFTER a Railway restart (the fs is ephemeral and
// the saved keypair files are gitignored) or the market it created could never
// be resolved. So we derive it deterministically from a stable secret.
// WORKER_AUTHORITY_SEED MUST stay constant forever — rotating it orphans every
// market created under the old seed.
const AUTHORITY_SEED = (() => {
  const s = process.env.WORKER_AUTHORITY_SEED;
  if (s && s.trim()) return s.trim();
  if (DRY_RUN) {
    warn("WORKER_AUTHORITY_SEED not set; using a dummy seed (DRY_RUN only)");
    return "DRY_RUN_DUMMY_SEED";
  }
  throw new Error("WORKER_AUTHORITY_SEED is required (stable master seed for per-fixture authorities)");
})();

// Explicitly-provided authorities for markets created BEFORE this worker (whose
// random keys can't be re-derived from the seed). See WORKER_EXISTING_AUTHORITIES
// in the header. Parsed once, at startup, so a malformed value fails fast.
const EXISTING_AUTHORITIES = (() => {
  const map = new Map();
  const raw = process.env.WORKER_EXISTING_AUTHORITIES;
  if (!raw || !raw.trim()) return map;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`WORKER_EXISTING_AUTHORITIES is not valid JSON: ${e.message}`);
  }
  for (const [fixtureId, secret] of Object.entries(obj)) {
    try {
      map.set(String(fixtureId), Keypair.fromSecretKey(new Uint8Array(secret)));
    } catch (e) {
      throw new Error(`WORKER_EXISTING_AUTHORITIES["${fixtureId}"] is not a valid 64-byte secret key: ${e.message}`);
    }
  }
  return map;
})();

function authorityFile(fixtureId) {
  return path.join(SCRIPTS_DIR, `demo-market-authority-${fixtureId}.json`);
}

// One-time-per-fixture log of where a fixture's authority came from — useful to
// confirm from Railway logs that env-provided keys (not wrong derived ones) are
// being used for the pre-existing backlog.
const authoritySourceLogged = new Set();
function noteAuthoritySource(fixtureId, source) {
  if (authoritySourceLogged.has(fixtureId)) return;
  authoritySourceLogged.add(fixtureId);
  log(`authority for fixture ${fixtureId}: source=${source}`);
}

// Per-fixture authority, in priority order:
//   1. WORKER_EXISTING_AUTHORITIES env map — pre-existing markets whose random
//      keys can't be re-derived (this is how the backlog is resolved on Railway);
//   2. local scripts/demo-market-authority-<fixtureId>.json — same purpose for
//      local runs, and keeps parity with sync-schedule.mjs / resolve-market.mjs;
//   3. deterministic derivation from the master seed — Railway-safe across
//      restarts for markets this worker creates itself.
function deriveAuthority(fixtureId) {
  const fromEnv = EXISTING_AUTHORITIES.get(String(fixtureId));
  if (fromEnv) {
    noteAuthoritySource(fixtureId, "env(WORKER_EXISTING_AUTHORITIES)");
    return fromEnv;
  }
  const file = authorityFile(fixtureId);
  if (fs.existsSync(file)) {
    try {
      const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(file, "utf8"))));
      noteAuthoritySource(fixtureId, "file");
      return kp;
    } catch (e) {
      warn(`authority file ${file} unreadable (${e.message}); deriving deterministically`);
    }
  }
  const seed = crypto.createHash("sha256").update(`${AUTHORITY_SEED}:${fixtureId}`).digest();
  const kp = Keypair.fromSeed(seed.subarray(0, 32));
  noteAuthoritySource(fixtureId, "derived(seed)");
  // Best-effort persist for parity with the existing scripts (harmless if the fs
  // is read-only or wiped — the derivation reproduces the identical key anyway).
  // NEVER write during DRY_RUN: it must be strictly read-only, and writing a
  // dummy-seed key here would shadow the real key on a later run (file-first).
  if (!DRY_RUN) {
    try {
      fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
    } catch {
      /* ephemeral fs — fine, deterministic derivation covers us */
    }
  }
  return kp;
}

// ===========================================================================
// Solana wiring
// ===========================================================================
const funder = loadFunderKeypair();
const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(funder), { commitment: "confirmed" });
hardenProviderForDevnet(provider);
// Frozen snapshot of the live/deployed program IDL (see header note). NOT
// target/idl, which arcium build overwrites with the parimutuel layout.
const LIVE_IDL_PATH = path.join(SCRIPTS_DIR, "idl-live-snapshot.json");
const idl = JSON.parse(fs.readFileSync(LIVE_IDL_PATH, "utf8"));
const program = new Program(idl, provider);
const PROGRAM_ID = program.programId;

// Devnet blockhash-propagation hardening (same technique as scripts/real-resolve.ts).
function hardenProviderForDevnet(p) {
  const raw = p.sendAndConfirm.bind(p);
  p.sendAndConfirm = async (tx, signers, opts) => {
    const bh = await p.connection.getLatestBlockhash("finalized");
    if (!("message" in tx)) {
      tx.recentBlockhash = bh.blockhash;
      tx.lastValidBlockHeight = bh.lastValidBlockHeight;
    }
    return raw(tx, signers, {
      preflightCommitment: "confirmed",
      commitment: "confirmed",
      ...(opts ?? {}),
      blockhash: { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
    });
  };
}

function marketPda(authorityPk, fixtureId) {
  const fidLe = Buffer.alloc(8);
  fidLe.writeBigInt64LE(BigInt(fixtureId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), authorityPk.toBuffer(), fidLe],
    PROGRAM_ID,
  )[0];
}
function vaultPda(market) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    PROGRAM_ID,
  )[0];
}

// Fetch every current-layout Market (mirrors frontend fetchAllMarkets): filter by
// the exact deployed byte length, decode one at a time, skip anything that
// doesn't decode (legacy 76/78-byte or foreign accounts).
async function fetchAllMarkets() {
  const raw = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: MARKET_ACCOUNT_LEN }],
  });
  const out = [];
  for (const { pubkey, account } of raw) {
    try {
      const m = program.coder.accounts.decode("market", account.data);
      out.push({
        pubkey,
        authority: m.authority, // PublicKey
        fixtureId: m.fixtureId.toString(),
        resolved: m.resolved,
        outcome: m.outcome,
        isKnockout: m.isKnockout,
      });
    } catch {
      /* legacy/foreign account — ignore */
    }
  }
  return out;
}

async function ensureAuthorityFunded(authority) {
  const bal = await connection.getBalance(authority.publicKey);
  if (bal >= MIN_AUTHORITY_BALANCE_LAMPORTS) return;
  const topUp = Math.ceil(AUTHORITY_FUNDING_LAMPORTS - bal);
  if (DRY_RUN) {
    log(`[DRY_RUN] would fund authority ${authority.publicKey.toBase58()} with ${topUp} lamports`);
    return;
  }
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: authority.publicKey,
      lamports: topUp,
    }),
  );
  await provider.sendAndConfirm(tx, [funder]);
  log(`funded authority ${authority.publicKey.toBase58()} with ${topUp} lamports`);
}

// ===========================================================================
// TxLINE API (guest JWT + X-Api-Token) — same auth/headers as scripts/fetch-proof.ts
// ===========================================================================

// Token source: process.env first (Railway), then the local .env file (dev
// convenience, matching the existing scripts). VALUE is never logged.
function getApiToken() {
  if (process.env.TXLINE_API_TOKEN && process.env.TXLINE_API_TOKEN.trim()) {
    return process.env.TXLINE_API_TOKEN.trim();
  }
  try {
    const m = fs
      .readFileSync(path.join(REPO_ROOT, ".env"), "utf8")
      .match(/^TXLINE_API_TOKEN=(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    /* no .env */
  }
  return null;
}

async function fetchGuestHeaders() {
  const apiToken = getApiToken();
  if (!apiToken) throw new Error("TXLINE_API_TOKEN not set (env or .env)");
  const res = await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" });
  if (!res.ok) throw new Error(`guest/start ${res.status}`);
  const jwt = (await res.json()).token;
  return { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };
}

// A cache of fixtureId -> { startTime(ms), home, away }, refreshed by LOOP A.
const scheduleMap = new Map();

async function refreshSchedule() {
  const headers = await fetchGuestHeaders();
  const res = await fetch(
    `${API_ORIGIN}/api/fixtures/snapshot?competitionId=${COMPETITION_ID}`,
    { headers },
  );
  if (!res.ok) throw new Error(`fixtures/snapshot ${res.status}`);
  const fixtures = JSON.parse(await res.text());
  if (!Array.isArray(fixtures)) throw new Error("fixtures/snapshot: expected an array");
  let logged = false;
  let n = 0;
  for (const f of fixtures) {
    if (!f.Participant1 || !f.Participant2) continue; // participants not yet confirmed
    // One-time raw dump so the field shape can be confirmed from logs (per the
    // "don't guess field names" rule). Fields used: FixtureId, StartTime(ms),
    // Participant1/2, Participant1IsHome — same as scripts/sync-schedule.mjs.
    if (!logged && !scheduleSnapshotDumped) {
      log("sample raw fixture:", JSON.stringify(f));
      scheduleSnapshotDumped = true;
      logged = true;
    }
    const home = f.Participant1IsHome ? f.Participant1 : f.Participant2;
    const away = f.Participant1IsHome ? f.Participant2 : f.Participant1;
    scheduleMap.set(String(f.FixtureId), { startTime: Number(f.StartTime), home, away });
    n++;
  }
  return n;
}
let scheduleSnapshotDumped = false;

// Fetch the V2 stat-validation proof for a fixture ONLY IF the match has
// finalised. Returns the proof payload, or null if not finished yet / no data.
// Mirrors scripts/fetch-proof.ts, but is strict: no game_finalised event => null
// (the one-shot script assumed the match was already over; the worker must not).
async function fetchFinalProof(headers, fixtureId) {
  const histRes = await fetch(`${API_ORIGIN}/api/scores/historical/${fixtureId}`, { headers });
  if (!histRes.ok) return null; // no feed data yet
  const histText = await histRes.text();
  const events = histText
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(5).trim());
      } catch {
        return null;
      }
    })
    .filter((x) => x !== null);
  const fin = [...events].reverse().find((e) => /final/i.test(e.Action || ""));
  if (!fin) return null; // match not finalised — do nothing this cycle

  const seq = Number(fin.Seq);
  const homeGoals = Number(fin.Stats?.["1"] ?? 0);
  const awayGoals = Number(fin.Stats?.["2"] ?? 0);
  const levelAtFinal = homeGoals === awayGoals;

  const fetchSV = async (statKeys) => {
    const url =
      `${API_ORIGIN}/api/scores/stat-validation` +
      `?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys.join(",")}`;
    const res = await fetch(url, { headers });
    return { ok: res.ok, status: res.status, text: await res.text() };
  };

  let statKeys = levelAtFinal ? [1, 2, PE_HOME_KEY, PE_AWAY_KEY] : [1, 2];
  let r = await fetchSV(statKeys);
  if (!r.ok && statKeys.length === 4) {
    statKeys = [1, 2]; // no shootout leaves (genuine draw or PE offset wrong)
    r = await fetchSV(statKeys);
  }
  if (!r.ok) return null;
  const sv = JSON.parse(r.text);
  return { seq, statKeys, ...sv };
}

// Build resolve_match_v2 args + accounts from a proof payload (mirrors
// scripts/resolve-market.mjs). Returns everything needed to submit + a human desc.
function buildResolve(sv) {
  const node = (n) => ({ hash: n.hash, isRightSibling: n.isRightSibling });
  const targetTs = Number(sv.summary.updateStats.minTimestamp);
  const epochDay = Math.floor(targetTs / 86_400_000);
  const dayLe = Buffer.alloc(2);
  dayLe.writeUInt16LE(epochDay);
  const dailyPda = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), dayLe],
    TXORACLE,
  )[0];

  const fixtureSummary = {
    fixtureId: new BN(sv.summary.fixtureId),
    updateStats: {
      updateCount: sv.summary.updateStats.updateCount,
      minTimestamp: new BN(sv.summary.updateStats.minTimestamp),
      maxTimestamp: new BN(sv.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: sv.summary.eventStatsSubTreeRoot,
  };
  const stats = sv.statsToProve.map((stat, i) => ({
    stat: { key: stat.key, value: stat.value, period: stat.period },
    statProof: sv.statProofs[i].map(node),
  }));
  const byKey = (k) => stats.find((s) => s.stat.key === k);
  const home = byKey(KEY_HOME_GOALS).stat.value;
  const away = byKey(KEY_AWAY_GOALS).stat.value;

  let claimedOutcome;
  let desc;
  const isShootout = stats.length === 4 && byKey(PE_HOME_KEY) && byKey(PE_AWAY_KEY);
  if (isShootout) {
    const hp = byKey(PE_HOME_KEY).stat.value;
    const ap = byKey(PE_AWAY_KEY).stat.value;
    claimedOutcome = hp > ap ? OUTCOME_HOME : OUTCOME_AWAY;
    desc = `level ${home}-${away} AET, shootout ${hp}-${ap}`;
  } else {
    claimedOutcome = home > away ? OUTCOME_HOME : home < away ? OUTCOME_AWAY : OUTCOME_DRAW;
    desc = `${home}-${away}`;
  }
  return { node, targetTs, dailyPda, fixtureSummary, stats, claimedOutcome, desc };
}

// ===========================================================================
// LOOP A — market creation
// ===========================================================================
async function createMarket(fixtureId, info) {
  const authority = deriveAuthority(fixtureId);
  const market = marketPda(authority.publicKey, fixtureId);
  const vault = vaultPda(market);
  const iso = new Date(info.startTime).toISOString();

  const existing = await connection.getAccountInfo(market);
  if (existing) {
    log(`= skip ${info.home} vs ${info.away} (${fixtureId}): market already exists ${market.toBase58()}`);
    return;
  }
  if (DRY_RUN) {
    log(`[DRY_RUN] would create market: ${info.home} vs ${info.away} (${fixtureId}) @ ${iso} under authority ${authority.publicKey.toBase58()} -> ${market.toBase58()}`);
    return;
  }
  await ensureAuthorityFunded(authority);
  const sig = await program.methods
    .initMarket(new BN(fixtureId), new BN(DEFAULT_STAKE_LAMPORTS), ASSUME_KNOCKOUT)
    .accountsPartial({
      authority: authority.publicKey,
      market,
      vault,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc({ commitment: "confirmed" });
  log(`+ CREATED market ${market.toBase58()} — ${info.home} vs ${info.away} (${fixtureId}) kickoff ${iso}  tx=${sig}`);
}

async function marketCreationCycle() {
  const n = await refreshSchedule(); // also keeps scheduleMap warm for LOOP B
  const markets = await fetchAllMarkets();
  const existingFixtureIds = new Set(markets.map((m) => m.fixtureId));
  const now = Date.now();

  let considered = 0;
  let tooOld = 0;
  for (const [fixtureId, info] of scheduleMap) {
    try {
      if (now > info.startTime + CREATE_CUTOFF_MS) {
        tooOld++; // finished long before the worker existed — don't retro-create
        continue;
      }
      considered++;
      if (existingFixtureIds.has(fixtureId)) {
        log(`= skip ${info.home} vs ${info.away} (${fixtureId}): a market already exists for this fixture`);
        continue;
      }
      await createMarket(fixtureId, info);
    } catch (e) {
      err(`[create] fixture ${fixtureId} failed: ${e.message}`);
      // continue to the next fixture — one failure must not stop the batch
    }
  }
  log(`[create] cycle done: schedule=${n} confirmed, considered=${considered}, skipped-too-old(>48h)=${tooOld}`);
}

// ===========================================================================
// LOOP B — adaptive resolution
// ===========================================================================
const lastAttemptAt = new Map(); // fixtureId -> ms of last resolution attempt
const noKeyLogged = new Set();   // fixtureIds we've already warned we can't sign for

async function attemptResolve(m, info, headers) {
  const authority = deriveAuthority(m.fixtureId);
  if (!authority.publicKey.equals(m.authority)) {
    if (!noKeyLogged.has(m.fixtureId)) {
      warn(`cannot resolve fixture ${m.fixtureId} (market ${m.pubkey.toBase58()}): its authority ${m.authority.toBase58()} is not controlled by this worker (created externally; keypair unavailable here) — skipping permanently`);
      noKeyLogged.add(m.fixtureId);
    }
    return;
  }

  const sv = await fetchFinalProof(headers, m.fixtureId);
  if (!sv) return; // not finalised yet — nothing to do this cycle

  const b = buildResolve(sv);
  const label = info ? `${info.home} vs ${info.away}` : "(teams unknown)";

  if (DRY_RUN) {
    log(`[DRY_RUN] fixture ${m.fixtureId} (${label}) FINALISED — would resolve as ${OUTCOME_NAME[b.claimedOutcome]} [${b.desc}] on market ${m.pubkey.toBase58()} (no tx sent)`);
    return;
  }

  const sig = await program.methods
    .resolveMatchV2(
      b.claimedOutcome,
      new BN(b.targetTs),
      b.fixtureSummary,
      sv.subTreeProof.map(b.node),
      sv.mainTreeProof.map(b.node),
      sv.eventStatRoot,
      b.stats,
    )
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: RESOLVE_CU_LIMIT })])
    .accountsPartial({
      authority: authority.publicKey,
      market: m.pubkey,
      dailyScoresRoots: b.dailyPda,
      txoracleProgram: TXORACLE,
    })
    .signers([authority])
    .rpc({ commitment: "confirmed", skipPreflight: false });

  log(`*** RESOLVED fixture ${m.fixtureId} (${label}) -> ${OUTCOME_NAME[b.claimedOutcome]} [${b.desc}] | market ${m.pubkey.toBase58()} | tx=${sig} — CLAIMS ARE NOW OPEN ***`);
}

async function resolutionCycle() {
  const markets = (await fetchAllMarkets()).filter((m) => !m.resolved);
  if (markets.length === 0) return;

  // Make sure we know kickoff times for all unresolved markets.
  if (markets.some((m) => !scheduleMap.has(m.fixtureId))) {
    try {
      await refreshSchedule();
    } catch (e) {
      warn(`[resolve] schedule refresh failed: ${e.message}`);
    }
  }

  const now = Date.now();
  let headers = null; // fetched lazily, only if at least one market is due
  for (const m of markets) {
    try {
      const info = scheduleMap.get(m.fixtureId);
      let inActiveWindow;
      if (info) {
        const sinceKickoff = now - info.startTime;
        if (sinceKickoff < RESOLVE_MIN_AGE_MS) continue; // too early (before kickoff+80m)
        inActiveWindow = sinceKickoff <= RESOLVE_ACTIVE_UNTIL_MS;
      } else {
        // Unknown kickoff — e.g. a market created before this worker started,
        // whose fixture has since dropped off the (upcoming-only) snapshot. We
        // can't time-gate it, so poll on the slow backoff cadence; fetchFinalProof
        // self-gates (returns null until the match actually finalises), so this
        // is safe even if the fixture were somehow still in the future.
        inActiveWindow = false;
      }

      const last = lastAttemptAt.get(m.fixtureId) ?? 0;
      if (!inActiveWindow && now - last < LONG_POLL_INTERVAL_MS) {
        continue; // overdue / unknown-kickoff -> back off to LONG_POLL cadence
      }

      lastAttemptAt.set(m.fixtureId, now);
      if (!headers) headers = await fetchGuestHeaders();
      await attemptResolve(m, info, headers);
    } catch (e) {
      err(`[resolve] fixture ${m.fixtureId} failed: ${e.message}`);
      // continue to the next market — one failure must not block others or crash
    }
  }
}

// ===========================================================================
// Loop runner + process lifecycle
// ===========================================================================
function startLoop(name, fn, intervalMs, runImmediately) {
  let running = false;
  const tick = async () => {
    if (running) {
      warn(`[${name}] previous cycle still running — skipping this tick`);
      return;
    }
    running = true;
    try {
      await fn();
    } catch (e) {
      err(`[${name}] cycle error: ${e.stack || e.message}`);
    } finally {
      running = false;
    }
  };
  if (runImmediately) void tick();
  setInterval(() => void tick(), intervalMs);
  log(`[${name}] loop started (every ${intervalMs} ms)`);
}

function logStartupEnv() {
  const present = (k) => (process.env[k] && String(process.env[k]).length > 0 ? "present" : "MISSING");
  log("ShroudLine worker starting.");
  log(`env: TXLINE_API_TOKEN=${getApiToken() ? "present" : "MISSING"}` +
      ` ANCHOR_PROVIDER_URL=${present("ANCHOR_PROVIDER_URL")}` +
      ` WORKER_FUNDER_KEYPAIR=${present("WORKER_FUNDER_KEYPAIR")}` +
      ` ANCHOR_WALLET=${present("ANCHOR_WALLET")}` +
      ` WORKER_AUTHORITY_SEED=${present("WORKER_AUTHORITY_SEED")}` +
      ` WORKER_EXISTING_AUTHORITIES=${EXISTING_AUTHORITIES.size > 0 ? `present(${EXISTING_AUTHORITIES.size} keys)` : "MISSING"}` +
      ` DRY_RUN=${DRY_RUN}`);
  log(`config: program=${PROGRAM_ID.toBase58()} rpc=${RPC} competition=${COMPETITION_ID} funder=${funder.publicKey.toBase58()}`);
}

async function main() {
  logStartupEnv();

  // Keep the process alive through unexpected errors in either loop.
  process.on("unhandledRejection", (e) => err(`unhandledRejection: ${e?.stack || e}`));
  process.on("uncaughtException", (e) => err(`uncaughtException: ${e?.stack || e}`));
  process.on("SIGTERM", () => { log("SIGTERM — shutting down"); process.exit(0); });
  process.on("SIGINT", () => { log("SIGINT — shutting down"); process.exit(0); });

  // Prime the schedule so LOOP B has kickoff times immediately.
  try {
    const n = await refreshSchedule();
    log(`initial schedule loaded: ${n} confirmed fixtures for competition ${COMPETITION_ID}`);
  } catch (e) {
    warn(`initial schedule load failed (loops will retry): ${e.message}`);
  }

  startLoop("create", marketCreationCycle, MARKET_CREATION_INTERVAL_MS, true);
  startLoop("resolve", resolutionCycle, SHORT_POLL_INTERVAL_MS, true);
}

main();
