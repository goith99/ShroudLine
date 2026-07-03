# TxLINE scores-feed investigation — findings

Diagnostics in this directory (`verify-period-keys.ts`, `period-field-check.ts`,
`inspect-scores.ts`, `stat-keys.ts`, …) map TxLINE's scores stat-validation feed
onto our on-chain resolution. Corrected framing below.

## "Period" is a witness-selection concept, not a query parameter

Our earlier note that *"the `period` parameter has no effect"* was **testing the
wrong mental model**, not a TxLINE bug. There is no server-side `period` filter
to pass; the period lives in the **stat key number** (base + offset), and *which
moment* you validate is chosen by the **`seq`** you point `stat-validation` at.

The correct pattern (confirmed against TxLINE's official examples repo, which
selects a `seq` per validation) is: **observe the specific `seq` at which your
predicate holds — e.g. the `game_finalised` event for the final result — then
validate the stats at that `seq`.** Our `fetch-proof.ts` already does exactly
this (it derives `seq` from the `game_finalised` event), so resolving on the
final-whistle snapshot was correct usage of the pattern all along. Requests like
`&period=5` are simply ignored because no such parameter exists — the period
dimension is entirely encoded in the key offset.

## Still valid: the documented period-OFFSET-ON-KEY table doesn't match the feed

This is a separate, genuine discrepancy (unrelated to the above and still worth
reporting as feedback). The published docs table (`H1=+1000, H2=+2000,
ET1=+3000, ET2=+4000, PE=+5000`) does **not** match the live feed, which inserts
`HT` as its own slot and shifts everything after it. Empirically (re-verified
against 3 finished fixtures, 4 stat types):

| Offset | Docs say | Feed actually is |
|-------:|----------|------------------|
| +1000  | H1       | H1 ✅ |
| +2000  | H2       | **HT** (cumulative at half-time) |
| +3000  | ET1      | **H2** |
| +4000  | ET2      | ET1 |
| +5000  | PE       | **ET2** (confirmed: 18179550 ET2 winner) |
| +6000  | —        | **PE presumed** (unverified — no FPE fixture yet) |
| +7000  | —        | **ETTotal** (confirmed) |

Base keys per slot: `1/2` goals H/A, `3/4` yellows, `5/6` reds, `7/8` corners.

## Consequences for resolution

- Full-game keys `1`/`2` (period 0) are correct and **include extra time but
  exclude shootout goals** — verified against the real 3–2 AET match
  (18179550, key1 = 3). So `k1 == k2` cleanly identifies a penalty shootout.
- Penalty-shootout goals are taken to be keys `6001`/`6002` (the `+6000` slot),
  which is **inferred, not yet empirically verified** — pending a finished FPE
  fixture. See `resolve_match.rs` (`KEY_HOME_PE_GOALS` / `KEY_AWAY_PE_GOALS`)
  and the README caveat.
- TxLINE has indicated an upcoming `END` / `period=19` marker on
  `game_finalised` records that may make final-result / shootout stat selection
  cleaner — revisit once live.
