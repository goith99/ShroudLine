import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { PredictionSettlement } from "../target/types/prediction_settlement";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  uploadCircuit,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getLookupTableAddress,
  x25519,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";

// ---------------------------------------------------------------------------
// End-to-end test for the Private Prediction Settlement flow:
//
//   init_market
//     -> submit_prediction (encrypted under Arcium MXE, SOL staked)   x2 users
//     -> resolve_match      (real Txoracle validate_stat CPI probe)
//     -> resolve_match_test (feature-gated bypass, sets the outcome)
//     -> settle_prediction  (correct  => 2x payout from vault)
//     -> settle_prediction  (incorrect => no payout)
//
// Notes / why it's shaped this way:
//   * `resolve_match` (the real path) can never return `true` from
//     manufactured proof data — validate_stat verifies against the real
//     on-chain Merkle root, and we have no subscribe token to fetch a genuine
//     proof yet. So the real path is exercised as a CPI-dispatch *probe*: we
//     assert it reaches validate_stat and is rejected at the oracle's own
//     data-consistency checks (this is what retired the CPI risk). To actually
//     flip `market.resolved` and exercise settlement we use the feature-gated
//     `resolve_match_test` bypass (compiled only with `--features test-resolve`,
//     which is currently in `default`; never ship it to mainnet).
//   * The real-CPI probe needs the Txoracle program + a `daily_scores_roots`
//     account, which only exist on devnet — it self-skips on localnet.
//   * Two funded users stake into one market so the vault genuinely holds 2x
//     stake, which is exactly the payout owed to the single correct predictor.
// ---------------------------------------------------------------------------

// Match outcomes (also the plaintext a user encrypts as their prediction).
const OUTCOME_HOME_WIN = 0;
const OUTCOME_AWAY_WIN = 1;

// Txoracle (devnet) — used only by the real-CPI probe.
const TXORACLE_PROGRAM_ID = new PublicKey(
  "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
);

const STAKE = new anchor.BN(0.01 * LAMPORTS_PER_SOL); // 0.01 SOL per prediction
const USER_FUNDING = 0.3 * LAMPORTS_PER_SOL; // covers stake + rent + arcium/tx fees

describe("PredictionSettlement", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace
    .PredictionSettlement as Program<PredictionSettlement>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumProgram = getArciumProgram(provider);

  const arciumEnv = getArciumEnv();
  const clusterOffset = arciumEnv.arciumClusterOffset;
  const clusterAccount = getClusterAccAddress(clusterOffset);

  const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

  // A correct predictor and an incorrect predictor, in the same market.
  const userCorrect = Keypair.generate();
  const userIncorrect = Keypair.generate();

  // Unique fixture id per run so re-runs don't collide on the market PDA.
  const fixtureId = new anchor.BN(Date.now());
  const market = marketPda(owner.publicKey, fixtureId);
  const vault = vaultPda(market);

  let mxePublicKey: Uint8Array;

  // Devnet-hardened tx sending. Anchor's default .rpc()/sendAndConfirm hits
  // "Blockhash not found" (preflight simulation) and "Unknown action" (its
  // confirmTransaction is called without a blockhash strategy) on real devnet,
  // where blockhash propagation isn't instant like the localnet validator. Wrap
  // sendAndConfirm to always attach a fresh blockhash, skip preflight, and pass
  // a proper {blockhash,lastValidBlockHeight} confirm strategy. Same technique
  // proven in scripts/upload-circuits.ts. Covers .rpc() and direct sends.
  before(() => {
    const rawSAC = provider.sendAndConfirm.bind(provider);
    (provider as any).sendAndConfirm = async (
      tx: any,
      signers?: any,
      opts?: any,
    ) => {
      // Default to skipping preflight (avoids devnet "Blockhash not found" on the
      // positive txs), but honor an explicit opt-in to simulation: the negative
      // resolve_match probe needs preflight logs to observe the ValidateStat
      // rejection, because anchor's failed-landed-tx path constructs
      // SendTransactionError with the old positional web3.js API and drops logs.
      const skipPreflight = opts?.skipPreflight ?? true;
      const bh = await provider.connection.getLatestBlockhash(
        skipPreflight ? "confirmed" : "finalized",
      );
      if (!("message" in tx)) {
        // legacy Transaction: pin the fresh blockhash so it matches the strategy
        tx.recentBlockhash = bh.blockhash;
        tx.lastValidBlockHeight = bh.lastValidBlockHeight;
      }
      return rawSAC(tx, signers, {
        preflightCommitment: "confirmed",
        commitment: "confirmed",
        ...(opts ?? {}),
        skipPreflight,
        blockhash: {
          blockhash: bh.blockhash,
          lastValidBlockHeight: bh.lastValidBlockHeight,
        },
      });
    };
  });

  // ----- Arcium computation-definition setup (once) -----------------------

  it("initializes the store/check computation definitions", async () => {
    await ensureCompDef("store_prediction");
    await ensureCompDef("check_prediction");

    mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
    console.log("MXE x25519 pubkey:", Buffer.from(mxePublicKey).toString("hex"));
  });

  // ----- init_market ------------------------------------------------------

  it("creates the market and funds the two predictors", async () => {
    const sig = await program.methods
      .initMarket(fixtureId, STAKE)
      .accountsPartial({
        authority: owner.publicKey,
        market,
        vault,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    console.log("init_market sig:", sig);

    const m = await program.account.market.fetch(market);
    expect(m.fixtureId.toString()).to.equal(fixtureId.toString());
    expect(m.stakeAmount.toString()).to.equal(STAKE.toString());
    expect(m.resolved).to.equal(false);
    expect(m.outcome).to.equal(255); // OUTCOME_UNRESOLVED

    // Fund the two predictors from the owner wallet (transfer, not airdrop, so
    // it works reliably on devnet).
    await fundFromOwner(userCorrect.publicKey, USER_FUNDING);
    await fundFromOwner(userIncorrect.publicKey, USER_FUNDING);
  });

  // ----- submit_prediction (x2) ------------------------------------------

  it("submits an encrypted, staked prediction for the correct user", async () => {
    await submitPrediction(userCorrect, OUTCOME_HOME_WIN);

    const p = await program.account.prediction.fetch(
      predictionPda(market, userCorrect.publicKey),
    );
    expect(p.encrypted).to.equal(true);
    expect(p.settled).to.equal(false);
    expect(p.stake.toString()).to.equal(STAKE.toString());
    // The stored ciphertext must be real MXE state, not the zeroed placeholder.
    expect(p.ciphertext.some((b) => b !== 0)).to.equal(true);
  });

  it("submits an encrypted, staked prediction for the incorrect user", async () => {
    await submitPrediction(userIncorrect, OUTCOME_AWAY_WIN);

    const p = await program.account.prediction.fetch(
      predictionPda(market, userIncorrect.publicKey),
    );
    expect(p.encrypted).to.equal(true);

    // Both stakes are now held in the vault.
    const m = await program.account.market.fetch(market);
    expect(m.predictionCount.toString()).to.equal("2");
    expect(m.totalStaked.toString()).to.equal(STAKE.muln(2).toString());
  });

  // ----- resolve_match: real Txoracle CPI probe --------------------------

  it("probes the real resolve_match CPI (dispatches into validate_stat)", async function () {
    const daily = await findDailyScores(provider.connection);
    const oracle = await provider.connection.getAccountInfo(TXORACLE_PROGRAM_ID);
    if (!daily || !oracle) {
      console.log(
        "Txoracle program / daily_scores_roots not present on this cluster " +
          "(expected on localnet) — skipping real-CPI probe.",
      );
      this.skip();
      return;
    }

    // A throwaway market for the probe (resolve_match consumes an unresolved
    // market, and with dummy proof data it must fail — don't touch the real one).
    const probeFixture = new anchor.BN(Date.now() + 1);
    const probeMarket = marketPda(owner.publicKey, probeFixture);
    await program.methods
      .initMarket(probeFixture, STAKE)
      .accountsPartial({
        authority: owner.publicKey,
        market: probeMarket,
        vault: vaultPda(probeMarket),
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    // Structurally-valid but fabricated proof: ts pinned to the daily account's
    // epoch day (so the seeds constraint passes), everything else zeroed.
    const zero32 = Array.from(Buffer.alloc(32));
    const ts = new anchor.BN(daily.epochDay).mul(new anchor.BN(86_400_000)); // ms
    const fixtureSummary = {
      fixtureId: probeFixture,
      updateStats: {
        updateCount: 1,
        minTimestamp: new anchor.BN(0),
        maxTimestamp: new anchor.BN(0),
      },
      eventsSubTreeRoot: zero32,
    };
    const predicate = { threshold: 0, comparison: { greaterThan: {} } };
    const statA = {
      statToProve: { key: 1, value: 1, period: 0 },
      eventStatRoot: zero32,
      statProof: [],
    };

    let threw = false;
    try {
      await program.methods
        .resolveMatch(
          OUTCOME_HOME_WIN,
          ts,
          fixtureSummary,
          [],
          [],
          predicate,
          statA,
          null,
          null,
        )
        .accountsPartial({
          authority: owner.publicKey,
          market: probeMarket,
          dailyScoresRoots: daily.pda,
          txoracleProgram: TXORACLE_PROGRAM_ID,
        })
        .signers([owner])
        // Keep preflight ON for this negative test so the ValidateStat rejection
        // logs are captured (anchor drops logs on the skipPreflight failure path).
        .rpc({ commitment: "confirmed", skipPreflight: false });
    } catch (e: any) {
      threw = true;
      const logs = (e.logs || []).join("\n");
      // Proof of dispatch: the CPI entered validate_stat's own logic before the
      // data-consistency rejection (see cpi-verified findings).
      console.log(
        "resolve_match rejected as expected. First line:",
        (e.message || "").split("\n")[0],
      );
      expect(logs).to.match(/ValidateStat|validate_stat|6pW64g/);
    }
    expect(threw, "resolve_match must reject fabricated proof data").to.equal(
      true,
    );

    const pm = await program.account.market.fetch(probeMarket);
    expect(pm.resolved).to.equal(false); // never resolved from fake data
  });

  // ----- resolve_match_test: bypass to unblock settlement ----------------

  it("resolves the real market via the test bypass", async () => {
    await program.methods
      .resolveMatchTest(OUTCOME_HOME_WIN)
      .accountsPartial({ authority: owner.publicKey, market })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    const m = await program.account.market.fetch(market);
    expect(m.resolved).to.equal(true);
    expect(m.outcome).to.equal(OUTCOME_HOME_WIN);
  });

  // ----- settle_prediction: payout on correct, none on incorrect ---------

  it("settles the correct prediction and pays out 2x stake", async () => {
    const before = await provider.connection.getBalance(userCorrect.publicKey);

    await settlePrediction(userCorrect);

    const p = await program.account.prediction.fetch(
      predictionPda(market, userCorrect.publicKey),
    );
    expect(p.settled).to.equal(true);
    expect(p.correct).to.equal(true);

    const after = await provider.connection.getBalance(userCorrect.publicKey);
    // userCorrect is not the settle fee-payer (owner is), so the delta is the
    // clean payout.
    expect(after - before).to.equal(STAKE.muln(2).toNumber());
  });

  it("settles the incorrect prediction with no payout", async () => {
    const before = await provider.connection.getBalance(userIncorrect.publicKey);

    await settlePrediction(userIncorrect);

    const p = await program.account.prediction.fetch(
      predictionPda(market, userIncorrect.publicKey),
    );
    expect(p.settled).to.equal(true);
    expect(p.correct).to.equal(false);

    const after = await provider.connection.getBalance(userIncorrect.publicKey);
    expect(after - before).to.equal(0);
  });

  // ======================================================================
  // Helpers
  // ======================================================================

  function marketPda(authority: PublicKey, fid: anchor.BN): PublicKey {
    const fidLe = Buffer.alloc(8);
    fidLe.writeBigInt64LE(BigInt(fid.toString()));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("market"), authority.toBuffer(), fidLe],
      program.programId,
    )[0];
  }

  function vaultPda(mkt: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mkt.toBuffer()],
      program.programId,
    )[0];
  }

  function predictionPda(mkt: PublicKey, user: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("prediction"), mkt.toBuffer(), user.toBuffer()],
      program.programId,
    )[0];
  }

  // Common Arcium account bag for queue_computation instructions.
  function arciumAccounts(computationOffset: anchor.BN, compDefName: string) {
    return {
      computationAccount: getComputationAccAddress(
        clusterOffset,
        computationOffset,
      ),
      clusterAccount,
      mxeAccount: getMXEAccAddress(program.programId),
      mempoolAccount: getMempoolAccAddress(clusterOffset),
      executingPool: getExecutingPoolAccAddress(clusterOffset),
      compDefAccount: getCompDefAccAddress(
        program.programId,
        Buffer.from(getCompDefAccOffset(compDefName)).readUInt32LE(),
      ),
    };
  }

  async function submitPrediction(user: Keypair, value: number): Promise<void> {
    // Encrypt the prediction under a fresh shared key with the MXE.
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

    const nonce = randomBytes(16);
    const ciphertext = cipher.encrypt([BigInt(value)], nonce);

    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    const sig = await program.methods
      .submitPrediction(
        computationOffset,
        Array.from(ciphertext[0]),
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString()),
      )
      .accountsPartial({
        payer: user.publicKey,
        market,
        prediction: predictionPda(market, user.publicKey),
        vault,
        ...arciumAccounts(computationOffset, "store_prediction"),
      })
      .signers([user])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log(`submit_prediction (value=${value}) queue sig:`, sig);

    await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed",
    );
  }

  async function settlePrediction(user: Keypair): Promise<void> {
    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    const sig = await program.methods
      .settlePrediction(computationOffset)
      .accountsPartial({
        payer: owner.publicKey, // owner settles; keeps the user's balance delta clean
        market,
        prediction: predictionPda(market, user.publicKey),
        vault,
        user: user.publicKey,
        ...arciumAccounts(computationOffset, "check_prediction"),
      })
      .signers([owner])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("settle_prediction queue sig:", sig);

    await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed",
    );
  }

  async function fundFromOwner(to: PublicKey, lamports: number): Promise<void> {
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: to,
        lamports,
      }),
    );
    await provider.sendAndConfirm(tx, [owner]);
  }

  // Init a computation definition + upload its circuit, idempotently (the
  // accounts persist across runs on devnet).
  async function ensureCompDef(name: string): Promise<void> {
    const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
    const offset = getCompDefAccOffset(name);
    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeed, program.programId.toBuffer(), offset],
      getArciumProgramId(),
    )[0];

    if (await provider.connection.getAccountInfo(compDefPDA)) {
      console.log(`comp def "${name}" already initialized — skipping.`);
      return;
    }

    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(
      program.programId,
      mxeAcc.lutOffsetSlot,
    );

    const method =
      name === "store_prediction"
        ? program.methods.initStorePredictionCompDef()
        : program.methods.initCheckPredictionCompDef();

    const sig = await method
      .accountsPartial({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount,
        addressLookupTable: lutAddress,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    console.log(`init comp def "${name}" sig:`, sig);

    const rawCircuit = fs.readFileSync(`build/${name}.arcis`);
    await uploadCircuit(
      provider,
      name,
      program.programId,
      rawCircuit,
      true,
      500,
      { skipPreflight: true, preflightCommitment: "confirmed", commitment: "confirmed" },
    );
  }

  // Scan a window of epoch days for an existing Txoracle-owned
  // daily_scores_roots account (mirrors scripts/find_daily.mjs).
  async function findDailyScores(
    connection: anchor.web3.Connection,
  ): Promise<{ pda: PublicKey; epochDay: number } | null> {
    const nowDay = Math.floor(Date.now() / 86_400_000);
    for (let d = nowDay + 1; d >= nowDay - 7; d--) {
      const buf = Buffer.alloc(2);
      buf.writeUInt16LE(d);
      const pda = PublicKey.findProgramAddressSync(
        [Buffer.from("daily_scores_roots"), buf],
        TXORACLE_PROGRAM_ID,
      )[0];
      const info = await connection.getAccountInfo(pda);
      if (info && info.owner.equals(TXORACLE_PROGRAM_ID)) {
        return { pda, epochDay: d };
      }
    }
    return null;
  }
});

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries: number = 20,
  retryDelayMs: number = 500,
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) {
        return mxePublicKey;
      }
    } catch (error) {
      console.log(`Attempt ${attempt} failed to fetch MXE public key:`, error);
    }
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(file.toString())),
  );
}
