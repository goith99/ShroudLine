# ShroudLine worker

A single long-running Node process (`worker/index.mjs`, deployed to Railway) with
two independent loops against the **live/deployed** program on devnet:

- **Loop A** — creates a `Market` for every upcoming World Cup fixture that
  doesn't have one yet (checks every 10 minutes).
- **Loop B** — resolves markets as soon as their match finalises on the TxLINE
  feed (fast adaptive polling near expected match end, backoff otherwise). This
  also clears the **pre-existing backlog** of already-finished, unresolved
  markets on startup.

It decodes on-chain accounts with a frozen IDL snapshot
(`scripts/idl-live-snapshot.json`), never `target/idl` (which `arcium build`
overwrites). See the header comment in `worker/index.mjs` for details.

Run locally:

```bash
# read-only: fetches, decodes, logs the actions it *would* take — never sends a tx
DRY_RUN=1 ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" node worker/index.mjs

# real
node worker/index.mjs      # or: npm run worker
```

## Environment variables

| Var | Required | Purpose |
| --- | --- | --- |
| `TXLINE_API_TOKEN` | yes | TxLINE X-Api-Token (read from env first, then local `.env`). |
| `ANCHOR_PROVIDER_URL` | yes | devnet RPC URL (use a Helius/paid endpoint; public devnet rate-limits `getProgramAccounts`). |
| `WORKER_FUNDER_KEYPAIR` | yes on Railway | Funder wallet as a JSON array of 64 secret-key bytes (same shape as `id.json`). Pays tx fees and tops up per-fixture authorities. Locally falls back to `ANCHOR_WALLET`, then `~/.config/solana/id.json`. |
| `WORKER_AUTHORITY_SEED` | yes | Stable master seed for deterministic per-fixture authorities. **See warning below.** |
| `WORKER_EXISTING_AUTHORITIES` | for the backlog | Keys for markets created before this worker. **See below.** |
| `COMPETITION_ID` | no | Defaults to `72` (World Cup). |
| `PE_HOME_KEY` / `PE_AWAY_KEY` | no | Penalty-shootout stat keys, default `6001`/`6002`. |
| `DRY_RUN` | no | `1` = read-only (fetch/decode/log, never send). |

## `WORKER_AUTHORITY_SEED` — never change it, never lose it

Each market is created under its own per-fixture *authority* keypair, and only
that authority can resolve the market (`resolve_match_v2` enforces
`has_one = authority`). Railway's filesystem is ephemeral and the local
`scripts/demo-market-authority-*.json` files are gitignored, so a per-fixture
authority created at runtime would be lost on the next restart — and the market
would become **permanently unresolvable**.

To avoid that, the worker derives each per-fixture authority **deterministically**
from `WORKER_AUTHORITY_SEED` (`sha256("<seed>:<fixtureId>")` → ed25519 keypair).
Same seed + same fixture id ⇒ same authority, on every restart.

**Consequence:** `WORKER_AUTHORITY_SEED` must be set to a strong, stable value and
**must never change or be lost**. If it is rotated or lost, every market created
under the old seed becomes permanently unresolvable — its authority key can no
longer be reproduced, and no one else can resolve it. Store it like any other
irrecoverable secret (a password manager / Railway's secret store), not only in
the Railway env.

## `WORKER_EXISTING_AUTHORITIES` — resolving the pre-existing backlog

The markets that already existed before this worker (created locally by
`sync-schedule.mjs` / `create-market.mjs`) use **random** authority keys that
can't be re-derived from the seed. Their keys live only in the local
`scripts/demo-market-authority-<fixtureId>.json` files, which don't exist on
Railway. Without them, the worker logs `cannot resolve … no key` and skips the
backlog.

`WORKER_EXISTING_AUTHORITIES` supplies those keys. Its exact shape is a JSON
object mapping each **fixture id (string)** to that market's authority **secret
key as a 64-number array**:

```json
{"18175918":[12,244,…,7],"18179549":[9,1,…,88]}
```

Locally the `*-authority-*.json` files are used directly, so this var is only
needed on Railway.

### Generating the value (secrets go to a file, not your terminal)

From the repo root, with the 8 (or more) `scripts/demo-market-authority-*.json`
files present:

```bash
node scripts/pack-existing-authorities.mjs
```

This writes the ready-to-paste JSON value to
`worker/existing-authorities.secret.json` (gitignored) and prints only the fixture
ids it packed — never the secret bytes. Then:

1. Open `worker/existing-authorities.secret.json`.
2. Copy its entire contents into Railway as the value of
   `WORKER_EXISTING_AUTHORITIES`.
3. Delete the file (`rm worker/existing-authorities.secret.json`).
