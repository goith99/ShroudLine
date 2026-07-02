//! Cross-program interface for TxODDS's on-chain `Txoracle` program.
//!
//! We don't depend on the Txoracle crate directly; instead we reconstruct its
//! `validate_stat` instruction by hand (Anchor discriminator + borsh args) and
//! `invoke` it, then read the returned `bool` from the CPI return data.
//!
//! Struct/enum layouts mirror the verified Txoracle IDL v1.5.2 exactly
//! (see PROJECT_CONTEXT.md). Field order MUST NOT change — it defines the
//! borsh wire format the oracle expects.

use crate::constants::{TXORACLE_PROGRAM_ID, VALIDATE_STAT_DISCRIMINATOR};
use crate::error::ErrorCode;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{get_return_data, invoke};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoreStat {
    /// Stat key (e.g. 1 = home goals, 2 = away goals). See PROJECT_CONTEXT.md.
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

/// Borsh payload for `validate_stat`, in the exact IDL argument order.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ValidateStatArgs {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub predicate: TraderPredicate,
    pub stat_a: StatTerm,
    pub stat_b: Option<StatTerm>,
    pub op: Option<BinaryExpression>,
}

/// CPI into `Txoracle::validate_stat` and return the oracle's boolean verdict.
///
/// `daily_scores_roots` is the single read-only `daily_scores_merkle_roots`
/// account the oracle expects (not a signer).
pub fn validate_stat_cpi<'info>(
    daily_scores_roots: &AccountInfo<'info>,
    txoracle_program: &AccountInfo<'info>,
    args: ValidateStatArgs,
) -> Result<bool> {
    require_keys_eq!(
        *txoracle_program.key,
        TXORACLE_PROGRAM_ID,
        ErrorCode::InvalidOracleProgram
    );

    let mut data = VALIDATE_STAT_DISCRIMINATOR.to_vec();
    args.serialize(&mut data)?;

    let ix = Instruction {
        program_id: TXORACLE_PROGRAM_ID,
        accounts: vec![AccountMeta::new_readonly(*daily_scores_roots.key, false)],
        data,
    };

    invoke(
        &ix,
        &[daily_scores_roots.clone(), txoracle_program.clone()],
    )?;

    // `validate_stat` returns bool -> borsh-encoded as a single byte (0/1).
    let (program_id, ret) = get_return_data().ok_or(ErrorCode::OracleNoReturnData)?;
    require_keys_eq!(program_id, TXORACLE_PROGRAM_ID, ErrorCode::InvalidOracleProgram);
    let verdict = *ret.first().ok_or(ErrorCode::OracleNoReturnData)? != 0;
    Ok(verdict)
}
