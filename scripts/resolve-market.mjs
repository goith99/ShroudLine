// Resolve a create-market.mjs market through the REAL Txoracle validate_stat_v2
// CPI (no test bypass), signing with the market's own per-fixture authority
// keypair saved by create-market.mjs. Reads scripts/proof-<fixture>.json
// produced by fetch-proof.ts (V2 format: statsToProve[]/statProofs[]).
//
// Handles regulation/ET wins (2 stats) and penalty shootouts (4 stats); the
// claimed outcome is derived from the proven values, and resolve_match_v2 only
// records it if the oracle's Merkle verification agrees.
//
// Run from repo root (Helius RPC is steadier than the public devnet endpoint):
//   FIXTURE_ID=18179759 ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" node scripts/resolve-market.mjs
import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import anchorPkg from "@anchor-lang/core";
const { AnchorProvider, Program, Wallet, BN } = anchorPkg;
import fs from "fs";

const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const FIXTURE_ID = Number(process.env.FIXTURE_ID || "18179759");
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

const OUTCOME_HOME_WIN = 0;
const OUTCOME_AWAY_WIN = 1;
const OUTCOME_DRAW = 2;
const KEY_HOME_GOALS = 1;
const KEY_AWAY_GOALS = 2;
const KEY_HOME_PE = 6001;
const KEY_AWAY_PE = 6002;

const AUTHORITY_FILE = new URL(
  `./demo-market-authority-${FIXTURE_ID}.json`,
  import.meta.url,
).pathname;
if (!fs.existsSync(AUTHORITY_FILE)) {
  throw new Error(`no saved authority ${AUTHORITY_FILE} — run create-market.mjs first`);
}
const authority = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(AUTHORITY_FILE, "utf8"))),
);
const sv = JSON.parse(fs.readFileSync(`scripts/proof-${FIXTURE_ID}.json`, "utf8"));

const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(authority), {
  commitment: "confirmed",
});
const idl = JSON.parse(fs.readFileSync("target/idl/shroudline.json", "utf8"));
const program = new Program(idl, provider);

const fidLe = Buffer.alloc(8);
fidLe.writeBigInt64LE(BigInt(FIXTURE_ID));
const [market] = PublicKey.findProgramAddressSync(
  [Buffer.from("market"), authority.publicKey.toBuffer(), fidLe],
  program.programId,
);

const existing = await connection.getAccountInfo(market);
if (!existing) throw new Error(`market ${market.toBase58()} does not exist — run create-market.mjs`);
const before = await program.account.market.fetch(market);
console.log("market:", market.toBase58(), "resolved:", before.resolved, "picks:", before.predictionCount.toString());
if (before.resolved) {
  console.log("already resolved, outcome =", before.outcome, "— nothing to do");
  process.exit(0);
}

// ts + daily_scores_roots PDA epoch day both come from the batch min timestamp.
const targetTs = Number(sv.summary.updateStats.minTimestamp);
const epochDay = Math.floor(targetTs / 86_400_000);
const dayLe = Buffer.alloc(2);
dayLe.writeUInt16LE(epochDay);
const [dailyPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("daily_scores_roots"), dayLe],
  TXORACLE,
);
const dailyInfo = await connection.getAccountInfo(dailyPda);
console.log(`epochDay=${epochDay} dailyPda=${dailyPda.toBase58()} exists=${!!dailyInfo}`);
if (!dailyInfo) throw new Error("daily_scores_roots PDA not found on this RPC's cluster");

const node = (n) => ({ hash: n.hash, isRightSibling: n.isRightSibling });
const fixtureSummary = {
  fixtureId: new BN(sv.summary.fixtureId),
  updateStats: {
    updateCount: sv.summary.updateStats.updateCount,
    minTimestamp: new BN(sv.summary.updateStats.minTimestamp),
    maxTimestamp: new BN(sv.summary.updateStats.maxTimestamp),
  },
  eventsSubTreeRoot: sv.summary.eventStatsSubTreeRoot,
};

// V2 stats array in the exact key order the program pins.
const stats = sv.statsToProve.map((stat, i) => ({
  stat: { key: stat.key, value: stat.value, period: stat.period },
  statProof: sv.statProofs[i].map(node),
}));
const byKey = (k) => stats.find((s) => s.stat.key === k);
const home = byKey(KEY_HOME_GOALS).stat.value;
const away = byKey(KEY_AWAY_GOALS).stat.value;

let claimedOutcome;
const isShootout = stats.length === 4 && byKey(KEY_HOME_PE) && byKey(KEY_AWAY_PE);
if (isShootout) {
  const homePE = byKey(KEY_HOME_PE).stat.value;
  const awayPE = byKey(KEY_AWAY_PE).stat.value;
  claimedOutcome = homePE > awayPE ? OUTCOME_HOME_WIN : OUTCOME_AWAY_WIN;
  console.log(`Shootout: level ${home}-${away} after ET, PE ${homePE}-${awayPE} -> ${claimedOutcome === OUTCOME_HOME_WIN ? "HOME" : "AWAY"} WIN`);
} else {
  claimedOutcome = home > away ? OUTCOME_HOME_WIN : home < away ? OUTCOME_AWAY_WIN : OUTCOME_DRAW;
  console.log(`Regulation/ET: ${home}-${away} -> ${["HOME", "AWAY", "DRAW"][claimedOutcome]}`);
}

const sig = await program.methods
  .resolveMatchV2(
    claimedOutcome,
    new BN(targetTs),
    fixtureSummary,
    sv.subTreeProof.map(node),
    sv.mainTreeProof.map(node),
    sv.eventStatRoot,
    stats,
  )
  .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
  .accountsPartial({
    authority: authority.publicKey,
    market,
    dailyScoresRoots: dailyPda,
    txoracleProgram: TXORACLE,
  })
  .signers([authority])
  .rpc({ commitment: "confirmed", skipPreflight: false });

console.log("resolve_match_v2 sig:", sig);
const after = await program.account.market.fetch(market);
console.log("RESOLVED:", after.resolved, "| outcome:", after.outcome, "(0=HOME_WIN,1=AWAY_WIN,2=DRAW)");
