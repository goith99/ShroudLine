# Private Prediction Settlement — Project Context

World Cup Hackathon (TxODDS x Superteam x Solana), track **"Prediction Markets and Settlement"**.
Deadline submit: **19 Juli 2026**. Prize track: 18,000 USDT (12k / 4k / 2k).
Solo dev, 18-day timeline. Don't overscope.

> ⚠️ **Before the final demo/submission deploy:** strip the `test-resolve` bypass
> instruction — see [PRE_SUBMISSION_CHECKLIST.md](PRE_SUBMISSION_CHECKLIST.md). Hard blocker.

## Project idea

"Private Prediction Settlement" — combine:
1. Encrypted user predictions via Arcium MPC (pattern reused from the `NullRef` project's
   `Enc<Mxe,u64>` encrypted-commission pattern, repurposed here for encrypted predictions)
2. Trustless match-result verification via CPI into TxODDS's on-chain `Txoracle` program
   (`validate_stat` instruction), instead of trusting a self-reported result

Differentiation: most other hackathon submissions in this track will likely be plain
dashboards/AMMs without a privacy layer. Combining encrypted predictions + trustless
oracle settlement is the differentiator.

## TxLINE / Txoracle — verified facts (from official IDL v1.5.2 and docs)

### Addresses
| | Devnet | Mainnet |
|---|---|---|
| Program ID | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` |
| TxL Token Mint | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` |
| API base | `https://txline-dev.txodds.com/api` | `https://txline.txodds.com/api` |
| Guest auth | `https://txline-dev.txodds.com/auth/guest/start` | `https://txline.txodds.com/auth/guest/start` |

Devnet free tier only supports **service level 1** (60s delayed World Cup + Int'l Friendlies
data). Even the free tier requires an **on-chain `subscribe` transaction** — no TxL payment
required, but the transaction must still be sent and confirmed, then activated via
`/api/token/activate`.

### PDA seeds (from official docs)
```typescript
// Daily Scores Merkle Roots PDA — the account passed into validate_stat
const epochDay = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
const [dailyScoresPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
  programId
);

// Token Treasury PDA (needed for subscribe instruction)
const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("token_treasury_v2")],
  programId
);

// Pricing Matrix PDA (needed for subscribe instruction)
const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("pricing_matrix")],
  programId
);
```

### `validate_stat` instruction (the core CPI target)

```
accounts: [daily_scores_merkle_roots]   // single account, read-only, NOT a signer
args:
  ts: i64
  fixture_summary: ScoresBatchSummary
  fixture_proof: Vec<ProofNode>
  main_tree_proof: Vec<ProofNode>
  predicate: TraderPredicate
  stat_a: StatTerm
  stat_b: Option<StatTerm>
  op: Option<BinaryExpression>
returns: bool
```

Exact struct definitions (verified from IDL, camelCase in TS / snake_case in Rust):

```rust
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

pub struct ScoreStat {
    pub key: u32,      // stat key, see encoding below
    pub value: i32,    // the actual stat value being proven
    pub period: i32,
}

pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,   // <- use this to directly detect a draw, no need for 2 calls
}

pub enum BinaryExpression {
    Add,
    Subtract,
}
```

### Soccer stat key encoding (from Soccer Feed docs)

Full game (period=0 or omitted):
- key `1` = Participant 1 (home) total goals
- key `2` = Participant 2 (away) total goals

Add period multiplier for specific periods: H1 +1000, H2 +2000, ET1 +3000, ET2 +4000, PE +5000
(e.g. key `1001` = home goals in first half).

### Winner determination logic

Use two-stat validation with `Subtract`:
- `stat_a` = home goals (key=1), `stat_b` = away goals (key=2), `op = Subtract`
- predicate `GreaterThan 0` → home win
- predicate `LessThan 0` → away win
- predicate `EqualTo 0` → draw

Can do all 3 as separate CPI calls (need to know outcome anyway to know which predicate to
check), or just check the one predicate the off-chain caller already expects based on their
own reading of the score, and let the CPI return `false` (fail the require) if wrong.

### Known risks (confirmed, not speculation)

- Error `ProofTooLarge` (code 6062) exists in the Txoracle program's own error list —
  confirms Merkle proof size is a real constraint they've had to guard against. Untested
  what the actual size limit is — test with a real fixture's proof depth before committing
  to a design.
- Whether cross-program CPI into `validate_stat` (as opposed to client-side `.view()`
  simulation, which is the only usage shown in official docs/examples) actually works
  is **unverified** — the account list is minimal (just one read-only account, no signer),
  which is a good sign for CPI-ability, but this needs a real devnet test.

### Reference: TxODDS's own settlement system

Txoracle already has a full matched-betting system built in: `create_intent`, `create_trade`,
`execute_match`, `settle_trade`, `settle_matched_trade`, with accounts `TradeEscrow`,
`MatchedTrade`, `OrderIntent`. Their `settle_trade` instruction uses the exact same
`validate_stat`-style predicate/proof arguments — this is a working reference implementation
of the settlement pattern, even though it's their own internal infra (not something we CPI
into directly). Their system has **no privacy layer** — everything is public — which is our
differentiation point.

### REST API — fetching proof data

```
GET /api/scores/stat-validation?fixtureId=X&seq=Y&statKey=1&statKey2=2
Headers:
  Authorization: Bearer {jwt}       // from POST /auth/guest/start
  X-Api-Token: {apiToken}           // from POST /api/token/activate (after on-chain subscribe)
```

Response contains: `summary` (→ maps to `ScoresBatchSummary`), `subTreeProof`, `mainTreeProof`,
`statToProve`, `eventStatRoot`, `statProof` (and `statToProve2`/`eventStatRoot2`/`statProof2`
if `statKey2` was passed).

### World Cup fixture IDs — Round of 32 (for live/near-live testing)

| Date | Fixture ID | Match | Kickoff (UTC) |
|---|---|---|---|
| Jul 1 2026 | 18179759 | Mexico vs Ecuador | 01:00 (likely finished — good test case) |
| Jul 1 2026 | 18179764 | England vs Congo DR | 16:00 |
| Jul 1 2026 | 18179550 | Belgium vs Senegal | 20:00 |

Full schedule: https://txline.txodds.com/documentation/scores/schedule

## No P2P Asset Transfers constraint (hackathon rule)

TxLINE's internal credit/subscription token (TxL) is locked to data-access authorization only
— **cannot** be used for peer-to-peer staking, wagering, or wallet-to-wallet transfers between
users. Our prediction market's stake mechanism must use **SOL** (or a separate token we mint),
never the TxL token.

## Arcium / NullRef pattern to reuse

From the `NullRef` project (`aripudin99/nullref-circuits`):
- `Enc<Mxe,T>` **cannot** be initialized from client-side sentinel bytes — only a dedicated
  circuit (e.g. `init_commission`-style) can produce valid encrypted state.
- ArgBuilder pattern for `Enc<Mxe>` input: `.plaintext_u128(nonce)` + `.account(pda,
  offset_ciphertext, 32)` — NOT `.account(pda, offset_nonce, 64)` (this was a real bug
  found and fixed in NullRef).
- Reveal circuit issues on devnet cluster 456 required a deactivate → close → reinit cycle
  of the computation definition after circuit hash changes from redeploy. Budget time for
  this if it recurs.
- Reuse NullRef's proven reveal-circuit pattern for comparing encrypted prediction vs
  revealed match outcome, rather than building new Arcis circuits from scratch (time risk).

## Submission requirements (from hackathon listing)

- Team max 3 people (solo is fine)
- Must be a **live/deployed** build (mainnet or devnet) — pitch decks / mockups get
  auto-disqualified
- Demo video (≤5 min), public repo link, live app link, brief technical documentation,
  feedback on TxLINE API experience — all required fields in the submission form
- Judging criteria: Core Functionality, UX & Use Case, Code Quality & Logic
- Because matches finish before the deadline, the **demo video is critical** — judges may
  not be able to test live against a finished match

## Suggested build order (18 days, solo)

1. **Days 1-2**: Verify CPI into `validate_stat` actually works from another program on
   devnet (highest risk item — do this first)
2. **Days 3-5**: Reuse NullRef's reveal circuit, adapt payload from "commission amount" to
   "prediction correct: bool"
3. **Days 6-10**: Wire up `submit_prediction` with encrypted state + end-to-end devnet testing
4. **Days 11-14**: Minimal frontend — one match, one prediction type (win/lose/draw only,
   not exact score)
5. **Remaining time**: bug buffer + record demo video (must show submit → resolve → settle
   flow end-to-end)

## Draft skeleton status

A draft `lib.rs` skeleton was written in a prior session with 4 instructions
(`init_market`, `submit_prediction`, `resolve_match`, `settle_prediction`) and PDA-based
`Market`/`Prediction` accounts. It used placeholder/guessed struct types for the Txoracle
CPI which are now **superseded by the verified IDL types above** — rewrite those structs
to match this document before continuing, not the earlier guesses.
