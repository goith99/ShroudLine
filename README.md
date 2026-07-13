# ShroudLine

**ShroudLine** — private prediction settlement: encrypted match predictions
settled by a trustless on-chain oracle. Users submit predictions **encrypted** via Arcium
MPC (no one, not even the market creator, sees a guess before settlement), the
match result is proven **trustlessly** by a CPI into TxODDS's on-chain
`Txoracle` (`validate_stat_v2`), and Arcium MPC then settles who was right and pays
out — all on-chain, with no self-reported results.

## How settlement works

1. `submit_prediction` — each user encrypts their outcome guess to the MXE and
   stakes SOL. The ciphertext is stored on-chain; the plaintext never is.
2. `resolve_match_v2` — anyone can supply the TxLINE Merkle-proven stats for the
   final-whistle snapshot; the program pins each stat to a fixed index, builds
   the winner-determination strategy itself, and CPIs into
   `Txoracle::validate_stat_v2`, which cryptographically verifies the result
   against the on-chain daily-scores root. The program records the outcome
   **only if the oracle returns true** — it never trusts the caller.
3. `settle_prediction` — an Arcium circuit compares each encrypted prediction
   against the resolved outcome and pays correct predictors from the vault.

### Result coverage

**The resolution logic supports all match outcomes — regulation, extra time,
and penalty shootouts.** Using TxLINE's N-stat `validate_stat_v2`, the program
proves the relevant stats at one witness snapshot and builds a conjunctive
strategy on-chain:

- **Regulation / extra-time** (2 stats): decided on the full-game goal
  difference of keys `1`/`2` (home/away goals, which include extra time), via a
  `Subtract` + comparison leg (`> 0` home, `< 0` away, `= 0` draw for group
  matches). Verified end-to-end on devnet against a 90-minute match (Mexico 2–0
  Ecuador) and a real 3–2 extra-time match (Belgium–Senegal).
- **Penalty shootout** (4 stats, knockout only): because full-game keys `1`/`2`
  exclude shootout goals, `k1 == k2` exactly identifies "level after extra time,
  i.e. went to penalties." The program then ANDs two legs in a single call —
  *level after ET* (`k1 - k2 == 0`) **and** *shootout winner*
  (`k6001 - k6002` sign) — so the shootout winner is settled directly.

The two paths are mutually exclusive and every leg is Merkle-verified by the
oracle, so submitting the wrong path or a false claim can only *fail* to
resolve, never mis-resolve; index→stat identity is pinned on-chain
(`stats[0].key == 1`, etc.) so leaves can't be swapped to invert a result. A
knockout can never settle as a draw (ties are always broken).

The penalty-shootout path is validated end-to-end against **synthetic** shootout
data (unit tests in `resolve_match.rs` drive the exact predicate legs the
program emits through the oracle's documented semantics across regulation, ET,
and shootout scenarios) — pending a real completed shootout fixture in the
tournament for final confirmation.

**Caveat — PE key offset (empirically unverified):** the penalty-shootout goal
keys are taken to be `6001`/`6002` (the `+6000` period offset), inferred from
the feed's numbering (ET2 = `+5000` and ETTotal = `+7000` are confirmed against
real matches). No finished penalty fixture has yet been available to confirm the
`+6000` slot, so these keys are named constants (`KEY_HOME_PE_GOALS` /
`KEY_AWAY_PE_GOALS`) — a one-line change once a real FPE fixture confirms the
numbering. TxLINE has also indicated an **upcoming fix (a dedicated
`END` / `period=19` marker on `game_finalised` records)** that may resolve the
penalty-shootout stat-selection cleanly — worth revisiting once live.

## Automated markets & schedule

Market creation and resolution run **automatically** — no scripts to re-run by
hand. A continuously-running **worker** (`worker/index.mjs`, deployed on
**Railway**) drives the full remaining World Cup schedule via two adaptive loops
against the live devnet program:

- **Market creation** — it discovers new World Cup fixtures from TxLINE's
  official schedule (competition 72) and creates a market for each newly
  confirmed fixture before kickoff, skipping any that already exist.
- **Resolution** — after a match's expected end time it polls the TxLINE feed
  adaptively (fast near the final whistle, backing off otherwise) and, once the
  match finalises, resolves the market through the same oracle-verified path
  described above (`resolve_match_v2` → `Txoracle::validate_stat_v2`) — so
  results are never self-reported.

(See `worker/README.md` for its configuration and deployment. The one-shot
`scripts/sync-schedule.mjs` still exists for manual/local use, but the worker
supersedes the old "re-run it periodically before the deadline" workflow.)

Team names, kickoff times, stage, and the **final score** of settled matches are
still curated in `frontend/src/lib/fixtures.ts` (the program stores only the
outcome *direction*, never the numeric score). New markets no longer need a
manual edit to display, though: when a fixture isn't in `fixtures.ts` yet, the
frontend falls back to a live server-side lookup (`frontend/src/app/api/fixture-meta`)
that pulls team names — and the final score once available — straight from
TxLINE, shortly after the market is created. The hand-maintained `fixtures.ts`
entries are now for **long-term curation and precise `AET` / `PEN (x–y)`
labeling**, not for basic display. Settled market cards show the real scoreline —
e.g. `MEXICO 2 — 0 ECUADOR` — with an `AET` chip for extra-time results and a
`PEN (x–y)` chip for shootout wins.

## Frontend

The web app (`frontend/`) encrypts each pick **in the browser** before it is
submitted — the plaintext never leaves the device — and presents markets in a
bright, World Cup–inspired match-day theme. Its footer credits **Powered by
TxLINE** (<https://txodds.net>) and **Confidential compute by Arcium**
(<https://www.arcium.com>).

## Quickstart

```bash
arcium build
arcium test
```

## Layout

| Path | Purpose |
|------|---------|
| `programs/shroudline/` | Anchor program: queues computations, handles callbacks |
| `encrypted-ixs/` | Arcis confidential instructions |
| `worker/` | Railway worker: auto-creates & resolves markets ([details](worker/README.md)) |
| `tests/shroudline.ts` | TypeScript integration tests |
| `Arcium.toml` | Localnet and cluster configuration |

## Docs

<https://docs.arcium.com/developers>
