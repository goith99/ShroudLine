// First genuine oracle-verified settlement: resolve a real market using a real
// TxLINE Merkle proof (not the test bypass). Reads scripts/proof-<fixture>.json
// produced by fetch-proof.ts. Run:
//   NODE_OPTIONS="--dns-result-order=ipv4first" \
//     ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" ANCHOR_WALLET=~/.config/solana/id.json \
//     yarn ts-mocha -p ./tsconfig.json -t 100000000 scripts/real-resolve.ts

import * as anchor from "@anchor-lang/core";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as BNmod from "bn.js";
import * as fs from "fs";

const BN: any = (BNmod as any).default ?? BNmod;

const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const FIXTURE = Number(process.env.FIXTURE_ID || "18179759");
const STAKE = new BN(0.01 * LAMPORTS_PER_SOL);
const OUTCOME_HOME_WIN = 0;

describe("real oracle-verified resolve (devnet)", () => {
  it("resolves a market through the real Txoracle validate_stat CPI", async function () {
    this.timeout(100000000);
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const owner = (provider.wallet as anchor.Wallet).payer;
    const idl = JSON.parse(
      fs.readFileSync("target/idl/prediction_settlement.json", "utf-8"),
    );
    const program = new anchor.Program(idl, provider);
    const programId = program.programId;
    const sv = JSON.parse(fs.readFileSync(`scripts/proof-${FIXTURE}.json`, "utf-8"));

    // devnet-hardened send; preflight ON so a validate_stat rejection shows logs.
    const rawSAC = provider.sendAndConfirm.bind(provider);
    (provider as any).sendAndConfirm = async (tx: any, s?: any, o?: any) => {
      const bh = await provider.connection.getLatestBlockhash("finalized");
      if (!("message" in tx)) {
        tx.recentBlockhash = bh.blockhash;
        tx.lastValidBlockHeight = bh.lastValidBlockHeight;
      }
      return rawSAC(tx, s, {
        preflightCommitment: "confirmed",
        commitment: "confirmed",
        ...(o ?? {}),
        blockhash: {
          blockhash: bh.blockhash,
          lastValidBlockHeight: bh.lastValidBlockHeight,
        },
      });
    };

    const fidLe = Buffer.alloc(8);
    fidLe.writeBigInt64LE(BigInt(FIXTURE));
    const market = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), owner.publicKey.toBuffer(), fidLe],
      programId,
    )[0];
    const vault = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), market.toBuffer()],
      programId,
    )[0];

    const existing = await provider.connection.getAccountInfo(market);
    if (!existing) {
      const sig = await program.methods
        .initMarket(new BN(FIXTURE), STAKE)
        .accountsPartial({
          authority: owner.publicKey,
          market,
          vault,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });
      console.log("init_market sig:", sig);
    } else {
      const m: any = await (program.account as any).market.fetch(market);
      console.log("market exists; resolved =", m.resolved, "outcome =", m.outcome);
      if (m.resolved) return;
    }

    // daily_scores_roots PDA for the proof's own day
    const epochDay = Math.floor(Number(sv.ts) / 86_400_000);
    const dayLe = Buffer.alloc(2);
    dayLe.writeUInt16LE(epochDay);
    const dailyPda = PublicKey.findProgramAddressSync(
      [Buffer.from("daily_scores_roots"), dayLe],
      TXORACLE,
    )[0];
    const dailyInfo = await provider.connection.getAccountInfo(dailyPda);
    console.log(
      `epochDay=${epochDay} dailyPda=${dailyPda.toBase58()} exists=${!!dailyInfo}`,
    );

    const node = (n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling });
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
      .accountsPartial({
        authority: owner.publicKey,
        market,
        dailyScoresRoots: dailyPda,
        txoracleProgram: TXORACLE,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed", skipPreflight: false });
    console.log("resolve_match sig:", sig);

    const m: any = await (program.account as any).market.fetch(market);
    console.log("RESOLVED:", m.resolved, "| outcome:", m.outcome, "(0=HOME_WIN)");
  });
});
