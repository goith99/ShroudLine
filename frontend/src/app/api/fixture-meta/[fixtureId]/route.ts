// Server-side Route Handler: resolve fixture metadata (team names, kickoff,
// stage) and, if the match has finished, its final score — from TxLINE, so the
// frontend shows real names/scores for markets the worker creates that aren't in
// the curated static dictionary (src/lib/fixtures.ts), instead of a generic
// "Demo Market" placeholder. No manual file edit + redeploy needed going forward.
//
// SECURITY: this file is the ONLY place TXLINE_API_TOKEN is read. It is a
// server-side env var (set in Vercel's dashboard / frontend/.env.local), NOT a
// NEXT_PUBLIC_ variable, so it is never bundled into client JS and never sent to
// the browser. The token value is never logged (only presence/absence) and never
// included in a response body.
//
// Auth flow / endpoints are the exact same ones scripts/fetch-proof.ts and
// worker/index.mjs use: guest JWT from /auth/guest/start + X-Api-Token header,
// /api/fixtures/snapshot?competitionId=72 for names, /api/scores/historical/<id>
// (SSE) for the game_finalised score.

import { NextResponse } from "next/server";

// This route depends on runtime env + live fetches; never statically optimize it.
// nodejs runtime keeps the module-level cache warm across requests on a given
// (warm) server instance — best-effort, per-instance, which is all we need.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_ORIGIN = "https://txline-dev.txodds.com";
const COMPETITION_ID = 72; // World Cup — same as worker Loop A / sync-schedule
// Penalty-shootout goal keys (+6000 offset). Inferred, same default as
// scripts/fetch-proof.ts (not yet verified against a real FPE fixture).
const PE_HOME_KEY = 6001;
const PE_AWAY_KEY = 6002;

// A final score never changes, so cache it forever; unresolved/unknown fixtures
// get a short TTL so we re-check without hammering TxLINE across many visitors.
const UNRESOLVED_TTL_MS = 5 * 60 * 1000;

type ResultKind = "AET" | "PEN";

interface FixtureResultPayload {
  homeScore: number;
  awayScore: number;
  decidedBy?: ResultKind;
  penHome?: number;
  penAway?: number;
}

interface MetaResponse {
  fixtureId: string;
  home: string | null;
  away: string | null;
  stage: string | null;
  kickoffUtc: string | null;
  result: FixtureResultPayload | null;
}

// Module-level in-memory cache (per warm server instance). Required: this route
// can be hit by many concurrent visitors, and TxLINE (like the devnet RPC the
// worker saw 429s from) rate-limits — so we must not fetch on every page load.
const cache = new Map<string, { data: MetaResponse; expires: number }>();

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Guest JWT + X-Api-Token headers, exactly as fetch-proof.ts / worker do. Fetched
// fresh per cache-miss (bounded by the data cache); the token value is never logged.
async function guestHeaders(apiToken: string): Promise<Record<string, string>> {
  const res = await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" });
  if (!res.ok) throw new Error(`guest/start ${res.status}`);
  const jwt = (await res.json())?.token;
  if (!jwt || typeof jwt !== "string") throw new Error("guest/start returned no token");
  return { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };
}

// Team names + kickoff from the fixtures snapshot. Returns null if the fixture
// isn't in the snapshot — an EXPECTED case for older fixtures whose kickoff has
// passed by more than a couple days (the snapshot is upcoming/near-term only),
// so callers must treat this as "unknown", not an error.
async function fetchSnapshotMeta(
  headers: Record<string, string>,
  fixtureId: string,
): Promise<{ home: string; away: string; kickoffUtc: string; stage: string | null } | null> {
  const res = await fetch(
    `${API_ORIGIN}/api/fixtures/snapshot?competitionId=${COMPETITION_ID}`,
    { headers, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const fixtures = JSON.parse(await res.text());
  if (!Array.isArray(fixtures)) return null;
  const f = fixtures.find((x) => String(x?.FixtureId) === fixtureId);
  if (!f || !f.Participant1 || !f.Participant2) return null;
  // Respect Participant1IsHome for home/away order (same as sync-schedule.mjs).
  const home = f.Participant1IsHome ? f.Participant1 : f.Participant2;
  const away = f.Participant1IsHome ? f.Participant2 : f.Participant1;
  return {
    home: String(home),
    away: String(away),
    kickoffUtc: new Date(Number(f.StartTime)).toISOString(),
    // The snapshot has no granular round; use the competition name (e.g. "World
    // Cup") as a best-effort stage. Curated static entries have finer stages.
    stage: typeof f.Competition === "string" ? f.Competition : null,
  };
}

// Final score from the historical SSE stream — same game_finalised detection as
// scripts/fetch-proof.ts. Returns null if the match hasn't finalised yet / no data.
async function fetchResult(
  headers: Record<string, string>,
  fixtureId: string,
): Promise<FixtureResultPayload | null> {
  const res = await fetch(`${API_ORIGIN}/api/scores/historical/${fixtureId}`, {
    headers,
    cache: "no-store",
  });
  if (!res.ok) return null; // no feed data yet
  const text = await res.text();
  const events = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(5).trim());
      } catch {
        return null;
      }
    })
    .filter((x) => x !== null);
  const fin = [...events].reverse().find((e) => /final/i.test(e?.Action || ""));
  if (!fin) return null; // not finalised yet

  // Full-game goals (keys 1/2) INCLUDE extra time but EXCLUDE the shootout.
  const homeScore = Number(fin.Stats?.["1"] ?? 0);
  const awayScore = Number(fin.Stats?.["2"] ?? 0);
  const result: FixtureResultPayload = { homeScore, awayScore };

  // PEN detection mirrors fetch-proof.ts: level after full-game (incl. ET) means
  // it went to penalties. Only mark PEN if the shootout keys are actually present
  // on the finalised event. (AET vs regulation isn't distinguishable from this
  // stream alone — same limitation fetch-proof.ts has for display — so decidedBy
  // is left off for non-shootout wins; the score still shows correctly.)
  const penHome = fin.Stats?.[String(PE_HOME_KEY)];
  const penAway = fin.Stats?.[String(PE_AWAY_KEY)];
  if (homeScore === awayScore && penHome != null && penAway != null) {
    result.decidedBy = "PEN";
    result.penHome = Number(penHome);
    result.penAway = Number(penAway);
  }
  return result;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ fixtureId: string }> },
): Promise<Response> {
  const { fixtureId: rawId } = await ctx.params;
  const fixtureId = String(rawId ?? "").trim();

  const nullResponse = (): MetaResponse => ({
    fixtureId,
    home: null,
    away: null,
    stage: null,
    kickoffUtc: null,
    result: null,
  });

  // Validate: TxODDS fixture ids are integers. Reject anything else outright so
  // nothing unsanitized is ever interpolated into an outbound URL/query.
  if (!/^\d{1,20}$/.test(fixtureId)) {
    return NextResponse.json(nullResponse());
  }

  const now = Date.now();
  const cached = cache.get(fixtureId);
  if (cached && cached.expires > now) {
    return NextResponse.json(cached.data);
  }

  const apiToken = process.env.TXLINE_API_TOKEN;
  if (!apiToken) {
    // Log presence only — never the value.
    console.error(
      "[fixture-meta] TXLINE_API_TOKEN not set (present=false) — returning null metadata",
    );
    return NextResponse.json(nullResponse());
  }

  let data = nullResponse();
  try {
    const headers = await guestHeaders(apiToken);
    // Names and result are independent lookups — one failing must not sink the
    // other, so each is guarded separately.
    let snap: Awaited<ReturnType<typeof fetchSnapshotMeta>> = null;
    try {
      snap = await fetchSnapshotMeta(headers, fixtureId);
    } catch (e) {
      console.error(`[fixture-meta] snapshot lookup failed for ${fixtureId}:`, errMsg(e));
    }
    let result: FixtureResultPayload | null = null;
    try {
      result = await fetchResult(headers, fixtureId);
    } catch (e) {
      console.error(`[fixture-meta] result lookup failed for ${fixtureId}:`, errMsg(e));
    }
    data = {
      fixtureId,
      home: snap?.home ?? null,
      away: snap?.away ?? null,
      stage: snap?.stage ?? null,
      kickoffUtc: snap?.kickoffUtc ?? null,
      result: result ?? null,
    };
  } catch (e) {
    // TxLINE down / token invalid / auth failed — degrade gracefully to nulls so
    // the client shows the "Demo Market" fallback rather than a broken page.
    console.error(`[fixture-meta] lookup failed for ${fixtureId}:`, errMsg(e));
    data = nullResponse();
  }

  // A finalised result is immutable → cache forever; otherwise short TTL.
  const expires = data.result ? Number.POSITIVE_INFINITY : now + UNRESOLVED_TTL_MS;
  cache.set(fixtureId, { data, expires });

  return NextResponse.json(data);
}
