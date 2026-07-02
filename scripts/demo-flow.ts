// FULL REAL DEMO FLOW (no bypass, no fabricated data), all on live devnet:
//   init_market -> submit_prediction x2 (encrypted, staked, real Arcium MPC)
//   -> resolve_match (REAL Txoracle validate_stat CPI, fixture 18179759)
//   -> settle_prediction x2 (real MPC payout based on the genuine outcome)
//
// Correct predictor guesses HOME_WIN (matches Mexico 2-0 Ecuador); incorrect
// predictor guesses AWAY_WIN. After the real oracle resolves HOME_WIN, MPC pays
// the correct predictor 2x stake and the incorrect one nothing.
//
// Requires TXLINE proof at scripts/proof-18179759.json (from fetch-proof.ts).
// Run:
//   NODE_OPTIONS="--dns-result-order=ipv4first" \
//     ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" ANCHOR_WALLET=~/.config/solana/id.json \
//     yarn ts-mocha -p ./tsconfig.json -t 100000000 scripts/demo-flow.ts

import * as anchor from "@anchor-lang/core";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as BNmod from "bn.js";
import {
  awaitComputationFinalization,
  getComputationAccAddress,
  getClusterAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getMXEPublicKey,
  RescueCipher,
  deserializeLE,
  x25519,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";

const BN: any = (BNmod as any).default ?? BNmod;
const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const PROOF_FIXTURE = Number(process.env.FIXTURE_ID || "18179759");
const STAKE = new BN(0.01 * LAMPORTS_PER_SOL);
const USER_FUNDING = 0.3 * LAMPORTS_PER_SOL;
const OUTCOME_HOME_WIN = 0;
const OUTCOME_AWAY_WIN = 1;
const CLUSTER_OFFSET = Number(process.env.CLUSTER_OFFSET || "456");

describe("FULL real demo flow (submit -> real resolve -> settle)", () => {
  it("runs the genuine end-to-end prediction settlement", async function () {
    this.timeout(100000000);

    // Resilient RPC: undici/IPv6 occasionally throws a transient "fetch failed"
    // on devnet; a single blip would abort the long multi-tx flow. Wrap the
    // Connection's fetch with a small retry so every RPC call self-heals.
    const retryFetch = async (input: any, init?: any): Promise<any> => {
      let lastErr: any;
      for (let i = 0; i < 5; i++) {
        try {
          return await (fetch as any)(input, init);
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 300 * (i + 1)));
        }
      }
      throw lastErr;
    };
    const base = anchor.AnchorProvider.env();
    const connection = new anchor.web3.Connection(base.connection.rpcEndpoint, {
      commitment: "confirmed",
      fetch: retryFetch as any,
    });
    const provider = new anchor.AnchorProvider(connection, base.wallet, base.opts);
    anchor.setProvider(provider);
    const owner = (provider.wallet as anchor.Wallet).payer;
    const idl = JSON.parse(
      fs.readFileSync("target/idl/shroudline.json", "utf-8"),
    );
    const program = new anchor.Program(idl, provider);
    const programId = program.programId;
    const acct = (program as any).account;
    const sv = JSON.parse(
      fs.readFileSync(`scripts/proof-${PROOF_FIXTURE}.json`, "utf-8"),
    );

    const clusterAccount = getClusterAccAddress(CLUSTER_OFFSET);

    // Devnet-hardened send: fresh blockhash + confirm strategy; skipPreflight
    // default true (honor an explicit opt-out for the resolve so its CPI logs
    // surface on rejection).
    const rawSAC = provider.sendAndConfirm.bind(provider);
    (provider as any).sendAndConfirm = async (tx: any, s?: any, o?: any) => {
      const skip = o?.skipPreflight ?? true;
      const bh = await provider.connection.getLatestBlockhash(
        skip ? "confirmed" : "finalized",
      );
      if (!("message" in tx)) {
        tx.recentBlockhash = bh.blockhash;
        tx.lastValidBlockHeight = bh.lastValidBlockHeight;
      }
      return rawSAC(tx, s, {
        preflightCommitment: "confirmed",
        commitment: "confirmed",
        ...(o ?? {}),
        skipPreflight: skip,
        blockhash: {
          blockhash: bh.blockhash,
          lastValidBlockHeight: bh.lastValidBlockHeight,
        },
      });
    };

    // ---- PDAs / helpers ----------------------------------------------------
    const marketFixtureId = new BN(process.env.DEMO_MARKET_ID || Date.now());
    const marketPda = (fid: any) => {
      const le = Buffer.alloc(8);
      le.writeBigInt64LE(BigInt(fid.toString()));
      return PublicKey.findProgramAddressSync(
        [Buffer.from("market"), owner.publicKey.toBuffer(), le],
        programId,
      )[0];
    };
    const vaultPda = (mkt: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), mkt.toBuffer()],
        programId,
      )[0];
    const predictionPda = (mkt: PublicKey, u: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("prediction"), mkt.toBuffer(), u.toBuffer()],
        programId,
      )[0];
    const arciumAccounts = (offset: any, name: string) => ({
      computationAccount: getComputationAccAddress(CLUSTER_OFFSET, offset),
      clusterAccount,
      mxeAccount: getMXEAccAddress(programId),
      mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
      executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
      compDefAccount: getCompDefAccAddress(
        programId,
        Buffer.from(getCompDefAccOffset(name)).readUInt32LE(),
      ),
    });

    const market = marketPda(marketFixtureId);
    const vault = vaultPda(market);
    const userCorrect = Keypair.generate();
    const userIncorrect = Keypair.generate();

    console.log(
      "owner balance:",
      (await provider.connection.getBalance(owner.publicKey)) / LAMPORTS_PER_SOL,
      "SOL | demo market:",
      market.toBase58(),
    );

    // MXE encryption pubkey
    let mxePublicKey: Uint8Array | undefined;
    for (let i = 0; i < 20 && !mxePublicKey; i++) {
      try {
        mxePublicKey = await getMXEPublicKey(provider, programId);
      } catch {
        /* retry */
      }
      if (!mxePublicKey) await new Promise((r) => setTimeout(r, 500));
    }
    if (!mxePublicKey) throw new Error("could not fetch MXE public key");

    const fundFromOwner = async (to: PublicKey, lamports: number) => {
      const tx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports }),
      );
      await provider.sendAndConfirm(tx, [owner]);
    };

    // Return leftover SOL from an ephemeral predictor wallet to the deployer so
    // repeated demo runs (e.g. for recording) don't keep draining it. The owner
    // (provider wallet) is the fee payer, so the user's FULL remaining balance
    // comes back and the throwaway account zeroes out.
    const refundToOwner = async (user: Keypair, label: string): Promise<number> => {
      const bal = await provider.connection.getBalance(user.publicKey);
      if (bal <= 0) return 0;
      const tx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: user.publicKey,
          toPubkey: owner.publicKey,
          lamports: bal,
        }),
      );
      await provider.sendAndConfirm(tx, [user]);
      console.log(
        `  refunded ${bal / LAMPORTS_PER_SOL} SOL from ${label} → deployer`,
      );
      return bal;
    };

    const submitPrediction = async (user: Keypair, value: number) => {
      const priv = x25519.utils.randomSecretKey();
      const pub = x25519.getPublicKey(priv);
      const shared = x25519.getSharedSecret(priv, mxePublicKey!);
      const cipher = new RescueCipher(shared);
      const nonce = randomBytes(16);
      const ciphertext = cipher.encrypt([BigInt(value)], nonce);
      const offset = new BN(randomBytes(8), "hex");
      const sig = await program.methods
        .submitPrediction(
          offset,
          Array.from(ciphertext[0]),
          Array.from(pub),
          new BN(deserializeLE(nonce).toString()),
        )
        .accountsPartial({
          payer: user.publicKey,
          market,
          prediction: predictionPda(market, user.publicKey),
          vault,
          ...arciumAccounts(offset, "store_prediction"),
        })
        .signers([user])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      console.log(`  submit(value=${value}) queue:`, sig.slice(0, 16) + "…");
      await awaitComputationFinalization(provider, offset, programId, "confirmed");
    };

    const settlePrediction = async (user: Keypair) => {
      const offset = new BN(randomBytes(8), "hex");
      const sig = await program.methods
        .settlePrediction(offset)
        .accountsPartial({
          payer: owner.publicKey,
          market,
          prediction: predictionPda(market, user.publicKey),
          vault,
          user: user.publicKey,
          ...arciumAccounts(offset, "check_prediction"),
        })
        .signers([owner])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      console.log("  settle queue:", sig.slice(0, 16) + "…");
      await awaitComputationFinalization(provider, offset, programId, "confirmed");
    };

    // ---- 1) init market ----------------------------------------------------
    await program.methods
      .initMarket(marketFixtureId, STAKE, true) // knockout fixture
      .accountsPartial({
        authority: owner.publicKey,
        market,
        vault,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    console.log("[1] market created + funded");
    await fundFromOwner(userCorrect.publicKey, USER_FUNDING);
    await fundFromOwner(userIncorrect.publicKey, USER_FUNDING);

    // ---- 2) two encrypted predictions -------------------------------------
    console.log("[2] submitting encrypted predictions");
    await submitPrediction(userCorrect, OUTCOME_HOME_WIN); // will be correct
    await submitPrediction(userIncorrect, OUTCOME_AWAY_WIN); // will be wrong

    // ---- 3) REAL oracle resolve -------------------------------------------
    const epochDay = Math.floor(Number(sv.ts) / 86_400_000);
    const dayLe = Buffer.alloc(2);
    dayLe.writeUInt16LE(epochDay);
    const dailyPda = PublicKey.findProgramAddressSync(
      [Buffer.from("daily_scores_roots"), dayLe],
      TXORACLE,
    )[0];
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
      `[3] resolving via REAL Txoracle CPI: home ${sv.statToProve.value} - away ${sv.statToProve2.value} > 0`,
    );
    const rsig = await program.methods
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
      // Two-stat validate_stat (home−away) over a real proof can exceed the 200k
      // default CU limit (e.g. extra-time matches); raise the budget.
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ])
      .accountsPartial({
        authority: owner.publicKey,
        market,
        dailyScoresRoots: dailyPda,
        txoracleProgram: TXORACLE,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed", skipPreflight: false });
    const mResolved: any = await acct.market.fetch(market);
    console.log(
      `    resolved=${mResolved.resolved} outcome=${mResolved.outcome} sig=${rsig.slice(0, 16)}…`,
    );

    // ---- 4) settle both, verify payouts -----------------------------------
    console.log("[4] settling via MPC");
    const c0 = await provider.connection.getBalance(userCorrect.publicKey);
    await settlePrediction(userCorrect);
    const c1 = await provider.connection.getBalance(userCorrect.publicKey);
    const pc: any = await acct.prediction.fetch(
      predictionPda(market, userCorrect.publicKey),
    );

    const i0 = await provider.connection.getBalance(userIncorrect.publicKey);
    await settlePrediction(userIncorrect);
    const i1 = await provider.connection.getBalance(userIncorrect.publicKey);
    const pi: any = await acct.prediction.fetch(
      predictionPda(market, userIncorrect.publicKey),
    );

    console.log("\n===== RESULT =====");
    console.log(
      `correct  predictor: settled=${pc.settled} correct=${pc.correct} delta=${(c1 - c0) / LAMPORTS_PER_SOL} SOL (expect +${(STAKE.toNumber() * 2) / LAMPORTS_PER_SOL})`,
    );
    console.log(
      `incorrect predictor: settled=${pi.settled} correct=${pi.correct} delta=${(i1 - i0) / LAMPORTS_PER_SOL} SOL (expect 0)`,
    );

    // Sweep leftover SOL back to the deployer (before any assertion, so funds are
    // always recovered even if the payout check below fails).
    let recovered = 0;
    recovered += await refundToOwner(userCorrect, "correct predictor");
    recovered += await refundToOwner(userIncorrect, "incorrect predictor");
    console.log(`recovered ${recovered / LAMPORTS_PER_SOL} SOL to deployer`);

    if (
      !(pc.settled && pc.correct && c1 - c0 === STAKE.toNumber() * 2) ||
      !(pi.settled && !pi.correct && i1 - i0 === 0)
    ) {
      throw new Error("payouts did not match expectations");
    }
    console.log("FULL REAL DEMO FLOW PASSED ✅");
  });
});
