"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import type { Wallet } from "@anchor-lang/core";
import BN from "bn.js";
import {
  awaitComputationFinalization,
  deserializeLE,
  RescueCipher,
  x25519,
} from "@arcium-hq/client";
import {
  arciumAccounts,
  displayStatus,
  fetchMxePublicKey,
  formatKickoff,
  formatSol,
  getProgram,
  getReadonlyProgram,
  MarketAccount,
  marketStatus,
  marketTitle,
  outcomeLabel,
  OUTCOME_AWAY,
  OUTCOME_DRAW,
  OUTCOME_HOME,
  PredictionAccount,
  predictionPda,
  PROGRAM_ID,
  STATUS_LABEL,
  vaultPda,
} from "@/lib/shroudline";
import { fixtureMeta, fixtureResult, resultDecidedLabel } from "@/lib/fixtures";

type Busy =
  | null
  | "encrypting"
  | "sending"
  | "confirming"
  | "settling"
  | "settling-confirm";

const BUSY_TEXT: Record<Exclude<Busy, null>, string> = {
  encrypting: "Encrypting your pick in the browser…",
  sending: "Waiting for your wallet to approve…",
  confirming: "Storing your encrypted pick (this takes ~30s)…",
  settling: "Waiting for your wallet to approve…",
  "settling-confirm": "Lifting the veil on your pick (~30s)…",
};

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/user rejected/i.test(msg)) return "You declined the transaction in your wallet.";
  if (/insufficient/i.test(msg)) return "Your wallet doesn't have enough devnet SOL.";
  return msg.length > 300 ? msg.slice(0, 300) + "…" : msg;
}

function MatchBoard({ market }: { market: MarketAccount }) {
  const meta = fixtureMeta(market.fixtureId.toString());
  if (!meta) {
    return (
      <div className="match-board">
        <div className="sb-single" style={{ padding: 0 }}>
          {marketTitle(market)}
        </div>
      </div>
    );
  }
  const winner = market.resolved ? market.outcome : null;
  const result = market.resolved
    ? fixtureResult(market.fixtureId.toString())
    : undefined;
  const decided = result ? resultDecidedLabel(result) : undefined;
  return (
    <>
      <div className="match-board">
        <div
          className={`sb-row ${
            winner === OUTCOME_HOME
              ? "sb-win"
              : winner !== null && winner !== OUTCOME_DRAW
                ? "sb-dim"
                : ""
          }`}
        >
          <span className="sb-name">{meta.home}</span>
          {result && <span className="sb-score">{result.homeScore}</span>}
          {winner === OUTCOME_HOME && <span className="sb-tag">Win</span>}
        </div>
        <div
          className={`sb-row ${
            winner === OUTCOME_AWAY
              ? "sb-win"
              : winner !== null && winner !== OUTCOME_DRAW
                ? "sb-dim"
                : ""
          }`}
        >
          <span className="sb-name">{meta.away}</span>
          {result && <span className="sb-score">{result.awayScore}</span>}
          {winner === OUTCOME_AWAY && <span className="sb-tag">Win</span>}
        </div>
        {decided && (
          <div className="sb-decided" style={{ margin: "0.4rem 0 0" }}>
            {decided}
          </div>
        )}
        {winner === OUTCOME_DRAW && (
          <div className="sb-draw" style={{ margin: "0.4rem 0 0" }}>
            Draw
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The two trustless mechanisms, shown side by side so a viewer sees they are
 * separate systems: Arcium MPC keeps the pick secret, TxLINE's oracle proves
 * the result. Always visible on the detail page.
 */
function TrustRail() {
  return (
    <div className="trust-rail">
      <div className="trust-chip trust-chip-encrypt">
        <span className="trust-chip-icon" aria-hidden>
          🔒
        </span>
        <span className="trust-chip-body">
          <span className="trust-chip-title">Picks encrypted · Arcium</span>
          <span className="trust-chip-sub">
            Your prediction is sealed by Arcium MPC — nobody sees it until
            settlement.
          </span>
        </span>
      </div>
      <div className="trust-chip trust-chip-verify">
        <span className="trust-chip-icon" aria-hidden>
          ⛓
        </span>
        <span className="trust-chip-body">
          <span className="trust-chip-title">Result verified · TxLINE</span>
          <span className="trust-chip-sub">
            The final score is proven on-chain by TxLINE&apos;s oracle before
            any market resolves.
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * Prominent verification badge shown once a market is settled — makes clear the
 * outcome came from TxLINE's oracle, not from us asserting it.
 */
function OracleBadge() {
  return (
    <div className="oracle-badge">
      <span className="oracle-badge-icon" aria-hidden>
        ⛓
      </span>
      <span className="oracle-badge-body">
        <span className="oracle-badge-title">
          Result verified via TxLINE on-chain oracle
        </span>
        <span className="oracle-badge-sub">
          A Merkle proof of the final score was checked on-chain by{" "}
          <code>Txoracle::validate_stat_v2</code> — the program records the outcome
          only if the oracle agrees, never on our word.
        </span>
      </span>
    </div>
  );
}

function VeiledPick({
  stake,
  decrypting,
  note,
}: {
  stake: BN;
  decrypting?: boolean;
  note: string;
}) {
  return (
    <div className={`veil-card ${decrypting ? "decrypting" : ""}`}>
      <span className="veil-label">Your pick · {formatSol(stake)} staked</span>
      <span className="veil-glyphs" aria-hidden>
        ▮▮▮▮▮▮▮
      </span>
      <span className="veil-note">{note}</span>
    </div>
  );
}

export default function MarketDetailPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = use(params);
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const marketKey = useMemo(() => {
    try {
      return new PublicKey(address);
    } catch {
      return null;
    }
  }, [address]);

  const [market, setMarket] = useState<MarketAccount | null | undefined>();
  const [prediction, setPrediction] = useState<
    PredictionAccount | null | undefined
  >();
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [justSettled, setJustSettled] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(false);

  const load = useCallback(async () => {
    if (!marketKey) return;
    setError(null);
    try {
      const program = getReadonlyProgram(connection);
      const m = await program.account.market.fetchNullable(marketKey);
      setMarket(m);
      if (m && wallet) {
        const p = await program.account.prediction.fetchNullable(
          predictionPda(marketKey, wallet.publicKey),
        );
        setPrediction(p);
      } else {
        setPrediction(null);
      }
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [connection, marketKey, wallet]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (!marketKey || !market || !wallet || selected === null) return;
    setError(null);
    setBusy("encrypting");
    try {
      const { program, provider } = getProgram(
        connection,
        wallet as unknown as Wallet,
      );

      // Encrypt the pick client-side: x25519 ECDH with the MXE cluster key,
      // then Rescue cipher with a fresh nonce. Only MPC can read it.
      const mxePublicKey = await fetchMxePublicKey(provider);
      const privateKey = x25519.utils.randomSecretKey();
      const publicKey = x25519.getPublicKey(privateKey);
      const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
      const cipher = new RescueCipher(sharedSecret);
      const nonce = randomBytes(16);
      const ciphertext = cipher.encrypt([BigInt(selected)], nonce);
      const computationOffset = new BN(Array.from(randomBytes(8)));

      setBusy("sending");
      await program.methods
        .submitPrediction(
          computationOffset,
          Array.from(ciphertext[0]),
          Array.from(publicKey),
          new BN(deserializeLE(nonce).toString()),
        )
        .accountsPartial({
          payer: wallet.publicKey,
          market: marketKey,
          prediction: predictionPda(marketKey, wallet.publicKey),
          vault: vaultPda(marketKey),
          ...arciumAccounts(computationOffset, "store_prediction"),
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      setBusy("confirming");
      await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        "confirmed",
      );
      setJustSubmitted(true);
      await load();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const settle = async () => {
    if (!marketKey || !market || !wallet) return;
    setError(null);
    setBusy("settling");
    try {
      const { program, provider } = getProgram(
        connection,
        wallet as unknown as Wallet,
      );
      const computationOffset = new BN(Array.from(randomBytes(8)));
      await program.methods
        .settlePrediction(computationOffset)
        .accountsPartial({
          payer: wallet.publicKey,
          market: marketKey,
          prediction: predictionPda(marketKey, wallet.publicKey),
          vault: vaultPda(marketKey),
          user: wallet.publicKey,
          ...arciumAccounts(computationOffset, "check_prediction"),
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      setBusy("settling-confirm");
      await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        "confirmed",
      );
      setJustSettled(true);
      await load();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  if (!marketKey) {
    return <p className="center">That doesn&apos;t look like a valid market link.</p>;
  }
  if (market === undefined) {
    return (
      <p className="center">
        <span className="spinner" /> Loading market…
      </p>
    );
  }
  if (market === null) {
    return (
      <>
        <p className="center">Market not found.</p>
        <p style={{ textAlign: "center" }}>
          <Link className="back-link" href="/">
            ← All markets
          </Link>
        </p>
      </>
    );
  }

  const status = marketStatus(market); // drives available actions
  const shown = displayStatus(market); // what the user reads
  const meta = fixtureMeta(market.fixtureId.toString());
  const stake = market.stakeAmount;
  const payout = stake.muln(2);

  return (
    <>
      <Link className="back-link" href="/">
        ← All markets
      </Link>

      <div className="card" style={{ marginTop: "0.9rem" }}>
        <div className="sb-top">
          <span className="sb-stage">{meta ? meta.stage : "Exhibition"}</span>
          <span className={`pill pill-${shown}`}>{STATUS_LABEL[shown]}</span>
        </div>
        <MatchBoard market={market} />
        <div className="sb-meta">
          <span>
            Pool <strong>{formatSol(market.totalStaked)}</strong>
          </span>
          <span>
            Picks <strong>{market.predictionCount.toString()}</strong>
          </span>
          <span>
            Stake <strong>{formatSol(stake)}</strong>
          </span>
          <span>
            Wins pay <strong>{formatSol(payout)}</strong>
          </span>
          <span>
            Closes{" "}
            <strong>
              {meta ? formatKickoff(meta.kickoffUtc) : "at kickoff"}
            </strong>
          </span>
        </div>
      </div>

      <TrustRail />

      {error && <div className="notice notice-error">{error}</div>}

      {status === "open" && (
        <div className="panel">
          <h2>Your prediction</h2>
          {!wallet && (
            <p className="muted">
              Connect your wallet (top right) to make a prediction.
            </p>
          )}
          {wallet && prediction && (
            <>
              <VeiledPick
                stake={prediction.stake}
                note={
                  justSubmitted
                    ? "Encrypted and stored — nobody can see your pick, not even us."
                    : "Encrypted on-chain. It stays veiled until the match is settled."
                }
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 0 }}>
                Come back after the result is in to settle.
              </p>
            </>
          )}
          {wallet && prediction === null && (
            <>
              <div className="outcome-picker">
                <button
                  className={`outcome-btn ${selected === OUTCOME_HOME ? "selected" : ""}`}
                  onClick={() => setSelected(OUTCOME_HOME)}
                  disabled={busy !== null}
                >
                  {meta ? meta.home : "Home"} <small>to win</small>
                </button>
                <button
                  className={`outcome-btn ${selected === OUTCOME_DRAW ? "selected" : ""}`}
                  onClick={() => setSelected(OUTCOME_DRAW)}
                  disabled={busy !== null}
                >
                  Draw{" "}
                  <small>
                    {market.isKnockout ? "after extra time" : "full time"}
                  </small>
                </button>
                <button
                  className={`outcome-btn ${selected === OUTCOME_AWAY ? "selected" : ""}`}
                  onClick={() => setSelected(OUTCOME_AWAY)}
                  disabled={busy !== null}
                >
                  {meta ? meta.away : "Away"} <small>to win</small>
                </button>
              </div>
              <button
                className="primary-btn"
                onClick={submit}
                disabled={busy !== null || selected === null}
              >
                {busy ? (
                  <>
                    <span className="spinner" /> {BUSY_TEXT[busy]}
                  </>
                ) : (
                  `Submit encrypted pick — stake ${formatSol(stake)}`
                )}
              </button>
              <p className="muted" style={{ fontSize: "0.8rem", marginBottom: 0 }}>
                Your pick is encrypted on this device before it&apos;s
                submitted. It stays veiled until settlement.
              </p>
            </>
          )}
        </div>
      )}

      {status === "resolved" && (
        <div className="panel">
          <h2>Result · {outcomeLabel(market)}</h2>
          <OracleBadge />
          {!wallet && (
            <p className="muted">
              Connect your wallet to check whether you have a pick to settle.
            </p>
          )}
          {wallet && prediction === null && (
            <p className="muted">
              This wallet didn&apos;t make a prediction on this match.
            </p>
          )}
          {wallet && prediction && prediction.settled && (
            <div
              className={`result-card ${
                prediction.correct ? "result-win" : "result-miss"
              } ${justSettled ? "reveal-in" : ""}`}
            >
              <span className="result-label">Your pick — revealed</span>
              <strong className="result-text">
                {prediction.correct ? "Correct" : "Not this time"}
              </strong>
              <span className="result-sub">
                {prediction.correct
                  ? `${justSettled ? "You've been paid" : "You were paid"} ${formatSol(payout)}.`
                  : "Your pick didn't match the result — no payout."}
              </span>
            </div>
          )}
          {wallet && prediction && !prediction.settled && (
            <>
              <VeiledPick
                stake={prediction.stake}
                decrypting={busy !== null}
                note={
                  busy
                    ? "Decrypting inside secure computation — the result appears in a moment…"
                    : "Still veiled. Settle to check it against the result."
                }
              />
              <button
                className="primary-btn"
                onClick={settle}
                disabled={busy !== null}
              >
                {busy ? (
                  <>
                    <span className="spinner" /> {BUSY_TEXT[busy]}
                  </>
                ) : (
                  `Settle — reveal & pay ${formatSol(payout)} if correct`
                )}
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
