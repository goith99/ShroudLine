// For a finished fixture, query stat-validation across period stat keys and
// report the authoritative (Merkle-committed) value per key. This is what an
// on-chain resolve_match would actually verify.
// Run: NODE_OPTIONS="--dns-result-order=ipv4first" FIXTURE=18179550 \
//   yarn ts-mocha -p ./tsconfig.json -t 100000000 scripts/investigation/stat-keys.ts

import * as fs from "fs";

const API_ORIGIN = "https://txline-dev.txodds.com";
const FIXTURE = Number(process.env.FIXTURE || "18179550");

const apiToken = (() => {
  const m = fs.readFileSync(".env", "utf-8").match(/^TXLINE_API_TOKEN=(.+)$/m);
  if (!m) throw new Error("TXLINE_API_TOKEN not in .env");
  return m[1].trim();
})();

const KEY_PAIRS: [string, number, number][] = [
  ["full-game", 1, 2],
  ["H1", 1001, 1002],
  ["H2", 2001, 2002],
  ["ET1", 3001, 3002],
  ["ET2", 4001, 4002],
  ["PE", 5001, 5002],
];

describe("stat-validation across period keys", () => {
  it("reports committed stat values per key", async function () {
    this.timeout(100000000);
    const jwt = ((await (
      await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" })
    ).json()) as { token: string }).token;
    const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

    // find the game_finalised seq
    const events = (
      await (
        await fetch(`${API_ORIGIN}/api/scores/historical/${FIXTURE}`, { headers })
      ).text()
    )
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
    const fin = [...events].reverse().find((e) => /final/i.test(e.Action || ""));
    const seq = Number(process.env.SEQ ?? fin?.Seq ?? events[events.length - 1].Seq);
    console.log(`fixture ${FIXTURE} — using seq ${seq} (Action=${fin?.Action})`);

    for (const [label, hk, ak] of KEY_PAIRS) {
      const url = `${API_ORIGIN}/api/scores/stat-validation?fixtureId=${FIXTURE}&seq=${seq}&statKey=${hk}&statKey2=${ak}`;
      const res = await fetch(url, { headers });
      const text = await res.text();
      if (!res.ok) {
        console.log(`  ${label} (${hk}/${ak}): HTTP ${res.status} — ${text.slice(0, 120)}`);
        continue;
      }
      const j = JSON.parse(text);
      console.log(
        `  ${label} (${hk}/${ak}): home=${JSON.stringify(j.statToProve)} away=${JSON.stringify(j.statToProve2)} ts=${j.ts}`,
      );
    }
  });
});
