// Sync devnet demo markets to TxLINE's official remaining World Cup schedule.
//
// Fetches the fixtures snapshot for the free-tier World Cup competition (72) —
// the same feed TxLINE's /documentation/scores/schedule documents — and creates
// a Market for every remaining (not-yet-kicked-off) confirmed fixture that
// doesn't already have one. Idempotent: re-run any time before the deadline as
// more matches are confirmed; existing markets are left untouched.
//
// Each market is created under a per-fixture authority keypair saved as
// scripts/demo-market-authority-<fixture>.json (resolve-market.mjs needs it).
//
// Run from repo root (Helius RPC is steadier than the public devnet endpoint):
//   ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" node scripts/sync-schedule.mjs
//   DRY_RUN=1 ... node scripts/sync-schedule.mjs      # list only, create nothing
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} from "@solana/web3.js";
import anchorPkg from "@anchor-lang/core";
const { AnchorProvider, Program, Wallet, BN } = anchorPkg;
import fs from "fs";
import os from "os";

const API_ORIGIN = "https://txline-dev.txodds.com";
const COMPETITION = Number(process.env.COMPETITION_ID || "72"); // 72 = World Cup
const STAKE = new BN(0.01 * LAMPORTS_PER_SOL);
const IS_KNOCKOUT = true; // World Cup knockout stage
const AUTHORITY_FUNDING = 0.05 * LAMPORTS_PER_SOL;
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const DRY_RUN = process.env.DRY_RUN === "1";

const token = fs.readFileSync(".env", "utf-8").match(/^TXLINE_API_TOKEN=(.+)$/m)?.[1].trim();
if (!token) throw new Error("TXLINE_API_TOKEN not in .env");

const jwt = (await (await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" })).json()).token;
const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": token };
const fixtures = JSON.parse(
  await (await fetch(`${API_ORIGIN}/api/fixtures/snapshot?competitionId=${COMPETITION}`, { headers })).text(),
);

const now = Date.now();
// Remaining = kicks off in the future, with both participants confirmed.
const remaining = fixtures
  .filter((f) => Number(f.StartTime) > now && f.Participant1 && f.Participant2)
  .sort((a, b) => Number(a.StartTime) - Number(b.StartTime));

console.log(`schedule: ${fixtures.length} fixtures for competition ${COMPETITION}, ${remaining.length} remaining (future, confirmed)`);

const deployer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8"))),
);
const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(deployer), { commitment: "confirmed" });
const idl = JSON.parse(fs.readFileSync("target/idl/shroudline.json", "utf8"));
const program = new Program(idl, provider);

// Emit fixtures.ts-ready metadata alongside the market list.
const metaRows = [];
const created = [];
const skipped = [];

for (const f of remaining) {
  const fixtureId = f.FixtureId;
  const home = f.Participant1IsHome ? f.Participant1 : f.Participant2;
  const away = f.Participant1IsHome ? f.Participant2 : f.Participant1;
  const kickoffUtc = new Date(Number(f.StartTime)).toISOString();
  metaRows.push({ fixtureId, home, away, kickoffUtc });

  const authFile = new URL(`./demo-market-authority-${fixtureId}.json`, import.meta.url).pathname;
  let authority;
  if (fs.existsSync(authFile)) {
    authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(authFile, "utf8"))));
  } else {
    authority = Keypair.generate();
    if (!DRY_RUN) fs.writeFileSync(authFile, JSON.stringify(Array.from(authority.secretKey)));
  }

  const fidLe = Buffer.alloc(8);
  fidLe.writeBigInt64LE(BigInt(fixtureId));
  const [market] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), authority.publicKey.toBuffer(), fidLe], program.programId,
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()], program.programId,
  );

  const existing = await connection.getAccountInfo(market);
  if (existing) {
    skipped.push({ fixtureId, home, away, market: market.toBase58() });
    console.log(`= ${home} vs ${away} (${fixtureId}) already exists ${market.toBase58()}`);
    continue;
  }
  if (DRY_RUN) {
    console.log(`+ would create ${home} vs ${away} (${fixtureId}) @ ${kickoffUtc}`);
    continue;
  }

  const bal = await connection.getBalance(authority.publicKey);
  if (bal < AUTHORITY_FUNDING) {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(SystemProgram.transfer({
        fromPubkey: deployer.publicKey, toPubkey: authority.publicKey,
        lamports: AUTHORITY_FUNDING - bal,
      })),
      [deployer], { commitment: "confirmed" },
    );
  }
  const sig = await program.methods
    .initMarket(new BN(fixtureId), STAKE, IS_KNOCKOUT)
    .accountsPartial({ authority: authority.publicKey, market, vault, systemProgram: SystemProgram.programId })
    .signers([authority])
    .rpc({ commitment: "confirmed" });
  created.push({ fixtureId, home, away, market: market.toBase58() });
  console.log(`+ created ${home} vs ${away} (${fixtureId}) ${market.toBase58()}  tx=${sig}`);
}

console.log(`\nDONE: ${created.length} created, ${skipped.length} already existed.`);
console.log("\n--- fixtures.ts metadata for the remaining schedule ---");
for (const r of metaRows) {
  console.log(`  "${r.fixtureId}": { home: "${r.home}", away: "${r.away}", kickoffUtc: "${r.kickoffUtc}", stage: "World Cup 2026 — Round of 16" },`);
}
