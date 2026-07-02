# ShroudLine

**ShroudLine** — private prediction settlement: encrypted match predictions
settled by a trustless on-chain oracle. Users submit predictions **encrypted** via Arcium
MPC (no one, not even the market creator, sees a guess before settlement), the
match result is proven **trustlessly** by a CPI into TxODDS's on-chain
`Txoracle` (`validate_stat`), and Arcium MPC then settles who was right and pays
out — all on-chain, with no self-reported results.

## How settlement works

1. `submit_prediction` — each user encrypts their outcome guess to the MXE and
   stakes SOL. The ciphertext is stored on-chain; the plaintext never is.
2. `resolve_match` — anyone can supply a TxLINE Merkle proof of the score; the
   program CPIs into `Txoracle::validate_stat`, which cryptographically verifies
   the result against the on-chain daily-scores root. The program records the
   outcome **only if the oracle returns true** — it never trusts the caller.
3. `settle_prediction` — an Arcium circuit compares each encrypted prediction
   against the resolved outcome and pays correct predictors from the vault.

Outcomes are determined from the oracle's **full-game goal totals** (home vs
away), which include extra-time goals, via a `Subtract` + comparison predicate
(`> 0` home win, `< 0` away win, `= 0` draw).

### Result coverage & known limitations

- **Full-time and extra-time results resolve automatically via the on-chain
  oracle** (verified end-to-end on devnet against both a 90-minute match —
  Mexico 2–0 Ecuador — and a real 3–2 extra-time match).
- **Penalty-shootout results are a known limitation.** TxLINE's published
  stat-key period table doesn't match the feed (HT occupies +2000, shifting
  the H2/ET slots); we use full-game keys 1/2, which are verified correct
  against the real 3–2 AET match (see `scripts/investigation/`). Full-game
  goal totals include extra time but, by football convention, exclude
  shootout goals, so a penalty-decided match reads as a goal-difference draw.
  Rather than mis-settle such a match, a knockout-stage fixture that the
  oracle confirms as a full-time+extra-time draw is **flagged
  `needs_manual_review` and left unresolved** (settlement blocked) instead of
  silently resolving as a draw. Shootout resolution is deferred to a future
  iteration: no finished shootout fixture has been available to verify the PE
  stat keys against (likely the +6000 slot under the feed's actual
  numbering).

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
