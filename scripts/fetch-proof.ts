// Read-only: verify the TXLINE_API_TOKEN works and inspect real match data for a
// fixture, so we can map it onto resolve_match. Run:
//   NODE_OPTIONS="--dns-result-order=ipv4first" \
//     yarn ts-mocha -p ./tsconfig.json -t 100000000 scripts/fetch-proof.ts

import * as fs from "fs";

const API_ORIGIN = "https://txline-dev.txodds.com";
const FIXTURE = Number(process.env.FIXTURE_ID || "18179759");

function envToken(): string {
  const m = fs.readFileSync(".env", "utf-8").match(/^TXLINE_API_TOKEN=(.+)$/m);
  if (!m) throw new Error("TXLINE_API_TOKEN not in .env — run get-api-token.ts first");
  return m[1].trim();
}

describe("TxLINE fetch proof (read-only)", () => {
  it("fetches historical + stat-validation for the fixture", async function () {
    this.timeout(100000000);
    const apiToken = envToken();

    const jwt = ((await (
      await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" })
    ).json()) as { token: string }).token;
    const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

    // 1) historical: full sequence of score updates -> discover seq
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
    // The trailing event can be a "disconnected" marker; the authoritative final
    // score is the game_finalised event.
    const fin = [...events].reverse().find((e) => /final/i.test(e.Action || ""));
    const last = fin ?? events[events.length - 1];
    const seq = Number(process.env.SEQ ?? last.Seq);
    console.log(
      `final event: Action=${last.Action} Seq=${last.Seq} Stats{1:${last.Stats?.["1"]}, 2:${last.Stats?.["2"]}}`,
    );

    // 2) stat-validation for the final score (home key=1, away key=2)
    const url = `${API_ORIGIN}/api/scores/stat-validation?fixtureId=${FIXTURE}&seq=${seq}&statKey=1&statKey2=2`;
    const svRes = await fetch(url, { headers });
    const svText = await svRes.text();
    console.log("stat-validation HTTP", svRes.status, "for seq", seq);
    if (!svRes.ok) {
      console.log(svText.slice(0, 600));
      throw new Error("stat-validation failed");
    }
    const sv = JSON.parse(svText);
    fs.writeFileSync(
      `scripts/proof-${FIXTURE}.json`,
      JSON.stringify({ seq, ...sv }, null, 2),
    );
    console.log("saved scripts/proof-" + FIXTURE + ".json");
    console.log("ts:", sv.ts);
    console.log("summary:", JSON.stringify(sv.summary));
    console.log("statToProve (home):", JSON.stringify(sv.statToProve));
    console.log("statToProve2 (away):", JSON.stringify(sv.statToProve2));
    console.log("eventStatRoot:", sv.eventStatRoot);
    console.log(
      "proof lengths -> subTree:",
      sv.subTreeProof?.length,
      "mainTree:",
      sv.mainTreeProof?.length,
      "statProof:",
      sv.statProof?.length,
    );
    console.log("statProof[0]:", JSON.stringify(sv.statProof?.[0]));
  });
});
