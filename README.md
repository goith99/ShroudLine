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

## Demo markets & schedule

The devnet demo tracks the **full remaining World Cup schedule**, not a
hand-picked few. `scripts/sync-schedule.mjs` reads TxLINE's official fixtures
snapshot (competition 72 — the feed behind `/documentation/scores/schedule`)
and creates a market for every remaining (not-yet-kicked-off) confirmed fixture
that doesn't already have one:

```bash
DRY_RUN=1 ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" node scripts/sync-schedule.mjs  # preview
ANCHOR_PROVIDER_URL="$HELIUS_RPC_URL" node scripts/sync-schedule.mjs            # create
```

It is **idempotent and meant to be re-run periodically** before the deadline:
as later rounds are confirmed in the feed, re-running it adds only the new
markets (existing ones are left untouched) and prints ready-to-paste
`fixtures.ts` rows. It is *not* a one-time batch — the World Cup bracket fills
in over time, so re-run it whenever new fixtures are confirmed.

Team names, kickoff times, stage, and the **final score** of settled matches
live in `frontend/src/lib/fixtures.ts` (the program stores only the outcome
*direction*, never the numeric score). Settled market cards show the real
scoreline — e.g. `MEXICO 2 — 0 ECUADOR` — with an `AET` chip for extra-time
results and a `PEN (x–y)` chip for shootout wins. After a match settles, add its
`result` to `fixtures.ts`.

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
| `tests/shroudline.ts` | TypeScript integration tests |
| `Arcium.toml` | Localnet and cluster configuration |

## Docs

<https://docs.arcium.com/developers>
