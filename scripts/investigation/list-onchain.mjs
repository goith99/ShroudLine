// List every on-chain Market for the shroudline program with decoded state.
import { Connection, PublicKey } from "@solana/web3.js";
import anchorPkg from "@anchor-lang/core";
const { Program } = anchorPkg;
import fs from "fs";

const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const idl = JSON.parse(fs.readFileSync("target/idl/shroudline.json", "utf8"));
const program = new Program(idl, { connection: conn });
const PROGRAM_ID = new PublicKey(idl.address);

const disc = idl.accounts.find((a) => a.name === "Market").discriminator;
const bs58 = (await import("bs58")).default;
const raw = await conn.getProgramAccounts(PROGRAM_ID, {
  filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(disc)) } }],
});
console.log("raw Market accounts:", raw.length);
for (const { pubkey, account } of raw) {
  try {
    const m = program.coder.accounts.decode("market", account.data);
    console.log(
      `market=${pubkey.toBase58()} fixture=${m.fixtureId.toString()} authority=${m.authority.toBase58()} resolved=${m.resolved} outcome=${m.outcome} review=${m.needsManualReview} knockout=${m.isKnockout} picks=${m.predictionCount.toString()} totalStaked=${m.totalStaked.toString()} bytes=${account.data.length}`,
    );
  } catch (e) {
    console.log(`market=${pubkey.toBase58()} LEGACY/undecodable bytes=${account.data.length}`);
  }
}
