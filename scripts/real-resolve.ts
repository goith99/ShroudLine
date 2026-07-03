// Genuine oracle-verified settlement: resolve a real market using a real TxLINE
// V2 Merkle proof (not the test bypass). Reads scripts/proof-<fixture>.json
// produced by fetch-proof.ts and calls resolve_match_v2, which CPIs into
// Txoracle::validate_stat_v2. Run:
//   NODE_OPTIONS="--dns-result-order=ipv4first" \
//     ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" ANCHOR_WALLET=~/.config/solana/id.json \
//     yarn ts-mocha -p ./tsconfig.json -t 100000000 scripts/real-resolve.ts

import * as anchor from "@anchor-lang/core";
import {
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as BNmod from "bn.js";
import * as fs from "fs";

const BN: any = (BNmod as any).default ?? BNmod;

const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const FIXTURE = Number(process.env.FIXTURE_ID || "18179759");
const STAKE = new BN(0.01 * LAMPORTS_PER_SOL);
const KNOCKOUT = process.env.KNOCKOUT === "1" || process.env.KNOCKOUT === "true";

const OUTCOME_HOME_WIN = 0;
const OUTCOME_AWAY_WIN = 1;
const OUTCOME_DRAW = 2;

const KEY_HOME_GOALS = 1;
const KEY_AWAY_GOALS = 2;
const KEY_HOME_PE = 6001;
const KEY_AWAY_PE = 6002;

describe("real oracle-verified resolve (devnet, V2)", () => {
  it("resolves a market through the real Txoracle validate_stat_v2 CPI", async function () {
    this.timeout(100000000);
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const owner = (provider.wallet as anchor.Wallet).payer;
    const idl = JSON.parse(
      fs.readFileSync("target/idl/shroudline.json", "utf-8"),
    );
    const program = new anchor.Program(idl, provider);
    const programId = program.programId;
    const sv = JSON.parse(fs.readFileSync(`scripts/proof-${FIXTURE}.json`, "utf-8"));

    // devnet-hardened send; preflight ON so a validate_stat_v2 rejection shows logs.
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
        .initMarket(new BN(FIXTURE), STAKE, KNOCKOUT)
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

    // ts + daily_scores_roots PDA epoch-day both come from the batch min timestamp.
    const targetTs = Number(sv.summary.updateStats.minTimestamp);
    const epochDay = Math.floor(targetTs / 86_400_000);
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

    // V2 stats array: pair each proven stat with its proof branch, in the exact
    // key order the on-chain program pins (0=home goals, 1=away goals,
    // 2=home PE, 3=away PE).
    const stats = sv.statsToProve.map((stat: any, i: number) => ({
      stat: { key: stat.key, value: stat.value, period: stat.period },
      statProof: sv.statProofs[i].map(node),
    }));

    const byKey = (k: number) => stats.find((s: any) => s.stat.key === k);
    const home = byKey(KEY_HOME_GOALS).stat.value;
    const away = byKey(KEY_AWAY_GOALS).stat.value;

    // Determine the claimed outcome from the proven values.
    let claimedOutcome: number;
    const isShootout = stats.length === 4 && !!byKey(KEY_HOME_PE) && !!byKey(KEY_AWAY_PE);
    if (isShootout) {
      const homePE = byKey(KEY_HOME_PE).stat.value;
      const awayPE = byKey(KEY_AWAY_PE).stat.value;
      claimedOutcome = homePE > awayPE ? OUTCOME_HOME_WIN : OUTCOME_AWAY_WIN;
      console.log(
        `Shootout: level ${home}-${away} after ET, PE ${homePE}-${awayPE} -> ` +
          `${claimedOutcome === OUTCOME_HOME_WIN ? "HOME" : "AWAY"} WIN`,
      );
    } else {
      claimedOutcome =
        home > away
          ? OUTCOME_HOME_WIN
          : home < away
          ? OUTCOME_AWAY_WIN
          : OUTCOME_DRAW;
      console.log(
        `Regulation/ET: ${home}-${away} -> ` +
          `${["HOME", "AWAY", "DRAW"][claimedOutcome]} outcome`,
      );
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
      // V2 multi-stat verification can exceed the 200k default CU limit; TxLINE's
      // own examples use 1.4M.
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ])
      .accountsPartial({
        authority: owner.publicKey,
        market,
        dailyScoresRoots: dailyPda,
        txoracleProgram: TXORACLE,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed", skipPreflight: false });
    console.log("resolve_match_v2 sig:", sig);

    const m: any = await (program.account as any).market.fetch(market);
    console.log(
      "RESOLVED:", m.resolved, "| outcome:", m.outcome,
      "(0=HOME_WIN,1=AWAY_WIN,2=DRAW)",
    );
  });
});
