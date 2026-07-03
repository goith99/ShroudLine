// Resolve a create-market.mjs market through the REAL Txoracle validate_stat
// CPI (no test bypass), signing with the market's own per-fixture authority
// keypair saved by create-market.mjs. Reads scripts/proof-<fixture>.json
// produced by fetch-proof.ts. Both proofs on hand are clean home wins
// (home goals > away goals), so this proves OUTCOME_HOME_WIN via subtract > 0.
//
// Run from repo root (Helius RPC is steadier than the public devnet endpoint):
//   FIXTURE_ID=18179759 ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" node scripts/resolve-market.mjs
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import anchorPkg from "@anchor-lang/core";
const { AnchorProvider, Program, Wallet, BN } = anchorPkg;
import fs from "fs";

const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const FIXTURE_ID = Number(process.env.FIXTURE_ID || "18179759");
const OUTCOME_HOME_WIN = 0;
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

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
if (!(sv.statToProve.value > sv.statToProve2.value)) {
  throw new Error(
    `proof is not a home win (home=${sv.statToProve.value} away=${sv.statToProve2.value}); this script only proves HOME_WIN`,
  );
}

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

// daily_scores_roots PDA for the proof's own epoch day (Txoracle-owned).
const epochDay = Math.floor(Number(sv.ts) / 86_400_000);
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
const statA = {
  statToProve: sv.statToProve,
  eventStatRoot: sv.eventStatRoot,
  statProof: sv.statProof.map(node),
};
const statB = {
  statToProve: sv.statToProve2,
  eventStatRoot: sv.eventStatRoot,
  statProof: sv.statProof2.map(node),
};

console.log(
  `Proving HOME WIN: home(key1)=${sv.statToProve.value} - away(key2)=${sv.statToProve2.value} > 0`,
);
const sig = await program.methods
  .resolveMatch(
    OUTCOME_HOME_WIN,
    new BN(sv.ts),
    fixtureSummary,
    sv.subTreeProof.map(node),
    sv.mainTreeProof.map(node),
    { threshold: 0, comparison: { greaterThan: {} } },
    statA,
    statB,
    { subtract: {} },
  )
  .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
  .accountsPartial({
    authority: authority.publicKey,
    market,
    dailyScoresRoots: dailyPda,
    txoracleProgram: TXORACLE,
  })
  .signers([authority])
  .rpc({ commitment: "confirmed", skipPreflight: false });

console.log("resolve_match sig:", sig);
const after = await program.account.market.fetch(market);
console.log("RESOLVED:", after.resolved, "| outcome:", after.outcome, "(0=HOME_WIN)");
