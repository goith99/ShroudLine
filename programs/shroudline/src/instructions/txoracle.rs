//! Cross-program interface for TxODDS's on-chain `Txoracle` program.
//!
//! We don't depend on the Txoracle crate directly; instead we reconstruct its
//! `validate_stat_v2` instruction by hand (Anchor discriminator + borsh args)
//! and `invoke` it, then read the returned `bool` from the CPI return data.
//!
//! Struct/enum layouts mirror the verified Txoracle IDL v1.5.5 exactly. Field
//! order MUST NOT change — it defines the borsh wire format the oracle expects.
//!
//! V2 (`validate_stat_v2`) proves N stats at one witness snapshot and evaluates
//! an `NDimensionalStrategy` (a conjunction of predicate legs) over them in a
//! single call. This supersedes the retired single-/two-stat `validate_stat`.

use crate::constants::{TXORACLE_PROGRAM_ID, VALIDATE_STAT_V2_DISCRIMINATOR};
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

/// A single provable key-value statistic — the leaf of the inner-most tree.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoreStat {
    /// Stat key (base + period offset), e.g. 1 = home full-game goals,
    /// 6001 = home penalty-shootout goals. See constants.rs.
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

/// One stat to prove plus the Merkle branch that commits it. All leaves in a
/// `StatValidationInput` share the top-level `event_stat_root`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatLeaf {
    pub stat: ScoreStat,
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

/// A geometric target used by the (unused here) distance-based strategy leg.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct GeometricTarget {
    pub stat_index: u8,
    pub prediction: i32,
}

/// A single predicate leg over the proven `stats` array. `discrete_predicates`
/// are ANDed together by the oracle.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum StatPredicate {
    /// `stats[index]` {>,<,=} `predicate.threshold`
    Single {
        index: u8,
        predicate: TraderPredicate,
    },
    /// `(stats[index_a] op stats[index_b])` {>,<,=} `predicate.threshold`
    Binary {
        index_a: u8,
        index_b: u8,
        op: BinaryExpression,
        predicate: TraderPredicate,
    },
}

/// N-stat validation payload: one witness snapshot, one shared `event_stat_root`,
/// and a list of `(stat, proof)` leaves proven against it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatValidationInput {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub event_stat_root: [u8; 32],
    pub stats: Vec<StatLeaf>,
}

/// The strategy evaluated over the proven `stats`. We only use
/// `discrete_predicates` (a conjunction of legs); the geometric/distance
/// machinery is included for wire-compatibility and left empty.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct NDimensionalStrategy {
    pub geometric_targets: Vec<GeometricTarget>,
    pub distance_predicate: Option<TraderPredicate>,
    pub discrete_predicates: Vec<StatPredicate>,
}

/// Borsh payload for `validate_stat_v2`, in the exact IDL argument order.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
struct ValidateStatV2Args {
    payload: StatValidationInput,
    strategy: NDimensionalStrategy,
}

/// CPI into `Txoracle::validate_stat_v2` and return the oracle's boolean verdict.
///
/// `daily_scores_roots` is the single read-only `daily_scores_merkle_roots`
/// account the oracle expects (not a signer).
pub fn validate_stat_v2_cpi<'info>(
    daily_scores_roots: &AccountInfo<'info>,
    txoracle_program: &AccountInfo<'info>,
    payload: StatValidationInput,
    strategy: NDimensionalStrategy,
) -> Result<bool> {
    require_keys_eq!(
        *txoracle_program.key,
        TXORACLE_PROGRAM_ID,
        ErrorCode::InvalidOracleProgram
    );

    let mut data = VALIDATE_STAT_V2_DISCRIMINATOR.to_vec();
    ValidateStatV2Args { payload, strategy }.serialize(&mut data)?;

    let ix = Instruction {
        program_id: TXORACLE_PROGRAM_ID,
        accounts: vec![AccountMeta::new_readonly(*daily_scores_roots.key, false)],
        data,
    };

    invoke(&ix, &[daily_scores_roots.clone(), txoracle_program.clone()])?;

    // `validate_stat_v2` returns bool -> borsh-encoded as a single byte (0/1).
    let (program_id, ret) = get_return_data().ok_or(ErrorCode::OracleNoReturnData)?;
    require_keys_eq!(
        program_id,
        TXORACLE_PROGRAM_ID,
        ErrorCode::InvalidOracleProgram
    );
    let verdict = *ret.first().ok_or(ErrorCode::OracleNoReturnData)? != 0;
    Ok(verdict)
}
