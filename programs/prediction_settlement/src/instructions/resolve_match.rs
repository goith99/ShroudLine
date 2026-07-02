use crate::constants::{OUTCOME_AWAY_WIN, OUTCOME_DRAW, OUTCOME_HOME_WIN};
use crate::error::ErrorCode;
use crate::instructions::txoracle::{
    validate_stat_cpi, BinaryExpression, ProofNode, ScoresBatchSummary, StatTerm, TraderPredicate,
    ValidateStatArgs,
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

/// Resolve a market by proving `claimed_outcome` through the Txoracle.
///
/// The caller supplies the Merkle proof + predicate that, per their reading of
/// the score, should evaluate to `true` for `claimed_outcome`. We CPI into
/// `validate_stat`; if the oracle agrees (returns true) we record the outcome,
/// otherwise we abort. This is trustless: the program never takes the caller's
/// word for the result, only the oracle's cryptographic verdict.
#[allow(clippy::too_many_arguments)]
pub fn resolve_match_handler(
    ctx: Context<ResolveMatch>,
    claimed_outcome: u8,
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    predicate: TraderPredicate,
    stat_a: StatTerm,
    stat_b: Option<StatTerm>,
    op: Option<BinaryExpression>,
) -> Result<()> {
    require!(
        matches!(
            claimed_outcome,
            OUTCOME_HOME_WIN | OUTCOME_AWAY_WIN | OUTCOME_DRAW
        ),
        ErrorCode::InvalidOutcome
    );

    let args = ValidateStatArgs {
        ts,
        fixture_summary,
        fixture_proof,
        main_tree_proof,
        predicate,
        stat_a,
        stat_b,
        op,
    };

    let verdict = validate_stat_cpi(
        &ctx.accounts.daily_scores_roots.to_account_info(),
        &ctx.accounts.txoracle_program.to_account_info(),
        args,
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

// ---------------------------------------------------------------------------
// TEST-ONLY resolve path (feature `test-resolve`)
// ---------------------------------------------------------------------------
//
// The real settlement path (`resolve_match` above) only flips `resolved` when a
// genuine Txoracle `validate_stat` Merkle proof verifies. Producing that proof
// needs the paid `/api/token/activate` subscribe token we don't yet have on
// devnet, so `resolve_match` can never return `true` from manufactured data (see
// the `cpi-verified` findings). This bypass lets the encrypted
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
