import fs from "fs";
import os from "os";
import path from "path";
import pkg from "@anchor-lang/core";
const { Program, AnchorProvider, Wallet, BN, web3 } = pkg;
const { Connection, PublicKey, Keypair } = web3;

const idl = JSON.parse(fs.readFileSync("./target/idl/shroudline.json", "utf8"));
const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const DAILY_SCORES = new PublicKey("69SexUQvQ9uNpyx6bgDLVoQ5uKkbn3uRxZXCJ5KVZ7QL"); // epochDay 20635
const FIXTURE_ID = new BN("18179759");

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const provider = new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" });
const program = new Program(idl, provider);

const zero32 = Array.from(Buffer.alloc(32));
const fidLe = Buffer.alloc(8); fidLe.writeBigInt64LE(BigInt(FIXTURE_ID.toString()));

const [market] = PublicKey.findProgramAddressSync(
  [Buffer.from("market"), kp.publicKey.toBuffer(), fidLe], program.programId);
const [vault] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), market.toBuffer()], program.programId);
console.log("authority:", kp.publicKey.toBase58());
console.log("market PDA:", market.toBase58());

// 1) init_market (idempotent-ish: skip if exists)
const existing = await conn.getAccountInfo(market);
if (!existing) {
  const sig = await program.methods.initMarket(FIXTURE_ID, new BN(10_000_000))
    .accounts({ authority: kp.publicKey, market, vault, systemProgram: web3.SystemProgram.programId })
    .rpc();
  console.log("init_market sig:", sig);
} else {
  console.log("market already initialized, skipping init");
}

// 2) resolve_match with DUMMY but structurally-valid proof -> probes CPI dispatch
const fixtureSummary = {
  fixtureId: FIXTURE_ID,
  updateStats: { updateCount: 1, minTimestamp: new BN(0), maxTimestamp: new BN(0) },
  eventsSubTreeRoot: zero32,
};
const predicate = { threshold: 0, comparison: { greaterThan: {} } };
const statA = {
  statToProve: { key: 1, value: 1, period: 0 },
  eventStatRoot: zero32,
  statProof: [],
};

console.log("\n--- sending resolve_match (dummy proof) ---");
try {
  const sig = await program.methods.resolveMatch(
    0,                 // claimed_outcome = home
    new BN("1782864000000"), // ts = epochDay 20635 in ms
    fixtureSummary,
    [],                // fixture_proof
    [],                // main_tree_proof
    predicate,
    statA,
    null,              // stat_b
    null,              // op
  ).accounts({
    authority: kp.publicKey,
    market,
    dailyScoresRoots: DAILY_SCORES,
    txoracleProgram: TXORACLE,
  }).rpc({ skipPreflight: false, commitment: "confirmed" });
  console.log("resolve_match SUCCEEDED, sig:", sig);
  const m = await program.account.market.fetch(market);
  console.log("market.resolved:", m.resolved, "outcome:", m.outcome);
} catch (e) {
  console.log("resolve_match FAILED (expected with dummy proof).");
  console.log("error name:", e.constructor?.name);
  console.log("message:", (e.message||"").split("\n")[0]);
  const logs = e.logs || e.transactionLogs || (e.getLogs && await e.getLogs());
  if (logs) { console.log("\n=== PROGRAM LOGS ==="); for (const l of logs) console.log(l); }
  else console.log("no logs on error object; raw:", JSON.stringify(e).slice(0,500));
}
