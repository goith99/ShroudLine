import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getArciumProgramId,
  getCompDefAccOffset,
  getCompDefAccAddress,
  getRawCircuitAccAddress,
} from "@arcium-hq/client";

const RPC = process.env.INSPECT_RPC || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("6pL5a3nAUGa8Gfnkz1K936quUJs59aXe8Ybekk7aWD5a");
const HEADER = 8 + 1; // DISCRIMINATOR(8) + BUMP(1) = RAW_CIRCUIT_ACCOUNT_HEADER_SIZE
const MAX_UPLOAD_PER_TX_BYTES = 814;

const conn = new Connection(RPC, "confirmed");
console.log("Arcium program:", getArciumProgramId().toBase58());
console.log("RPC host:", new URL(RPC).host, "\n");

for (const name of ["store_prediction", "check_prediction"]) {
  const arcis = fs.readFileSync(`build/${name}.arcis`);
  const offset = Buffer.from(getCompDefAccOffset(name)).readUInt32LE(0);
  const compDefPda = getCompDefAccAddress(PROGRAM_ID, offset);
  const rawPda = getRawCircuitAccAddress(compDefPda, 0);
  const compDef = await conn.getAccountInfo(compDefPda);
  const raw = await conn.getAccountInfo(rawPda);
  const requiredRawSize = arcis.length + HEADER;
  const uploadTxs = Math.ceil(arcis.length / MAX_UPLOAD_PER_TX_BYTES);

  console.log(`── ${name} ──`);
  console.log(`  arcis bytes:        ${arcis.length}  (${uploadTxs} upload txs)`);
  console.log(`  compDef PDA:        ${compDefPda.toBase58()}  exists=${!!compDef}`);
  console.log(`  rawCircuit PDA:     ${rawPda.toBase58()}  exists=${!!raw}`);
  if (raw) {
    console.log(`  rawCircuit size:    ${raw.data.length}  (required ${requiredRawSize})`);
    console.log(`  SIZE-SKIP HAZARD:   ${raw.data.length >= requiredRawSize ? "YES — SDK would skip upload (partial/corrupt risk)" : "no — SDK would still upload"}`);
  }
  console.log("");
}
