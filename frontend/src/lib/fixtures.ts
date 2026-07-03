// Hardcoded fixture metadata for the demo. The on-chain program only stores a
// numeric TxODDS fixture id; team names and kickoff times live here so we
// don't have to touch the program. Markets created with unknown fixture ids
// (e.g. throwaway demo ids) fall back to a generic label.

export interface FixtureMeta {
  home: string;
  away: string;
  /** Kickoff in UTC — predictions should be in before this. */
  kickoffUtc: string;
  stage: string;
}

export const FIXTURES: Record<string, FixtureMeta> = {
  "18179759": {
    home: "Mexico",
    away: "Ecuador",
    kickoffUtc: "2026-07-01T01:00:00Z",
    stage: "World Cup 2026 — Round of 32",
  },
  "18179550": {
    home: "Belgium",
    away: "Senegal",
    kickoffUtc: "2026-07-01T20:00:00Z",
    stage: "World Cup 2026 — Round of 32",
  },
  "18175918": {
    home: "Argentina",
    away: "Cape Verde",
    kickoffUtc: "2026-07-03T22:00:00Z",
    stage: "World Cup 2026 — Round of 16",
  },
  "18198205": {
    home: "Portugal",
    away: "Spain",
    kickoffUtc: "2026-07-06T19:00:00Z",
    stage: "World Cup 2026 — Round of 16",
  },
};

export function fixtureMeta(fixtureId: string): FixtureMeta | undefined {
  return FIXTURES[fixtureId];
}

export function fixtureTitle(fixtureId: string): string {
  const meta = fixtureMeta(fixtureId);
  // last digits only — enough to tell demo markets apart without jargon
  return meta
    ? `${meta.home} vs ${meta.away}`
    : `Demo Market ${fixtureId.slice(-4)}`;
}
