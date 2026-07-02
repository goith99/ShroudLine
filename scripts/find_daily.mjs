import { Connection, PublicKey } from "@solana/web3.js";
const TX = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

function pda(epochDay) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(epochDay);
  return PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), buf], TX)[0];
}
const nowDay = Math.floor(Date.now() / 86400000);
const fixtureDay = Math.floor(Date.UTC(2026,6,1) / 86400000); // Jul 1 2026
console.log("today epochDay:", nowDay, " fixtureDay(Jul1):", fixtureDay);

const days = new Set();
for (let d = nowDay-7; d <= nowDay+1; d++) days.add(d);
for (let d = fixtureDay-2; d <= fixtureDay+2; d++) days.add(d);

for (const d of [...days].sort((a,b)=>a-b)) {
  const addr = pda(d);
  const info = await conn.getAccountInfo(addr);
  if (info) console.log(`FOUND day=${d} pda=${addr.toBase58()} owner=${info.owner.toBase58()} len=${info.data.length}`);
}
console.log("scan done");
