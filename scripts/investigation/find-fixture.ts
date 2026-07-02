// Explore TxLINE fixtures to find a knockout match that went to ET/PE.
// Run: NODE_OPTIONS="--dns-result-order=ipv4first" \
//   yarn ts-mocha -p ./tsconfig.json -t 100000000 scripts/investigation/find-fixture.ts

import * as fs from "fs";

const API_ORIGIN = "https://txline-dev.txodds.com";
const COMPETITION = Number(process.env.COMPETITION_ID || "72"); // 72 = World Cup

const apiToken = (() => {
  const m = fs.readFileSync(".env", "utf-8").match(/^TXLINE_API_TOKEN=(.+)$/m);
  if (!m) throw new Error("TXLINE_API_TOKEN not in .env");
  return m[1].trim();
})();

const parseBody = (text: string): any[] => {
  const t = text.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    const j = JSON.parse(t);
    return Array.isArray(j) ? j : [j];
  }
  // SSE fallback
  return t
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
};

describe("find fixture", () => {
  it("lists fixtures + statuses for the competition", async function () {
    this.timeout(100000000);
    const jwt = ((await (
      await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" })
    ).json()) as { token: string }).token;
    const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

    const url = `${API_ORIGIN}/api/fixtures/snapshot?competitionId=${COMPETITION}`;
    const res = await fetch(url, { headers });
    const text = await res.text();
    console.log("fixtures/snapshot HTTP", res.status);
    if (!res.ok) {
      console.log(text.slice(0, 600));
      throw new Error("fixtures fetch failed");
    }
    const fx = parseBody(text);
    console.log("fixture count:", fx.length);
    if (fx[0]) console.log("first fixture keys:", Object.keys(fx[0]).join(", "));

    // Print a compact table sorted by StartTime.
    const rows = fx
      .map((f) => ({
        id: f.FixtureId ?? f.fixtureId,
        p1: f.Participant1Id ?? f.participant1Id,
        p2: f.Participant2Id ?? f.participant2Id,
        state: f.GameState ?? f.gameState,
        status: f.StatusId ?? f.statusId ?? f.Status ?? f.status,
        start: f.StartTime ?? f.startTime,
      }))
      .sort((a, b) => (a.start || 0) - (b.start || 0));
    for (const r of rows) {
      const d = r.start ? new Date(Number(r.start)).toISOString().slice(0, 16) : "?";
      console.log(
        `  ${d}  fix=${r.id}  ${r.p1}v${r.p2}  state=${r.state}  status=${r.status}`,
      );
    }
    const et = rows.filter((r) => r.status === 10 || r.status === 13);
    console.log(
      "\nFET(10)/FPE(13) matches:",
      et.length ? JSON.stringify(et) : "none",
    );
  });
});
