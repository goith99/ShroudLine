import fs from "fs";
const API_ORIGIN = "https://txline-dev.txodds.com";
const COMPETITION = Number(process.env.COMPETITION_ID || "72");
const m = fs.readFileSync(".env", "utf-8").match(/^TXLINE_API_TOKEN=(.+)$/m);
const apiToken = m[1].trim();
const jwt = (await (await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" })).json()).token;
const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };
const res = await fetch(`${API_ORIGIN}/api/fixtures/snapshot?competitionId=${COMPETITION}`, { headers });
const fx = JSON.parse(await res.text());
for (const f of fx.sort((a, b) => (a.StartTime || 0) - (b.StartTime || 0))) {
  const home = f.Participant1IsHome ? f.Participant1 : f.Participant2;
  const away = f.Participant1IsHome ? f.Participant2 : f.Participant1;
  console.log(
    `fix=${f.FixtureId}  start=${new Date(Number(f.StartTime)).toISOString()}  HOME=${home}  AWAY=${away}  (P1=${f.Participant1} P2=${f.Participant2} p1home=${f.Participant1IsHome})`,
  );
}
