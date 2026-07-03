// Create a fresh open market for a real fixture so the frontend shows team
// names instead of "Demo market".
//
// The deployer's own (authority, fixture_id) Market PDA for 18179759 is
// occupied by a legacy-layout account from an old program deploy, so this
// script creates the market under a dedicated authority keypair instead
// (PDA seeds include the authority). The keypair is saved next to this
// script — resolve_match later needs its signature.
//
// Run from repo root:
//   node scripts/create-market.mjs            # fixture 18179759 (Mexico vs Ecuador)
//   FIXTURE_ID=18179550 node scripts/create-market.mjs
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import anchorPkg from "@anchor-lang/core";
const { AnchorProvider, Program, Wallet, BN } = anchorPkg;
import fs from "fs";
import os from "os";

const FIXTURE_ID = Number(process.env.FIXTURE_ID || "18179759");
const STAKE = new BN(0.01 * LAMPORTS_PER_SOL);
const IS_KNOCKOUT = true; // World Cup Round of 32
const AUTHORITY_FUNDING = 0.05 * LAMPORTS_PER_SOL;
const AUTHORITY_FILE = new URL(`./demo-market-authority-${FIXTURE_ID}.json`, import.meta.url).pathname;
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

const deployer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8"))),
);

// Reuse the saved authority on reruns so we don't strand keys.
let authority;
if (fs.existsSync(AUTHORITY_FILE)) {
  authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(AUTHORITY_FILE, "utf8"))));
  console.log("reusing saved authority", authority.publicKey.toBase58());
} else {
  authority = Keypair.generate();
  fs.writeFileSync(AUTHORITY_FILE, JSON.stringify(Array.from(authority.secretKey)));
  console.log("new authority", authority.publicKey.toBase58(), "saved to", AUTHORITY_FILE);
}

const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(authority), { commitment: "confirmed" });
const idl = JSON.parse(fs.readFileSync("target/idl/shroudline.json", "utf8"));
const program = new Program(idl, provider);

const fidLe = Buffer.alloc(8);
fidLe.writeBigInt64LE(BigInt(FIXTURE_ID));
const [market] = PublicKey.findProgramAddressSync(
  [Buffer.from("market"), authority.publicKey.toBuffer(), fidLe],
  program.programId,
);
const [vault] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), market.toBuffer()],
  program.programId,
);

const existing = await connection.getAccountInfo(market);
if (existing) {
  console.log("market already exists:", market.toBase58(), `(${existing.data.length} bytes) — nothing to do`);
  process.exit(0);
}

const authorityBalance = await connection.getBalance(authority.publicKey);
if (authorityBalance < AUTHORITY_FUNDING) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: deployer.publicKey,
      toPubkey: authority.publicKey,
      lamports: AUTHORITY_FUNDING - authorityBalance,
    }),
  );
  await sendAndConfirmTransaction(connection, tx, [deployer], { commitment: "confirmed" });
  console.log(`funded authority with ${(AUTHORITY_FUNDING - authorityBalance) / LAMPORTS_PER_SOL} SOL from deployer`);
}

const sig = await program.methods
  .initMarket(new BN(FIXTURE_ID), STAKE, IS_KNOCKOUT)
  .accountsPartial({
    authority: authority.publicKey,
    market,
    vault,
    systemProgram: SystemProgram.programId,
  })
  .signers([authority])
  .rpc({ commitment: "confirmed" });

const m = await program.account.market.fetch(market);
console.log("created market:", market.toBase58());
console.log("  tx:", sig);
console.log("  fixtureId:", m.fixtureId.toString(), "stake:", m.stakeAmount.toString(), "knockout:", m.isKnockout, "resolved:", m.resolved);
console.log(`frontend URL: /market/${market.toBase58()}`);
