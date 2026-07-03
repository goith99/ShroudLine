use crate::constants::{
    KEY_AWAY_GOALS, KEY_AWAY_PE_GOALS, KEY_HOME_GOALS, KEY_HOME_PE_GOALS, OUTCOME_AWAY_WIN,
    OUTCOME_DRAW, OUTCOME_HOME_WIN,
};
use crate::error::ErrorCode;
use crate::instructions::txoracle::{
    validate_stat_v2_cpi, BinaryExpression, Comparison, NDimensionalStrategy, ProofNode,
    ScoresBatchSummary, StatLeaf, StatPredicate, StatValidationInput, TraderPredicate,
};
use crate::state::Market;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ResolveMatch<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ErrorCode::Unauthorized,
        constraint = !market.resolved @ ErrorCode::AlreadyResolved,
    )]
    pub market: Account<'info, Market>,

    /// The `daily_scores_merkle_roots` PDA owned by the Txoracle program.
    /// Read-only; validated by the Txoracle program itself.
    /// CHECK: passed straight through to the Txoracle CPI.
    pub daily_scores_roots: UncheckedAccount<'info>,

    /// The Txoracle program we CPI into. Address checked against TXORACLE_PROGRAM_ID.
    /// CHECK: address constraint enforced in the CPI helper.
    pub txoracle_program: UncheckedAccount<'info>,
}

/// Resolve a market by proving `claimed_outcome` through the Txoracle's
/// `validate_stat_v2` (N-stat) entrypoint.
///
/// The caller supplies the Merkle-proven `stats` at the final-whistle witness
/// snapshot; the program pins each stat's key to a fixed index, builds the
/// winner-determination strategy itself, and CPIs into `validate_stat_v2`. The
/// outcome is recorded **only if the oracle returns true** — the program never
/// trusts the caller's reading of the score, only the oracle's cryptographic
/// verdict.
///
/// # Stat layout (pinned by key)
/// - `stats[0].key == 1` (home full-game goals, incl. ET, excl. shootout)
/// - `stats[1].key == 2` (away full-game goals, incl. ET, excl. shootout)
/// - shootout claims additionally require:
///   - `stats[2].key == 6001` (home penalty-shootout goals)
///   - `stats[3].key == 6002` (away penalty-shootout goals)
///
/// # Path (inferred from `stats.len()`)
/// - **2 stats** — a regulation/extra-time claim: winner from the full-game
///   goal difference (`k1 - k2`). Group markets may also claim a DRAW here.
/// - **4 stats** — a penalty-shootout claim (knockout only): the match was
///   level after ET (`k1 - k2 == 0`) AND the shootout decided it
///   (`k6001 - k6002` sign gives the winner). Both legs are ANDed in one call.
///
/// Correctness/trust: because `k1 == k2` exactly characterises "went to a
/// shootout", the two paths are mutually exclusive, and every leg is
/// Merkle-verified by the oracle — so submitting the wrong path or a false
/// claim can only *fail* to resolve, never mis-resolve. Key-pinning prevents a
/// caller from swapping which real leaf sits at which strategy index.
pub fn resolve_match_v2_handler(
    ctx: Context<ResolveMatch>,
    claimed_outcome: u8,
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    event_stat_root: [u8; 32],
    stats: Vec<StatLeaf>,
) -> Result<()> {
    let is_knockout = ctx.accounts.market.is_knockout;

    // Validate the claim + pin the stat layout, then build the winner-determination
    // strategy on-chain (never trusting a caller-supplied strategy).
    let discrete_predicates = build_resolution(claimed_outcome, is_knockout, &stats)?;

    let payload = StatValidationInput {
        ts,
        fixture_summary,
        fixture_proof,
        main_tree_proof,
        event_stat_root,
        stats,
    };
    let strategy = NDimensionalStrategy {
        geometric_targets: vec![],
        distance_predicate: None,
        discrete_predicates,
    };

    let verdict = validate_stat_v2_cpi(
        &ctx.accounts.daily_scores_roots.to_account_info(),
        &ctx.accounts.txoracle_program.to_account_info(),
        payload,
        strategy,
    )?;
    require!(verdict, ErrorCode::OracleRejected);

    let market = &mut ctx.accounts.market;
    market.resolved = true;
    market.outcome = claimed_outcome;

    msg!(
        "Market for fixture {} resolved: outcome = {}",
        market.fixture_id,
        claimed_outcome
    );
    Ok(())
}

/// Validate the claim, pin the stat layout, and build the conjunction of
/// predicate legs (`discrete_predicates`) that determines the winner. Pure
/// function of `(claimed_outcome, is_knockout, stats)` so it can be unit-tested
/// against synthetic scores without an on-chain context.
///
/// Guards (all trustless — a violation aborts rather than mis-resolving):
/// - `claimed_outcome` must be a valid outcome; a knockout can't claim DRAW.
/// - `stats[0].key == 1`, `stats[1].key == 2` (home/away full-game goals).
/// - 4-stat (shootout) path is knockout-only and requires
///   `stats[2].key == 6001`, `stats[3].key == 6002` (home/away PE goals).
fn build_resolution(
    claimed_outcome: u8,
    is_knockout: bool,
    stats: &[StatLeaf],
) -> Result<Vec<StatPredicate>> {
    require!(
        matches!(
            claimed_outcome,
            OUTCOME_HOME_WIN | OUTCOME_AWAY_WIN | OUTCOME_DRAW
        ),
        ErrorCode::InvalidOutcome
    );

    // A knockout tie is always broken (by extra time then penalties): a knockout
    // market can never settle as a DRAW.
    require!(
        !(is_knockout && claimed_outcome == OUTCOME_DRAW),
        ErrorCode::InvalidOutcome
    );

    // Pin the full-game goal stats to indices 0/1 so the strategy references the
    // intended leaves (see key-pinning note on the handler).
    require!(stats.len() >= 2, ErrorCode::InvalidStatLayout);
    require!(
        stats[0].stat.key == KEY_HOME_GOALS && stats[1].stat.key == KEY_AWAY_GOALS,
        ErrorCode::InvalidStatLayout
    );

    let predicates = match stats.len() {
        // Regulation / extra-time: decide on the full-game goal difference.
        2 => {
            let comparison = match claimed_outcome {
                OUTCOME_HOME_WIN => Comparison::GreaterThan, // k1 - k2 > 0
                OUTCOME_AWAY_WIN => Comparison::LessThan,    // k1 - k2 < 0
                OUTCOME_DRAW => Comparison::EqualTo,         // k1 - k2 == 0 (group only)
                _ => return err!(ErrorCode::InvalidOutcome),
            };
            vec![StatPredicate::Binary {
                index_a: 0,
                index_b: 1,
                op: BinaryExpression::Subtract,
                predicate: TraderPredicate {
                    threshold: 0,
                    comparison,
                },
            }]
        }
        // Penalty shootout (knockout only): level after ET AND shootout decided.
        4 => {
            require!(is_knockout, ErrorCode::InvalidStatLayout);
            require!(
                stats[2].stat.key == KEY_HOME_PE_GOALS
                    && stats[3].stat.key == KEY_AWAY_PE_GOALS,
                ErrorCode::InvalidStatLayout
            );
            let shootout_cmp = match claimed_outcome {
                OUTCOME_HOME_WIN => Comparison::GreaterThan, // k6001 - k6002 > 0
                OUTCOME_AWAY_WIN => Comparison::LessThan,    // k6001 - k6002 < 0
                _ => return err!(ErrorCode::InvalidOutcome),
            };
            vec![
                // Level after extra time -> the match went to penalties.
                StatPredicate::Binary {
                    index_a: 0,
                    index_b: 1,
                    op: BinaryExpression::Subtract,
                    predicate: TraderPredicate {
                        threshold: 0,
                        comparison: Comparison::EqualTo,
                    },
                },
                // Shootout winner.
                StatPredicate::Binary {
                    index_a: 2,
                    index_b: 3,
                    op: BinaryExpression::Subtract,
                    predicate: TraderPredicate {
                        threshold: 0,
                        comparison: shootout_cmp,
                    },
                },
            ]
        }
        _ => return err!(ErrorCode::InvalidStatLayout),
    };
    Ok(predicates)
}

// ---------------------------------------------------------------------------
// Unit tests — SYNTHETIC shootout/regulation data validating the resolution
// logic end-to-end at the predicate level (pending a real completed FPE
// fixture). We evaluate the exact predicate legs `build_resolution` emits with
// a local evaluator that mirrors the oracle's documented semantics
// (`discrete_predicates` ANDed; each `Binary` leg is `(a op b) cmp threshold`),
// so a passing test means: given these scores, the strategy the program sends
// to the oracle yields precisely the intended winner — and rejects false claims.
// This does NOT exercise the oracle's Merkle verification (that is covered by
// real-fixture regression on devnet); it proves OUR winner logic is correct.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{OUTCOME_AWAY_WIN, OUTCOME_DRAW, OUTCOME_HOME_WIN};
    use crate::instructions::txoracle::ScoreStat;

    fn leaf(key: u32, value: i32) -> StatLeaf {
        StatLeaf {
            stat: ScoreStat {
                key,
                value,
                period: 0,
            },
            stat_proof: vec![],
        }
    }

    /// Regulation/ET witness: home/away full-game goals.
    fn reg(home: i32, away: i32) -> Vec<StatLeaf> {
        vec![leaf(KEY_HOME_GOALS, home), leaf(KEY_AWAY_GOALS, away)]
    }

    /// Shootout witness: level after ET (home==away) plus PE goals.
    fn shootout(reg_goals: i32, home_pe: i32, away_pe: i32) -> Vec<StatLeaf> {
        vec![
            leaf(KEY_HOME_GOALS, reg_goals),
            leaf(KEY_AWAY_GOALS, reg_goals),
            leaf(KEY_HOME_PE_GOALS, home_pe),
            leaf(KEY_AWAY_PE_GOALS, away_pe),
        ]
    }

    /// Mirrors the oracle: AND of legs; each `Binary` is `(a op b) cmp thr`.
    fn eval(preds: &[StatPredicate], stats: &[StatLeaf]) -> bool {
        preds.iter().all(|p| match p {
            StatPredicate::Binary {
                index_a,
                index_b,
                op,
                predicate,
            } => {
                let a = stats[*index_a as usize].stat.value;
                let b = stats[*index_b as usize].stat.value;
                let lhs = match op {
                    BinaryExpression::Add => a + b,
                    BinaryExpression::Subtract => a - b,
                };
                match predicate.comparison {
                    Comparison::GreaterThan => lhs > predicate.threshold,
                    Comparison::LessThan => lhs < predicate.threshold,
                    Comparison::EqualTo => lhs == predicate.threshold,
                }
            }
            StatPredicate::Single { index, predicate } => {
                let v = stats[*index as usize].stat.value;
                match predicate.comparison {
                    Comparison::GreaterThan => v > predicate.threshold,
                    Comparison::LessThan => v < predicate.threshold,
                    Comparison::EqualTo => v == predicate.threshold,
                }
            }
        })
    }

    /// The claim resolves iff `build_resolution` succeeds AND its strategy
    /// evaluates true over the scores.
    fn resolves(outcome: u8, knockout: bool, stats: &[StatLeaf]) -> bool {
        match build_resolution(outcome, knockout, stats) {
            Ok(preds) => eval(&preds, stats),
            Err(_) => false,
        }
    }

    #[test]
    fn regulation_home_win() {
        let s = reg(2, 1);
        assert!(resolves(OUTCOME_HOME_WIN, false, &s));
        assert!(!resolves(OUTCOME_AWAY_WIN, false, &s));
        assert!(!resolves(OUTCOME_DRAW, false, &s));
    }

    #[test]
    fn regulation_away_win() {
        let s = reg(0, 3);
        assert!(resolves(OUTCOME_AWAY_WIN, false, &s));
        assert!(!resolves(OUTCOME_HOME_WIN, false, &s));
    }

    #[test]
    fn group_draw() {
        let s = reg(1, 1);
        assert!(resolves(OUTCOME_DRAW, false, &s));
        assert!(!resolves(OUTCOME_HOME_WIN, false, &s));
        assert!(!resolves(OUTCOME_AWAY_WIN, false, &s));
    }

    #[test]
    fn extra_time_win_uses_regulation_path() {
        // 3-2 AET (Belgium–Senegal shape): full-game keys include ET.
        let s = reg(3, 2);
        assert!(resolves(OUTCOME_HOME_WIN, true, &s));
        assert!(!resolves(OUTCOME_AWAY_WIN, true, &s));
    }

    #[test]
    fn knockout_cannot_be_draw() {
        // Even level scores: a knockout DRAW claim is rejected outright.
        let s = reg(1, 1);
        assert!(build_resolution(OUTCOME_DRAW, true, &s).is_err());
    }

    #[test]
    fn shootout_home_win() {
        // Level 1-1 after ET, home wins the shootout 4-3.
        let s = shootout(1, 4, 3);
        assert!(resolves(OUTCOME_HOME_WIN, true, &s));
        assert!(!resolves(OUTCOME_AWAY_WIN, true, &s));
    }

    #[test]
    fn shootout_away_win() {
        // Level 2-2 after ET, away wins the shootout 5-4.
        let s = shootout(2, 4, 5);
        assert!(resolves(OUTCOME_AWAY_WIN, true, &s));
        assert!(!resolves(OUTCOME_HOME_WIN, true, &s));
    }

    #[test]
    fn shootout_strategy_rejects_non_level_regulation() {
        // If (contrary to a shootout) regulation wasn't level, the "went to
        // penalties" leg (k1-k2==0) is false, so no shootout claim can pass —
        // this is what stops a caller mis-claiming a decisive game as a shootout.
        let mut s = shootout(1, 4, 3);
        s[1].stat.value = 0; // home 1, away 0 -> decisive, not level
        assert!(!resolves(OUTCOME_HOME_WIN, true, &s));
    }

    #[test]
    fn key_pinning_rejects_swapped_leaves() {
        // Swapping which leaf sits at index 0/1 must be rejected by the key pin,
        // preventing an inverted result.
        let swapped = vec![leaf(KEY_AWAY_GOALS, 1), leaf(KEY_HOME_GOALS, 2)];
        assert!(build_resolution(OUTCOME_HOME_WIN, false, &swapped).is_err());
    }

    #[test]
    fn shootout_requires_correct_pe_keys() {
        // 4 stats but wrong PE keys at index 2/3 -> rejected.
        let bad = vec![
            leaf(KEY_HOME_GOALS, 1),
            leaf(KEY_AWAY_GOALS, 1),
            leaf(5001, 4), // wrong offset
            leaf(5002, 3),
        ];
        assert!(build_resolution(OUTCOME_HOME_WIN, true, &bad).is_err());
    }

    #[test]
    fn four_stat_shootout_rejected_for_group_market() {
        // The shootout path is knockout-only.
        let s = shootout(1, 4, 3);
        assert!(build_resolution(OUTCOME_HOME_WIN, false, &s).is_err());
    }

    #[test]
    fn invalid_outcome_and_arity_rejected() {
        assert!(build_resolution(9, false, &reg(2, 1)).is_err());
        assert!(build_resolution(OUTCOME_HOME_WIN, false, &vec![leaf(KEY_HOME_GOALS, 1)]).is_err());
        // 3 stats is not a supported arity.
        let three = vec![
            leaf(KEY_HOME_GOALS, 1),
            leaf(KEY_AWAY_GOALS, 1),
            leaf(KEY_HOME_PE_GOALS, 4),
        ];
        assert!(build_resolution(OUTCOME_HOME_WIN, true, &three).is_err());
    }
}

// ---------------------------------------------------------------------------
// TEST-ONLY resolve path (feature `test-resolve`)
// ---------------------------------------------------------------------------
//
// The real settlement path (`resolve_match_v2` above) only flips `resolved`
// when a genuine Txoracle `validate_stat_v2` Merkle proof verifies. Producing
// that proof needs the paid subscribe token, so `resolve_match_v2` can never
// return `true` from manufactured data. This bypass lets the encrypted
// submit -> settle payout flow be exercised end-to-end in tests without real
// proof data.
//
// It is compiled ONLY when the `test-resolve` cargo feature is enabled and MUST
// NOT ship to mainnet — set `default = []` in the program Cargo.toml (dropping
// `test-resolve`) before any mainnet build. It is still `authority`-gated, so it
// can only resolve markets the caller created.

#[cfg(feature = "test-resolve")]
#[derive(Accounts)]
pub struct ResolveMatchTest<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ErrorCode::Unauthorized,
        constraint = !market.resolved @ ErrorCode::AlreadyResolved,
    )]
    pub market: Account<'info, Market>,
}

#[cfg(feature = "test-resolve")]
pub fn resolve_match_test_handler(
    ctx: Context<ResolveMatchTest>,
    claimed_outcome: u8,
) -> Result<()> {
    require!(
        matches!(
            claimed_outcome,
            OUTCOME_HOME_WIN | OUTCOME_AWAY_WIN | OUTCOME_DRAW
        ),
        ErrorCode::InvalidOutcome
    );

    let market = &mut ctx.accounts.market;
    market.resolved = true;
    market.outcome = claimed_outcome;

    msg!(
        "[TEST] Market for fixture {} resolved by fiat (oracle bypassed): outcome = {}",
        market.fixture_id,
        claimed_outcome
    );
    Ok(())
}
