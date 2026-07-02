// Fresh re-verification of period stat-key semantics. Prints RAW data from both
// sources side by side, no summarizing:
//   1. full historical event stream (Stats progression per seq) for the fixture
//   2. final Score object (all period sub-objects), raw JSON
//   3. stat-validation at the final seq for full-game + all period keys,
//      printing the FULL statToProve objects (key, value, period)
//   4. same stat-validation sweep at the absolute last seq if different
// Run: NODE_OPTIONS="--dns-result-order=ipv4first" FIXTURE=18179550 \
//   yarn ts-mocha -p ./tsconfig.json -t 100000000 scripts/investigation/verify-period-keys.ts

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
const TRACKED = KEY_PAIRS.flatMap(([, h, a]) => [h, a]);

describe("verify period keys (fresh)", () => {
  it("prints raw stream + stat-validation side by side", async function () {
    this.timeout(100000000);
    const jwt = ((await (
      await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" })
    ).json()) as { token: string }).token;
    const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

    // ---- 1) historical stream, full progression ----
    const res = await fetch(
      `${API_ORIGIN}/api/scores/historical/${FIXTURE}`,
      { headers },
    );
    console.log("historical HTTP", res.status);
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
    console.log("event count:", events.length);
    if (!events.length) throw new Error("no events");
    console.log("first event top-level keys:", Object.keys(events[0]).join(", "));

    // Print every event where a tracked stat or the Score changed.
    let prevSig = "";
    console.log("\n──── Stats/Score progression (only rows where tracked values change) ────");
    for (const e of events) {
      const stats = e.Stats || {};
      const statStr = TRACKED.map((k) =>
        stats[String(k)] !== undefined ? `${k}=${stats[String(k)]}` : null,
      )
        .filter(Boolean)
        .join(" ");
      const p1 = e.Score?.Participant1;
      const p2 = e.Score?.Participant2;
      const scoreStr = p1
        ? Object.keys(p1)
            .map((per) => `${per}:${p1[per]?.Goals ?? "?"}-${p2?.[per]?.Goals ?? "?"}`)
            .join(" ")
        : "";
      const sig = statStr + "|" + scoreStr;
      if (sig !== prevSig || /final|period|start|end/i.test(e.Action || "")) {
        console.log(
          `  seq=${e.Seq} ts=${e.Ts ?? e.Timestamp ?? "?"} Action=${e.Action}` +
            `\n      Stats: ${statStr || "(none)"}` +
            `\n      Score: ${scoreStr || "(none)"}`,
        );
        prevSig = sig;
      }
    }

    // ---- 2) final Score object raw ----
    const lastScored = [...events].reverse().find((e) => e.Score?.Participant1);
    const finalised = [...events].reverse().find((e) => /final/i.test(e.Action || ""));
    const lastSeq = events[events.length - 1].Seq;
    console.log("\n──── final Score object (raw, unmodified) ────");
    console.log("from event seq", lastScored?.Seq, "Action:", lastScored?.Action);
    console.log("Participant1:", JSON.stringify(lastScored?.Score?.Participant1, null, 2));
    console.log("Participant2:", JSON.stringify(lastScored?.Score?.Participant2, null, 2));
    console.log("full Stats map at that event:", JSON.stringify(lastScored?.Stats));
    console.log(
      `\ngame_finalised seq=${finalised?.Seq} (Action=${finalised?.Action}); absolute last seq=${lastSeq}`,
    );

    // ---- 3) stat-validation sweep at candidate seqs ----
    const seqs = [...new Set([finalised?.Seq, lastScored?.Seq, lastSeq].filter((s) => s != null))];
    for (const seq of seqs) {
      console.log(`\n──── stat-validation sweep at seq=${seq} ────`);
      for (const [label, hk, ak] of KEY_PAIRS) {
        const url = `${API_ORIGIN}/api/scores/stat-validation?fixtureId=${FIXTURE}&seq=${seq}&statKey=${hk}&statKey2=${ak}`;
        const r = await fetch(url, { headers });
        const text = await r.text();
        if (!r.ok) {
          console.log(`  ${label} (${hk}/${ak}): HTTP ${r.status} — ${text.slice(0, 150)}`);
          continue;
        }
        const j = JSON.parse(text);
        console.log(
          `  ${label} (${hk}/${ak}): statToProve=${JSON.stringify(j.statToProve)} statToProve2=${JSON.stringify(j.statToProve2)} ts=${j.ts} seqEcho=${j.seq ?? "-"}`,
        );
      }
    }
  });
});
