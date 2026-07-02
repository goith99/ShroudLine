// Inspect the final Score/Stats structure of finished fixtures to learn how ET/PE
// are represented. FIXTURES env = comma-separated fixture ids.
// Run: NODE_OPTIONS="--dns-result-order=ipv4first" FIXTURES=18172379,18179759 \
//   yarn ts-mocha -p ./tsconfig.json -t 100000000 scripts/investigation/inspect-scores.ts

import * as fs from "fs";

const API_ORIGIN = "https://txline-dev.txodds.com";
const FIXTURES = (process.env.FIXTURES || "18172379")
  .split(",")
  .map((s) => Number(s.trim()));

const apiToken = (() => {
  const m = fs.readFileSync(".env", "utf-8").match(/^TXLINE_API_TOKEN=(.+)$/m);
  if (!m) throw new Error("TXLINE_API_TOKEN not in .env");
  return m[1].trim();
})();

const GOAL_KEYS = [
  ["full", 1, 2],
  ["H1", 1001, 1002],
  ["H2", 2001, 2002],
  ["ET1", 3001, 3002],
  ["ET2", 4001, 4002],
  ["PE", 5001, 5002],
];

describe("inspect scores structure", () => {
  it("prints ET/PE representation for finished fixtures", async function () {
    this.timeout(100000000);
    const jwt = ((await (
      await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" })
    ).json()) as { token: string }).token;
    const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

    for (const fixture of FIXTURES) {
      console.log(`\n════════ fixture ${fixture} ════════`);
      const res = await fetch(
        `${API_ORIGIN}/api/scores/historical/${fixture}`,
        { headers },
      );
      if (!res.ok) {
        console.log("  HTTP", res.status, (await res.text()).slice(0, 200));
        continue;
      }
      const events = (await res.text())
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
      if (!events.length) {
        console.log("  no score events");
        continue;
      }
      // The trailing event can be a "disconnected" marker with no Score; pick the
      // last event that actually carries a Score object.
      const scored = [...events]
        .reverse()
        .find((e) => e.Score?.Participant1);
      const last = scored || events[events.length - 1];
      const finalisedSeq =
        [...events].reverse().find((e) => /final/i.test(e.Action || ""))?.Seq ??
        "n/a";
      console.log(
        `  events=${events.length} lastSeq=${events[events.length - 1].Seq} Action=${events[events.length - 1].Action} | scoredSeq=${last.Seq} scoredAction=${last.Action} game_finalised@${finalisedSeq}`,
      );
      const p1 = last.Score?.Participant1 || {};
      const p2 = last.Score?.Participant2 || {};
      console.log("  P1 period keys:", Object.keys(p1).join(", ") || "(none)");
      console.log("  P1 full Score:", JSON.stringify(p1));
      console.log("  P2 full Score:", JSON.stringify(p2));
      const stats = last.Stats || {};
      const present = GOAL_KEYS.map(([label, hk, ak]) => {
        const h = stats[String(hk)];
        const a = stats[String(ak)];
        return h !== undefined || a !== undefined
          ? `${label}(${hk}/${ak})=${h ?? "-"}:${a ?? "-"}`
          : null;
      }).filter(Boolean);
      console.log("  goal Stats present:", present.join("  ") || "(none)");
    }
  });
});
