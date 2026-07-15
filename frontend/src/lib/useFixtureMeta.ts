"use client";

// Resolve fixture metadata for a market card, in priority order:
//   1. the curated static FIXTURES dictionary (zero latency, zero API calls) —
//      our verified source of truth for fixtures we've already filled in;
//   2. our own /api/fixture-meta/<id> route (server-side, holds the TxLINE token)
//      for fixtures the worker created that aren't in the static dict yet;
//   3. null -> the caller shows the generic "Demo Market <id>" fallback.
//
// The API result is merged into the same FixtureMeta shape the static dict uses,
// so consumers render identically regardless of source. A module-level cache +
// in-flight dedupe means many cards for the same fixture (and re-renders) trigger
// at most one network request per fixture id per page session.

import { useEffect, useState } from "react";
import { FIXTURES, FixtureMeta, FixtureResult, ResultKind } from "./fixtures";

const clientCache = new Map<string, FixtureMeta | null>();
const inFlight = new Map<string, Promise<FixtureMeta | null>>();

function isValidFixtureId(id: string): boolean {
  return /^\d{1,20}$/.test(id);
}

function parseResult(raw: unknown): FixtureResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.homeScore !== "number" || typeof r.awayScore !== "number") {
    return undefined;
  }
  const decidedBy =
    r.decidedBy === "AET" || r.decidedBy === "PEN"
      ? (r.decidedBy as ResultKind)
      : undefined;
  return {
    homeScore: r.homeScore,
    awayScore: r.awayScore,
    ...(decidedBy ? { decidedBy } : {}),
    ...(typeof r.penHome === "number" ? { penHome: r.penHome } : {}),
    ...(typeof r.penAway === "number" ? { penAway: r.penAway } : {}),
  };
}

async function fetchFixtureMeta(fixtureId: string): Promise<FixtureMeta | null> {
  try {
    const res = await fetch(`/api/fixture-meta/${fixtureId}`);
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, unknown>;
    // Only usable as a rendered fixture if we actually have both team names.
    if (typeof d.home !== "string" || typeof d.away !== "string") return null;
    return {
      home: d.home,
      away: d.away,
      kickoffUtc: typeof d.kickoffUtc === "string" ? d.kickoffUtc : "",
      stage: typeof d.stage === "string" ? d.stage : "World Cup",
      result: parseResult(d.result),
    };
  } catch {
    // Network error etc. — treat as "unknown", the caller falls back gracefully.
    return null;
  }
}

export interface UseFixtureMeta {
  meta: FixtureMeta | null;
  /**
   * True while the API lookup is in flight. A static entry that already has a
   * `result` is never loading; a static entry *without* a result still shows a
   * brief loading window while we check the API for a score to fill in, but the
   * static `meta` is rendered the whole time (consumers gate spinners on
   * `loading && !meta`), so there is no visible flash.
   */
  loading: boolean;
}

// Combine the static dict entry (source of truth for names/stage/kickoff) with
// whatever the API returned. The static entry always wins for every field
// except a *missing* result, which the API may fill in once the match resolves.
function resolveMeta(
  staticMeta: FixtureMeta | undefined,
  apiMeta: FixtureMeta | null,
): FixtureMeta | null {
  if (!staticMeta) return apiMeta;
  if (staticMeta.result) return staticMeta;
  return apiMeta?.result ? { ...staticMeta, result: apiMeta.result } : staticMeta;
}

export function useFixtureMeta(fixtureId: string): UseFixtureMeta {
  const staticMeta: FixtureMeta | undefined = FIXTURES[fixtureId];
  // A static entry with a result is complete. Anything else — no static entry,
  // or a static entry still missing its result — warrants an API lookup (for
  // the score, or for the whole fixture) as long as the id is well-formed.
  const staticComplete = !!staticMeta && !!staticMeta.result;
  const needsLookup =
    !staticComplete && !!fixtureId && isValidFixtureId(fixtureId);

  const initial = (): UseFixtureMeta => {
    if (staticComplete) return { meta: staticMeta as FixtureMeta, loading: false };
    // No lookup possible (invalid/empty id) — fall back to the static entry as-is.
    if (!needsLookup) return { meta: staticMeta ?? null, loading: false };
    if (clientCache.has(fixtureId)) {
      const api = clientCache.get(fixtureId) ?? null;
      return { meta: resolveMeta(staticMeta, api), loading: false };
    }
    // Lookup pending: show the static entry (if any) immediately.
    return { meta: staticMeta ?? null, loading: true };
  };

  const [state, setState] = useState<UseFixtureMeta>(initial);

  useEffect(() => {
    // 1. Static entry already has a result — nothing to fetch.
    if (staticComplete) {
      setState({ meta: staticMeta as FixtureMeta, loading: false });
      return;
    }
    // 2. Nothing to look up (empty / non-numeric id) — static entry as-is.
    if (!needsLookup) {
      setState({ meta: staticMeta ?? null, loading: false });
      return;
    }
    // 3. Already resolved once this session.
    if (clientCache.has(fixtureId)) {
      const api = clientCache.get(fixtureId) ?? null;
      setState({ meta: resolveMeta(staticMeta, api), loading: false });
      return;
    }

    let alive = true;
    // Keep the static entry visible while we look up the score.
    setState({ meta: staticMeta ?? null, loading: true });

    let p = inFlight.get(fixtureId);
    if (!p) {
      p = fetchFixtureMeta(fixtureId);
      inFlight.set(fixtureId, p);
    }
    void p.then((api) => {
      clientCache.set(fixtureId, api);
      inFlight.delete(fixtureId);
      if (alive) setState({ meta: resolveMeta(staticMeta, api), loading: false });
    });

    return () => {
      alive = false;
    };
  }, [fixtureId, staticMeta, staticComplete, needsLookup]);

  return state;
}
