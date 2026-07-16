// Hardcoded fixture metadata for the demo. The on-chain program only stores a
// numeric TxODDS fixture id and the outcome *direction* (home/away/draw) — never
// the numeric score. Team names, kickoff times, stage, and the final score for
// settled matches all live here so we don't have to touch the program. Markets
// created with unknown fixture ids fall back to a generic label.
//
// The open-fixture list mirrors TxLINE's official remaining World Cup schedule
// (competition 72). Regenerate it with `node scripts/sync-schedule.mjs`, which
// prints ready-to-paste rows. Fill in `result` for a match once it is settled
// (the score isn't on-chain).

/** How a non-regulation result was decided; absent for a normal full-time win. */
export type ResultKind = "AET" | "PEN";

export interface FixtureResult {
  homeScore: number;
  awayScore: number;
  /** "AET" if decided in extra time, "PEN" if by penalty shootout. */
  decidedBy?: ResultKind;
  /** Shootout tally (shown as e.g. 4–3), only meaningful when decidedBy === "PEN". */
  penHome?: number;
  penAway?: number;
}

export interface FixtureMeta {
  home: string;
  away: string;
  /** Kickoff in UTC — predictions should be in before this. */
  kickoffUtc: string;
  stage: string;
  /** Final score, present once the match is settled. */
  result?: FixtureResult;
}

export const FIXTURES: Record<string, FixtureMeta> = {
  // ---- Settled (with final scores) ----
  "18179759": {
    home: "Mexico",
    away: "Ecuador",
    kickoffUtc: "2026-07-01T01:00:00Z",
    stage: "World Cup 2026 — Round of 32",
    result: { homeScore: 2, awayScore: 0 },
  },
  "18179550": {
    home: "Belgium",
    away: "Senegal",
    kickoffUtc: "2026-07-01T20:00:00Z",
    stage: "World Cup 2026 — Round of 32",
    result: { homeScore: 3, awayScore: 2, decidedBy: "AET" },
  },

  // ---- Remaining schedule (open) — from scripts/sync-schedule.mjs ----
  "18175918": {
    home: "Argentina",
    away: "Cape Verde",
    kickoffUtc: "2026-07-03T22:00:00Z",
    stage: "World Cup 2026 — Round of 16",
    result: { homeScore: 3, awayScore: 2, decidedBy: "AET" },
  },
  "18179549": {
    home: "Colombia",
    away: "Ghana",
    kickoffUtc: "2026-07-04T01:30:00Z",
    stage: "World Cup 2026 — Round of 16",
    result: { homeScore: 1, awayScore: 0 },
  },
  "18185036": {
    home: "Canada",
    away: "Morocco",
    kickoffUtc: "2026-07-04T17:00:00Z",
    stage: "World Cup 2026 — Round of 16",
    result: { homeScore: 0, awayScore: 3 },
  },
  "18188721": {
    home: "Paraguay",
    away: "France",
    kickoffUtc: "2026-07-04T21:00:00Z",
    stage: "World Cup 2026 — Round of 16",
    result: { homeScore: 0, awayScore: 1 },
  },
  "18187298": {
    home: "Brazil",
    away: "Norway",
    kickoffUtc: "2026-07-05T20:00:00Z",
    stage: "World Cup 2026 — Round of 16",
    result: { homeScore: 1, awayScore: 2 },
  },
  "18192996": {
    home: "Mexico",
    away: "England",
    kickoffUtc: "2026-07-06T00:00:00Z",
    stage: "World Cup 2026 — Round of 16",
    result: { homeScore: 2, awayScore: 3 },
  },
  "18198205": {
    home: "Portugal",
    away: "Spain",
    kickoffUtc: "2026-07-06T19:00:00Z",
    stage: "World Cup 2026 — Round of 16",
    result: { homeScore: 0, awayScore: 1 },
  },
  "18193785": {
    home: "USA",
    away: "Belgium",
    kickoffUtc: "2026-07-07T00:00:00Z",
    stage: "World Cup 2026 — Round of 16",
    result: { homeScore: 1, awayScore: 4 },
  },

  // ---- Semifinals (upcoming, not yet played — no result) ----
  "18237038": {
    home: "France",
    away: "Spain",
    kickoffUtc: "2026-07-14T19:00:00Z",
    stage: "World Cup 2026 — Semifinal",
  },
  "18241006": {
    home: "England",
    away: "Argentina",
    kickoffUtc: "2026-07-15T19:00:00Z",
    stage: "World Cup 2026 — Semifinal",
  },

  // ---- Final & Third Place (upcoming, not yet played — no result) ----
  "18257739": {
    home: "Spain",
    away: "Argentina",
    kickoffUtc: "2026-07-19T19:00:00Z",
    stage: "World Cup 2026 — Final",
  },
  "18257865": {
    home: "France",
    away: "England",
    kickoffUtc: "2026-07-18T21:00:00Z",
    stage: "World Cup 2026 — Third Place",
  },
};

export function fixtureMeta(fixtureId: string): FixtureMeta | undefined {
  return FIXTURES[fixtureId];
}

export function fixtureResult(fixtureId: string): FixtureResult | undefined {
  return FIXTURES[fixtureId]?.result;
}

export function fixtureTitle(fixtureId: string): string {
  const meta = fixtureMeta(fixtureId);
  // last digits only — enough to tell demo markets apart without jargon
  return meta
    ? `${meta.home} vs ${meta.away}`
    : `Demo Market ${fixtureId.slice(-4)}`;
}

/** Short chip for how the result was decided, e.g. "AET" or "PEN (4–3)". */
export function resultDecidedLabel(r: FixtureResult): string | undefined {
  if (r.decidedBy === "AET") return "AET";
  if (r.decidedBy === "PEN") {
    return r.penHome != null && r.penAway != null
      ? `PEN (${r.penHome}–${r.penAway})`
      : "PEN";
  }
  return undefined;
}
