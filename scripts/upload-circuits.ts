// One-time, throttled circuit uploader for devnet.
//
// WHY THIS EXISTS: `arcium test -c devnet` calls the SDK's uploadCircuit with
// chunkSize=500, which fires all ~350 upload txs in a single Promise.all burst
// and 429-storms Helius's free tier. This script spreads the same txs into
// small sequential batches with a delay + a fresh blockhash per batch.
//
// It also HEALS the partial state left by the crashed run: store_prediction's
// raw-circuit account was allocated to full size but never populated, so the
// SDK's "account already full-size -> skip upload" shortcut would otherwise
// finalize a corrupt circuit. Here we force-upload every chunk regardless.
//
// Run (ts-mocha, from project root, with devnet RPC + wallet in env):
//   ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" ANCHOR_WALLET=~/.config/solana/id.json \
//     yarn ts-mocha -p ./tsconfig.json -t 100000000 scripts/upload-circuits.ts
// Tunables: UPLOAD_BATCH (default 5), UPLOAD_DELAY_MS (default 300).

import * as anchor from "@anchor-lang/core";
import { Transaction } from "@solana/web3.js";
import {
  getArciumProgram,
  getCompDefAccOffset,
  getCompDefAccAddress,
  getMXEAccAddress,
  getLookupTableAddress,
  getCircuitState,
  uploadCircuit,
} from "@arcium-hq/client";
import * as fs from "fs";

const MAX_UPLOAD_PER_TX_BYTES = 814;
const BATCH = Number(process.env.UPLOAD_BATCH ?? 5);
const DELAY_MS = Number(process.env.UPLOAD_DELAY_MS ?? 300);
const COMMIT = "confirmed" as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("throttled circuit upload (devnet, one-time)", () => {
  it("uploads store_prediction + check_prediction circuits, paced", async function () {
    this.timeout(100000000);

    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const owner = (provider.wallet as anchor.Wallet).payer;
    const arcium = getArciumProgram(provider);

    const idl = JSON.parse(
      fs.readFileSync("target/idl/shroudline.json", "utf-8"),
    );
    const program = new anchor.Program(idl, provider);
    const programId = program.programId;

    const t0 = Date.now();
    console.log(
      `RPC host: ${new URL(provider.connection.rpcEndpoint).host} | batch=${BATCH} delay=${DELAY_MS}ms`,
    );

    // Fresh blockhash, cached briefly so we don't spam getLatestBlockhash.
    let bh: { blockhash: string; lastValidBlockHeight: number } | null = null;
    let bhAt = 0;
    const freshBlockhash = async () => {
      if (!bh || Date.now() - bhAt > 8000) {
        bh = await provider.connection.getLatestBlockhash(COMMIT);
        bhAt = Date.now();
      }
      return bh;
    };

    const sendPaced = async (tx: Transaction) => {
      const b = await freshBlockhash();
      tx.recentBlockhash = b.blockhash;
      tx.lastValidBlockHeight = b.lastValidBlockHeight;
      return provider.sendAndConfirm(tx, [], {
        skipPreflight: true,
        preflightCommitment: COMMIT,
        commitment: COMMIT,
      });
    };

    const compDefState = async (name: string) => {
      const offset = Buffer.from(getCompDefAccOffset(name)).readUInt32LE(0);
      const pda = getCompDefAccAddress(programId, offset);
      const info = await provider.connection.getAccountInfo(pda);
      if (!info) return { offset, pda, exists: false, state: null as any };
      const acc = await arcium.account.computationDefinitionAccount.fetch(pda);
      return {
        offset,
        pda,
        exists: true,
        state: getCircuitState(acc.circuitSource as any),
      };
    };

    // ---- store_prediction: comp def already inited + raw acc already sized
    //      by the crashed run, but bytes are missing -> force-upload + finalize.
    {
      const name = "store_prediction";
      const raw = fs.readFileSync(`build/${name}.arcis`);
      const { offset, state } = await compDefState(name);
      if (state === "OnchainFinalized") {
        console.log(`${name}: already Finalized — skipping.`);
      } else {
        const nTx = Math.ceil(raw.length / MAX_UPLOAD_PER_TX_BYTES);
        console.log(`${name}: force-uploading ${nTx} chunks (state=${state})`);
        for (let i = 0; i < nTx; i += BATCH) {
          const batch: Promise<string>[] = [];
          for (let j = i; j < Math.min(i + BATCH, nTx); j++) {
            const start = j * MAX_UPLOAD_PER_TX_BYTES;
            const slice = raw.subarray(start, start + MAX_UPLOAD_PER_TX_BYTES);
            const bytes = Buffer.alloc(MAX_UPLOAD_PER_TX_BYTES);
            bytes.set(slice);
            const tx = await arcium.methods
              .uploadCircuit(offset, programId, 0, Array.from(bytes), start)
              .accounts({ signer: owner.publicKey })
              .transaction();
            batch.push(sendPaced(tx));
          }
          await Promise.all(batch);
          bh = null; // force a new blockhash next batch
          if ((i / BATCH) % 10 === 0) {
            console.log(`  ${name}: ${Math.min(i + BATCH, nTx)}/${nTx} chunks`);
          }
          await sleep(DELAY_MS);
        }
        const finTx = await arcium.methods
          .finalizeComputationDefinition(offset, programId)
          .accounts({ signer: owner.publicKey })
          .transaction();
        await sendPaced(finTx);
        console.log(`${name}: uploaded + finalized.`);
      }
    }

    // ---- check_prediction: clean slate. Init comp def (user program) then use
    //      the SDK uploader with a small chunkSize (39 txs finish well within
    //      one blockhash, so no custom loop needed).
    {
      const name = "check_prediction";
      const s = await compDefState(name);
      if (s.state === "OnchainFinalized") {
        console.log(`${name}: already Finalized — skipping.`);
      } else {
        if (!s.exists) {
          const mxeAccount = getMXEAccAddress(programId);
          const mxeAcc = await arcium.account.mxeAccount.fetch(mxeAccount);
          const lut = getLookupTableAddress(programId, (mxeAcc as any).lutOffsetSlot);
          const sig = await program.methods
            .initCheckPredictionCompDef()
            .accountsPartial({
              compDefAccount: s.pda,
              payer: owner.publicKey,
              mxeAccount,
              addressLookupTable: lut,
            })
            .signers([owner])
            .rpc({ commitment: COMMIT });
          console.log(`${name}: init comp def sig ${sig}`);
        }
        const raw = fs.readFileSync(`build/${name}.arcis`);
        await uploadCircuit(provider, name, programId, raw, true, BATCH, {
          skipPreflight: true,
          preflightCommitment: COMMIT,
          commitment: COMMIT,
        });
        console.log(`${name}: uploaded + finalized.`);
      }
    }

    console.log(`\nDONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  });
});
