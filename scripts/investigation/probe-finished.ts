// Probe TxLINE for World Cup fixtures that are FINISHED (final score in the
// feed) so we can pick recent completed knockout matches to build settled demo
// markets. Prints team names + final home/away goals (stat keys 1 & 2).
// Run: NODE_OPTIONS="--dns-result-order=ipv4first" \
//   yarn ts-mocha -p ./tsconfig.json -t 100000000 scripts/investigation/probe-finished.ts

import * as fs from "fs";

const API_ORIGIN = "https://txline-dev.txodds.com";
const COMPETITION = Number(process.env.COMPETITION_ID || "72"); // 72 = World Cup

const apiToken = (() => {
  const m = fs.readFileSync(".env", "utf-8").match(/^TXLINE_API_TOKEN=(.+)$/m);
  if (!m) throw new Error("TXLINE_API_TOKEN not in .env");
  return m[1].trim();
})();

const parseSSE = (text: string): any[] =>
  text
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

const parseBody = (text: string): any[] => {
  const t = text.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    const j = JSON.parse(t);
    return Array.isArray(j) ? j : [j];
  }
  return parseSSE(text);
};

describe("probe finished fixtures", () => {
  it("finds finished World Cup fixtures with final scores", async function () {
    this.timeout(100000000);
    const jwt = ((await (
      await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" })
    ).json()) as { token: string }).token;
    const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

    // Candidate ids: the snapshot window + a manual list of ids we know sit
    // just before it (finished matches drop off the forward snapshot).
    const snapRes = await fetch(
      `${API_ORIGIN}/api/fixtures/snapshot?competitionId=${COMPETITION}`,
      { headers },
    );
    const snap = parseBody(await snapRes.text());
    const names = new Map<number, { p1: string; p2: string; start: number }>();
    for (const f of snap) {
      const id = f.FixtureId ?? f.fixtureId;
      names.set(id, {
        p1: f.Participant1 ?? String(f.Participant1Id),
        p2: f.Participant2 ?? String(f.Participant2Id),
        start: f.StartTime ?? f.startTime,
      });
    }

    const extra = (process.env.PROBE_IDS ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    const candidates = Array.from(
      new Set<number>([...names.keys(), ...extra]),
    );

    for (const id of candidates) {
      try {
        const res = await fetch(`${API_ORIGIN}/api/scores/historical/${id}`, {
          headers,
        });
        if (!res.ok) {
          console.log(`fix=${id}  historical HTTP ${res.status}`);
          continue;
        }
        const events = parseSSE(await res.text());
        if (events.length === 0) {
          console.log(`fix=${id}  no events (not started)`);
          continue;
        }
        const fin = [...events]
          .reverse()
          .find((e) => /final/i.test(e.Action || ""));
        const last = fin ?? events[events.length - 1];
        const home = last.Stats?.["1"];
        const away = last.Stats?.["2"];
        const meta = names.get(id);
        const nm = meta ? `${meta.p1} v ${meta.p2}` : "(id only)";
        const when = meta
          ? new Date(Number(meta.start)).toISOString().slice(0, 16)
          : "?";
        const finished = fin ? "FINAL" : `live/last(${last.Action})`;
        console.log(
          `fix=${id}  ${when}  ${nm}  ${finished}  score ${home}-${away}  events=${events.length} seq=${last.Seq}`,
        );
      } catch (e) {
        console.log(`fix=${id}  error ${(e as Error).message}`);
      }
    }
  });
});
