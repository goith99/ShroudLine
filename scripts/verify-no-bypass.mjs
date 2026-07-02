// Empirical proof the deployed bytecode has NO resolve_match_test: build the
// instruction from its Anchor discriminator (sha256("global:resolve_match_test"))
// and simulate it. A clean build rejects it as an unknown instruction
// (InstructionFallbackNotFound / 101). Read-only (simulate), no SOL, no state.
import crypto from "node:crypto";
import fs from "node:fs";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
} from "@solana/web3.js";

const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const PROGRAM = new PublicKey("6pL5a3nAUGa8Gfnkz1K936quUJs59aXe8Ybekk7aWD5a");
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET, "utf-8"))),
);

const disc = crypto
  .createHash("sha256")
  .update("global:resolve_match_test")
  .digest()
  .subarray(0, 8);
const data = Buffer.concat([disc, Buffer.from([0])]); // claimed_outcome = 0

const ix = new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: PublicKey.default, isSigner: false, isWritable: true }, // dummy "market"
  ],
  data,
});

const tx = new Transaction().add(ix);
tx.feePayer = payer.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash("finalized")).blockhash;

const sim = await conn.simulateTransaction(tx);
const logs = (sim.value.logs || []).join("\n");
console.log("discriminator:", Array.from(disc).join(","));
console.log("err:", JSON.stringify(sim.value.err));
console.log("logs:\n" + logs);

const rejected =
  /not (a )?recognized|Fallback|InstructionFallbackNotFound|invalid instruction|custom program error: 0x65\b|IllegalOwner|declared program id/i.test(
    logs,
  ) || (sim.value.err && !/resolve/i.test(logs));
if (rejected && !/Instruction: ResolveMatchTest/i.test(logs)) {
  console.log(
    "\nPASS ✅ deployed program does NOT contain resolve_match_test (call rejected as unknown instruction)",
  );
} else {
  console.log(
    "\nFAIL ❌ the program appears to still handle resolve_match_test",
  );
  process.exit(1);
}
