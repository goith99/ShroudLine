"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  displayStatus,
  fetchAllMarkets,
  formatKickoffUtc,
  formatSol,
  MarketAccount,
  MarketEntry,
  marketTitle,
  OUTCOME_AWAY,
  OUTCOME_DRAW,
  OUTCOME_HOME,
  STATUS_LABEL,
} from "@/lib/shroudline";
import { fixtureMeta, FixtureMeta, resultDecidedLabel } from "@/lib/fixtures";
import { useFixtureMeta } from "@/lib/useFixtureMeta";
import WhyShroudLine from "@/components/WhyShroudLine";

function Scoreboard({
  account,
  meta,
  loading,
}: {
  account: MarketAccount;
  meta: FixtureMeta | null;
  loading: boolean;
}) {
  // Metadata is still being fetched from /api/fixture-meta — keep the card's
  // shape (two rows) so there's no layout shift when the names arrive.
  if (loading && !meta) {
    return (
      <div className="sb-teams" aria-busy="true">
        <div className="sb-row">
          <span className="sb-name sb-skeleton">Loading match…</span>
        </div>
        <div className="sb-row">
          <span className="sb-name sb-skeleton" aria-hidden>
            &nbsp;
          </span>
        </div>
      </div>
    );
  }
  if (!meta) {
    return <div className="sb-single">{marketTitle(account)}</div>;
  }
  const winner = account.resolved ? account.outcome : null;
  const result = account.resolved ? meta.result : undefined;
  const decided = result ? resultDecidedLabel(result) : undefined;
  return (
    <>
      <div className="sb-teams">
        <div
          className={`sb-row ${
            winner === OUTCOME_HOME
              ? "sb-win"
              : winner !== null && winner !== OUTCOME_DRAW
                ? "sb-dim"
                : ""
          }`}
        >
          <span className="sb-name">
            {meta.home}
            {winner === OUTCOME_HOME && <span className="sb-winmark"> (WIN)</span>}
          </span>
          {result && <span className="sb-score">{result.homeScore}</span>}
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
          <span className="sb-name">
            {meta.away}
            {winner === OUTCOME_AWAY && <span className="sb-winmark"> (WIN)</span>}
          </span>
          {result && <span className="sb-score">{result.awayScore}</span>}
        </div>
      </div>
      {decided && <div className="sb-decided">{decided}</div>}
      {winner === OUTCOME_DRAW && <div className="sb-draw">Draw</div>}
    </>
  );
}

function MarketCard({ publicKey, account }: MarketEntry) {
  // Static dict first, then /api/fixture-meta, then the generic fallback.
  const { meta, loading } = useFixtureMeta(account.fixtureId.toString());
  const status = displayStatus(account);
  return (
    <Link href={`/market/${publicKey.toBase58()}`} className="card">
      <div className="sb-top">
        <span className="sb-stage">{meta ? meta.stage : "Exhibition"}</span>
        <span className={`pill pill-${status}`}>{STATUS_LABEL[status]}</span>
      </div>
      <Scoreboard account={account} meta={meta} loading={loading} />
      <div className="sb-meta">
        <span>
          Pool <strong>{formatSol(account.totalStaked)}</strong>
        </span>
        <span>
          Picks <strong>{account.predictionCount.toString()}</strong>
        </span>
        {meta && (
          <span className="sb-meta-full">
            Kickoff <strong>{formatKickoffUtc(meta.kickoffUtc)}</strong>
          </span>
        )}
        {status === "settled" && (
          <span
            className="verify-tag"
            title="Outcome proven on-chain by Txoracle::validate_stat_v2"
          >
            ⛓ TxLINE verified
          </span>
        )}
      </div>
    </Link>
  );
}

export default function MarketsPage() {
  const { connection } = useConnection();
  const [markets, setMarkets] = useState<MarketEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const all = await fetchAllMarkets(connection);
      // Newest-match-first: sort by kickoff time descending, so the soonest
      // upcoming (or most recently played) match is at the top and the oldest is
      // at the bottom. Kickoff is only known synchronously here from the static
      // FIXTURES dict; unknown-fixture markets (kickoff comes from the async API
      // fallback, not resolved at sort time) get a sentinel of 0 so they sort to
      // the bottom as "oldest". The sort runs once at load and isn't re-run when
      // per-card hooks resolve, so no card reorders after mount.
      const kickoffMs = (e: MarketEntry): number => {
        const m = fixtureMeta(e.account.fixtureId.toString());
        const t = m ? Date.parse(m.kickoffUtc) : NaN;
        return Number.isNaN(t) ? 0 : t;
      };
      all.sort((a, b) => kickoffMs(b) - kickoffMs(a));
      setMarkets(all);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [connection]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h1>Prediction Markets</h1>
      <p className="page-sub">
        Pick a match outcome — your prediction is encrypted before it leaves
        your browser, and stays veiled until settlement.
      </p>

      <section className="how-it-works">
        <h2>How a prediction works</h2>
        <ol className="flow-steps">
          <li className="flow-step">
            <span className="flow-num">1</span>
            <span className="flow-text">
              <b>Pick a team &amp; stake</b> — your pick is encrypted before it
              leaves your browser.
            </span>
          </li>
          <li className="flow-step">
            <span className="flow-num">2</span>
            <span className="flow-text">
              <b>Match plays out</b> — nobody can see what you picked, not even
              the program.
            </span>
          </li>
          <li className="flow-step">
            <span className="flow-num">3</span>
            <span className="flow-text">
              <b>Result is verified</b> — checked on-chain against TxLINE&apos;s
              oracle, not self-reported.
            </span>
          </li>
          <li className="flow-step">
            <span className="flow-num">4</span>
            <span className="flow-text">
              <b>Reveal &amp; claim</b> — if you&apos;re right, claim your payout
              directly from the vault.
            </span>
          </li>
        </ol>
      </section>

      <WhyShroudLine />

      {error && (
        <div className="notice notice-error">
          Couldn&apos;t load markets: {error}{" "}
          <button className="primary-btn" style={{ marginTop: "0.5rem" }} onClick={load}>
            Retry
          </button>
        </div>
      )}

      {!markets && !error && (
        <p className="center">
          <span className="spinner" /> Loading markets…
        </p>
      )}

      {markets && markets.length === 0 && (
        <p className="center">No markets yet.</p>
      )}

      {markets && markets.length > 0 && (
        <section className="markets-section" aria-label="Prediction markets">
          <div className="markets-grid">
            {markets.map((entry) => (
              <MarketCard key={entry.publicKey.toBase58()} {...entry} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
