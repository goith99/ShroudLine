"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  displayStatus,
  fetchAllMarkets,
  formatKickoff,
  formatSol,
  MarketAccount,
  MarketEntry,
  marketStatus,
  MarketStatus,
  marketTitle,
  OUTCOME_AWAY,
  OUTCOME_DRAW,
  OUTCOME_HOME,
  STATUS_LABEL,
} from "@/lib/shroudline";
import { fixtureMeta } from "@/lib/fixtures";

const STATUS_ORDER: Record<MarketStatus, number> = {
  open: 0,
  review: 1,
  resolved: 2,
};

function Scoreboard({ account }: { account: MarketAccount }) {
  const meta = fixtureMeta(account.fixtureId.toString());
  if (!meta) {
    return <div className="sb-single">{marketTitle(account)}</div>;
  }
  const winner = account.resolved ? account.outcome : null;
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
          <span className="sb-name">{meta.home}</span>
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
          {winner === OUTCOME_AWAY && <span className="sb-tag">Win</span>}
        </div>
      </div>
      {winner === OUTCOME_DRAW && <div className="sb-draw">Draw</div>}
    </>
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
      all.sort((a, b) => {
        const byStatus =
          STATUS_ORDER[marketStatus(a.account)] -
          STATUS_ORDER[marketStatus(b.account)];
        if (byStatus !== 0) return byStatus;
        // known fixtures (real team names) above unnamed demo markets
        const byKnown =
          (fixtureMeta(a.account.fixtureId.toString()) ? 0 : 1) -
          (fixtureMeta(b.account.fixtureId.toString()) ? 0 : 1);
        if (byKnown !== 0) return byKnown;
        return b.account.totalStaked.cmp(a.account.totalStaked);
      });
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

      {markets?.map(({ publicKey, account }) => {
        const status = displayStatus(account);
        const meta = fixtureMeta(account.fixtureId.toString());
        return (
          <Link
            key={publicKey.toBase58()}
            href={`/market/${publicKey.toBase58()}`}
            className="card"
          >
            <div className="sb-top">
              <span className="sb-stage">
                {meta ? meta.stage : "Exhibition"}
              </span>
              <span className={`pill pill-${status}`}>
                {STATUS_LABEL[status]}
              </span>
            </div>
            <Scoreboard account={account} />
            <div className="sb-meta">
              <span>
                Pool <strong>{formatSol(account.totalStaked)}</strong>
              </span>
              <span>
                Picks <strong>{account.predictionCount.toString()}</strong>
              </span>
              <span>
                Closes{" "}
                <strong>
                  {meta ? formatKickoff(meta.kickoffUtc) : "at kickoff"}
                </strong>
              </span>
              {status === "settled" && (
                <span className="verify-tag" title="Outcome proven on-chain by Txoracle::validate_stat">
                  ⛓ TxLINE verified
                </span>
              )}
            </div>
          </Link>
        );
      })}
    </>
  );
}
