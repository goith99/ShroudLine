// Two-part TxLINE verification (read-only, touches nothing on-chain):
//
//  A) FPE scan — does any competition-72 fixture have StatusId 13 (finished on
//     penalties) in the dev feed right now? Scans historical for every snapshot
//     fixture + the two we know are finished.
//
//  B) period-field test — for the two fixtures we DID validate (18179759,
//     18179550), ask stat-validation for period 5 and compare to the full-game
//     (period-0) values we already trust. Tries both ways of specifying the
//     period: the thousands-offset statKey (5001/5002) and an explicit `period`
//     query param, so we can see which — if either — the endpoint honours.
//
// Run: NODE_OPTIONS="--dns-result-order=ipv4first" \
//   yarn ts-mocha -p ./tsconfig.json -t 100000000 scripts/investigation/period-field-check.ts

import * as fs from "fs";

const API_ORIGIN = "https://txline-dev.txodds.com";
const COMPETITION = Number(process.env.COMPETITION_ID || "72");
const KNOWN_FINISHED = [18179759, 18179550];

const apiToken = (() => {
  const m = fs.readFileSync(".env", "utf-8").match(/^TXLINE_API_TOKEN=(.+)$/m);
  if (!m) throw new Error("TXLINE_API_TOKEN not in .env");
  return m[1].trim();
})();

async function fetchRetry(url: string, init: RequestInit, tries = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

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

// Collect every distinct value seen for any key whose name contains "status".
function statusValues(events: any[]): Record<string, Set<any>> {
  const out: Record<string, Set<any>> = {};
  for (const e of events) {
    for (const [k, v] of Object.entries(e)) {
      if (/status/i.test(k)) {
        (out[k] ??= new Set()).add(v);
      }
    }
  }
  return out;
}

describe("TxLINE period-field verification", () => {
  it("scans for FPE + tests period=5 on known-finished fixtures", async function () {
    this.timeout(100000000);
    const jwt = ((await (
      await fetchRetry(`${API_ORIGIN}/auth/guest/start`, { method: "POST" })
    ).json()) as { token: string }).token;
    const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

    // ────────────────────────── A) FPE scan ──────────────────────────
    console.log("════════════ A) FPE (StatusId 13) scan — competition", COMPETITION, "════════════");
    const snapRes = await fetchRetry(
      `${API_ORIGIN}/api/fixtures/snapshot?competitionId=${COMPETITION}`,
      { headers },
    );
    const snap = parseBody(await snapRes.text());
    const names = new Map<number, string>();
    for (const f of snap) {
      const id = f.FixtureId ?? f.fixtureId;
      names.set(id, `${f.Participant1} v ${f.Participant2}`);
    }
    const scanIds = Array.from(new Set<number>([...names.keys(), ...KNOWN_FINISHED]));
    console.log(`scanning ${scanIds.length} fixtures (${snap.length} from snapshot + ${KNOWN_FINISHED.length} known-finished)\n`);

    let fpeFound: number[] = [];
    for (const id of scanIds) {
      try {
        const res = await fetchRetry(`${API_ORIGIN}/api/scores/historical/${id}`, { headers });
        if (!res.ok) {
          console.log(`  fix=${id} ${names.get(id) ?? ""} — historical HTTP ${res.status}`);
          continue;
        }
        const events = parseSSE(await res.text());
        if (!events.length) {
          console.log(`  fix=${id} ${names.get(id) ?? ""} — no events (not started)`);
          continue;
        }
        const fin = [...events].reverse().find((e) => /final/i.test(e.Action || ""));
        const svals = statusValues(events);
        const svalStr =
          Object.entries(svals)
            .map(([k, s]) => `${k}={${[...s].join(",")}}`)
            .join(" ") || "(no status field in events)";
        const has13 = Object.values(svals).some((s) => s.has(13) || s.has("13"));
        if (has13) fpeFound.push(id);
        console.log(
          `  fix=${id} ${names.get(id) ?? "(id only)"} — events=${events.length} finalised=${!!fin} ${has13 ? "★FPE★ " : ""}${svalStr}`,
        );
      } catch (e) {
        console.log(`  fix=${id} — error ${(e as Error).message}`);
      }
    }
    console.log(`\nFPE fixtures found: ${fpeFound.length ? fpeFound.join(", ") : "NONE"}`);

    // ───────────────── B) period=5 test on known fixtures ─────────────────
    console.log("\n════════════ B) period-5 test vs validated full-game (period 0) ════════════");
    for (const fixture of KNOWN_FINISHED) {
      console.log(`\n──── fixture ${fixture} ────`);
      const res = await fetchRetry(`${API_ORIGIN}/api/scores/historical/${fixture}`, { headers });
      const events = parseSSE(await res.text());
      const fin = [...events].reverse().find((e) => /final/i.test(e.Action || ""));
      const seq = Number(process.env.SEQ ?? fin?.Seq ?? events[events.length - 1].Seq);
      console.log(`  finalised seq=${seq} (Action=${fin?.Action})`);

      const call = async (label: string, qs: string) => {
        const url = `${API_ORIGIN}/api/scores/stat-validation?fixtureId=${fixture}&seq=${seq}&${qs}`;
        const r = await fetchRetry(url, { headers });
        const text = await r.text();
        if (!r.ok) {
          console.log(`    ${label.padEnd(34)} HTTP ${r.status} — ${text.slice(0, 140).replace(/\s+/g, " ")}`);
          return null;
        }
        const j = JSON.parse(text);
        console.log(
          `    ${label.padEnd(34)} home=${JSON.stringify(j.statToProve)} away=${JSON.stringify(j.statToProve2)}`,
        );
        return j;
      };

      // Baseline we already trust: plain keys 1/2 (returns period 0).
      const base = await call("baseline statKey=1/2", "statKey=1&statKey2=2");
      // period 5 via thousands-offset key.
      await call("offset statKey=5001/5002", "statKey=5001&statKey2=5002");
      // period 5 via an explicit query param, keys still 1/2.
      await call("explicit &period=5", "statKey=1&statKey2=2&period=5");
      await call("explicit &statPeriod=5", "statKey=1&statKey2=2&statPeriod=5");
      await call("explicit &period1=5&period2=5", "statKey=1&statKey2=2&period1=5&period2=5");

      if (base) {
        console.log(
          `  → validated full-game (period ${base.statToProve.period}): home=${base.statToProve.value} away=${base.statToProve2.value}`,
        );
      }
    }
  });
});
