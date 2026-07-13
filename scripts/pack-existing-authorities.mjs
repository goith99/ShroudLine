// Package the local per-fixture authority keypairs (scripts/demo-market-authority-
// <fixtureId>.json) into the single JSON value expected by the worker's
// WORKER_EXISTING_AUTHORITIES env var, so the deployed worker can resolve the
// pre-existing market backlog (those markets' random authority keys can't be
// re-derived from WORKER_AUTHORITY_SEED).
//
// The value is written STRAIGHT TO A LOCAL FILE (never stdout), so the secret
// bytes don't linger in your terminal scrollback. The output file is gitignored.
//
// Run from repo root:
//   node scripts/pack-existing-authorities.mjs
//
// Then: open the output file, copy its contents into Railway as the value of
// WORKER_EXISTING_AUTHORITIES, and delete the file when done.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_FILE = path.join(REPO_ROOT, "worker", "existing-authorities.secret.json");

const files = fs
  .readdirSync(SCRIPTS_DIR)
  .filter((f) => /^demo-market-authority-\d+\.json$/.test(f));

if (files.length === 0) {
  console.error("No scripts/demo-market-authority-*.json files found — nothing to pack.");
  process.exit(1);
}

const out = {};
const fixtureIds = [];
for (const f of files) {
  const fixtureId = f.match(/^demo-market-authority-(\d+)\.json$/)[1];
  const secret = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, f), "utf8"));
  if (!Array.isArray(secret) || secret.length !== 64) {
    console.error(`Skipping ${f}: not a 64-byte secret-key array`);
    continue;
  }
  out[fixtureId] = secret;
  fixtureIds.push(fixtureId);
}

// Compact single-line JSON — ready to paste as an env-var value.
fs.writeFileSync(OUT_FILE, JSON.stringify(out));

// Report ONLY metadata — never the secret bytes.
console.log(`Packed ${fixtureIds.length} authority key(s) for fixtures: ${fixtureIds.sort().join(", ")}`);
console.log(`Wrote value to: ${OUT_FILE}`);
console.log("Next: copy this file's contents into Railway as WORKER_EXISTING_AUTHORITIES, then delete the file.");
console.log("(It is gitignored; do not commit it.)");
