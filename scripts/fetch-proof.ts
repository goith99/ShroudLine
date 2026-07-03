// Read-only: fetch a real TxLINE V2 stat-validation payload for a fixture and
// save it as scripts/proof-<fixture>.json for real-resolve.ts to consume. Run:
//   NODE_OPTIONS="--dns-result-order=ipv4first" \
//     yarn ts-mocha -p ./tsconfig.json -t 100000000 scripts/fetch-proof.ts
//
// V2 endpoint (`statKeys=` CSV -> statsToProve[]/statProofs[] arrays) replaces
// the retired V1 single-/two-stat form. We always fetch the full-game goal keys
// 1,2. If the match is LEVEL at the final whistle we additionally try the
// penalty-shootout keys 6001,6002 (a knockout that finished level went to a
// shootout) and fall back to the 2-stat payload if those leaves don't exist
// (e.g. a genuine group-stage draw).

import * as fs from "fs";

const API_ORIGIN = "https://txline-dev.txodds.com";
const FIXTURE = Number(process.env.FIXTURE_ID || "18179759");

// Penalty-shootout goal keys live at the +6000 period offset. This slot is
// inferred (ET2=+5000, ETTotal=+7000 confirmed) but NOT yet verified against a
// finished shootout fixture — override with PE_HOME_KEY / PE_AWAY_KEY once a
// real FPE fixture confirms the numbering.
const PE_HOME_KEY = Number(process.env.PE_HOME_KEY || "6001");
const PE_AWAY_KEY = Number(process.env.PE_AWAY_KEY || "6002");

function envToken(): string {
  const m = fs.readFileSync(".env", "utf-8").match(/^TXLINE_API_TOKEN=(.+)$/m);
  if (!m) throw new Error("TXLINE_API_TOKEN not in .env — run get-api-token.ts first");
  return m[1].trim();
}

describe("TxLINE fetch proof (read-only, V2)", () => {
  it("fetches the V2 stat-validation payload for the fixture", async function () {
    this.timeout(100000000);
    const apiToken = envToken();

    const jwt = ((await (
      await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" })
    ).json()) as { token: string }).token;
    const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

    // 1) historical: full sequence of score updates -> discover the final seq.
    const histRes = await fetch(
      `${API_ORIGIN}/api/scores/historical/${FIXTURE}`,
      { headers },
    );
    const histText = await histRes.text();
    console.log("historical HTTP", histRes.status);
    if (!histRes.ok) {
      console.log(histText.slice(0, 500));
      throw new Error("historical fetch failed");
    }
    // SSE: lines like `data: {...}` — collect the JSON payloads.
    const events = histText
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
    console.log("SSE event count:", events.length);
    // The authoritative final score is the game_finalised event (the witness
    // seq where our "final result" predicate holds).
    const fin = [...events].reverse().find((e) => /final/i.test(e.Action || ""));
    const last = fin ?? events[events.length - 1];
    const seq = Number(process.env.SEQ ?? last.Seq);
    const homeGoals = Number(last.Stats?.["1"] ?? 0);
    const awayGoals = Number(last.Stats?.["2"] ?? 0);
    const levelAtFinal = homeGoals === awayGoals;
    console.log(
      `final event: Action=${last.Action} Seq=${last.Seq} full-game 1:${homeGoals} 2:${awayGoals}` +
        (levelAtFinal ? " (LEVEL — probing shootout keys)" : ""),
    );

    // 2) V2 stat-validation. Try 4-key (incl. shootout) when level; else 2-key.
    async function fetchStatValidation(statKeys: number[]) {
      const url =
        `${API_ORIGIN}/api/scores/stat-validation` +
        `?fixtureId=${FIXTURE}&seq=${seq}&statKeys=${statKeys.join(",")}`;
      const res = await fetch(url, { headers });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text, url };
    }

    let statKeys = [1, 2];
    if (levelAtFinal) statKeys = [1, 2, PE_HOME_KEY, PE_AWAY_KEY];

    let r = await fetchStatValidation(statKeys);
    if (!r.ok && statKeys.length === 4) {
      console.log(
        `4-key request failed (HTTP ${r.status}) — no shootout leaves; ` +
          `falling back to full-game keys 1,2 (genuine draw or PE key offset wrong).`,
      );
      statKeys = [1, 2];
      r = await fetchStatValidation(statKeys);
    }
    console.log("stat-validation HTTP", r.status, "for seq", seq, "keys", statKeys.join(","));
    if (!r.ok) {
      console.log(r.text.slice(0, 600));
      throw new Error("stat-validation failed");
    }
    const sv = JSON.parse(r.text);

    fs.writeFileSync(
      `scripts/proof-${FIXTURE}.json`,
      JSON.stringify({ seq, statKeys, ...sv }, null, 2),
    );
    console.log("saved scripts/proof-" + FIXTURE + ".json");
    console.log("summary:", JSON.stringify(sv.summary));
    console.log("statsToProve:", JSON.stringify(sv.statsToProve));
    console.log("eventStatRoot:", sv.eventStatRoot);
    console.log(
      "proof lengths -> subTree:",
      sv.subTreeProof?.length,
      "mainTree:",
      sv.mainTreeProof?.length,
      "statProofs:",
      sv.statProofs?.map((p: any[]) => p.length),
    );
  });
});
