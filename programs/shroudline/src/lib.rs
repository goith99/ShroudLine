pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
pub use constants::*;
pub use instructions::*;
#[allow(unused_imports)]
pub use state::*;

declare_id!("6pL5a3nAUGa8Gfnkz1K936quUJs59aXe8Ybekk7aWD5a");

#[arcium_program]
pub mod shroudline {
    use super::*;

    // ---- Prediction-market instructions ----

    /// Create a market for a TxODDS fixture with a fixed per-prediction stake.
    pub fn init_market(
        ctx: Context<InitMarket>,
        fixture_id: i64,
        stake_amount: u64,
        is_knockout: bool,
    ) -> Result<()> {
        init_market::init_market_handler(ctx, fixture_id, stake_amount, is_knockout)
    }

    /// Resolve the market by proving the outcome through a Txoracle `validate_stat` CPI.
    #[allow(clippy::too_many_arguments)]
    pub fn resolve_match(
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
        resolve_match::resolve_match_handler(
            ctx,
            claimed_outcome,
            ts,
            fixture_summary,
            fixture_proof,
            main_tree_proof,
            predicate,
            stat_a,
            stat_b,
            op,
        )
    }

    /// TEST-ONLY (feature `test-resolve`): resolve a market by fiat, bypassing
    /// the Txoracle CPI, so the encrypted submit -> settle payout flow can be
    /// tested without a real Merkle proof. Never enable this for mainnet.
    #[cfg(feature = "test-resolve")]
    pub fn resolve_match_test(ctx: Context<ResolveMatchTest>, claimed_outcome: u8) -> Result<()> {
        resolve_match::resolve_match_test_handler(ctx, claimed_outcome)
    }

    // ---- Arcium: encrypted prediction submission ----

    /// Init the `store_prediction` computation definition (call once).
    pub fn init_store_prediction_comp_def(
        ctx: Context<InitStorePredictionCompDef>,
    ) -> Result<()> {
        submit_prediction::init_store_prediction_comp_def_handler(ctx)
    }

    /// Stake SOL and submit an encrypted prediction; queues re-encryption to MXE state.
    pub fn submit_prediction(
        ctx: Context<SubmitPrediction>,
        computation_offset: u64,
        ciphertext: [u8; 32],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        submit_prediction::submit_prediction_handler(ctx, computation_offset, ciphertext, pubkey, nonce)
    }

    #[arcium_callback(encrypted_ix = "store_prediction")]
    pub fn store_prediction_callback(
        ctx: Context<StorePredictionCallback>,
        output: SignedComputationOutputs<StorePredictionOutput>,
    ) -> Result<()> {
        submit_prediction::store_prediction_callback_handler(ctx, output)
    }

    // ---- Arcium: encrypted prediction settlement ----

    /// Init the `check_prediction` computation definition (call once).
    pub fn init_check_prediction_comp_def(
        ctx: Context<InitCheckPredictionCompDef>,
    ) -> Result<()> {
        settle_prediction::init_check_prediction_comp_def_handler(ctx)
    }

    /// Compare the encrypted prediction against the resolved outcome; queues payout.
    pub fn settle_prediction(
        ctx: Context<SettlePrediction>,
        computation_offset: u64,
    ) -> Result<()> {
        settle_prediction::settle_prediction_handler(ctx, computation_offset)
    }

    #[arcium_callback(encrypted_ix = "check_prediction")]
    pub fn check_prediction_callback(
        ctx: Context<CheckPredictionCallback>,
        output: SignedComputationOutputs<CheckPredictionOutput>,
    ) -> Result<()> {
        settle_prediction::check_prediction_callback_handler(ctx, output)
    }
}
