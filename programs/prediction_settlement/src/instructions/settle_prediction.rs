//! `settle_prediction` — compare an encrypted prediction against the resolved
//! outcome and pay out correct predictions.
//!
//! Flow:
//! 1. Require the market resolved and the prediction stored-but-not-settled.
//! 2. Queue the `check_prediction` circuit, feeding it the stored
//!    `Enc<Mxe, u8>` (via ArgBuilder::account) plus the plaintext outcome.
//! 3. The callback receives the revealed correct/incorrect bit and, if correct,
//!    transfers `stake * PAYOUT_MULTIPLIER` from the vault to the user.

use crate::constants::{
    COMP_DEF_OFFSET_CHECK_PREDICTION, MARKET_SEED, PAYOUT_MULTIPLIER, PREDICTION_CIPHERTEXT_OFFSET,
    PREDICTION_SEED, VAULT_SEED,
};
use crate::error::ErrorCode;
use crate::state::{Market, Prediction, Vault};
use crate::{ArciumSignerAccount, ID, ID_CONST};
use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

#[queue_computation_accounts("check_prediction", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SettlePrediction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        constraint = market.resolved @ ErrorCode::NotResolved,
        seeds = [MARKET_SEED, market.authority.as_ref(), &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        has_one = market,
        constraint = prediction.encrypted @ ErrorCode::PredictionNotStored,
        constraint = !prediction.settled @ ErrorCode::AlreadySettled,
        seeds = [PREDICTION_SEED, market.key().as_ref(), prediction.user.as_ref()],
        bump = prediction.bump,
    )]
    pub prediction: Box<Account<'info, Prediction>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// The user who submitted the prediction; receives the payout if correct.
    /// CHECK: address pinned to the prediction's recorded user.
    #[account(mut, address = prediction.user)]
    pub user: UncheckedAccount<'info>,

    // ---- Arcium accounts ----
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CHECK_PREDICTION))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("check_prediction")]
#[derive(Accounts)]
pub struct CheckPredictionCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CHECK_PREDICTION))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub prediction: Account<'info, Prediction>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: address pinned to the prediction's recorded user.
    #[account(mut, address = prediction.user)]
    pub user: UncheckedAccount<'info>,
}

#[init_computation_definition_accounts("check_prediction", payer)]
#[derive(Accounts)]
pub struct InitCheckPredictionCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program (not yet initialized).
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

pub fn init_check_prediction_comp_def_handler(
    ctx: Context<InitCheckPredictionCompDef>,
) -> Result<()> {
    init_computation_def(ctx.accounts, None)?;
    Ok(())
}

pub fn settle_prediction_handler(
    ctx: Context<SettlePrediction>,
    computation_offset: u64,
) -> Result<()> {
    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

    let prediction_key = ctx.accounts.prediction.key();
    let vault_key = ctx.accounts.vault.key();
    let user_key = ctx.accounts.user.key();
    let nonce = ctx.accounts.prediction.nonce;
    let outcome = ctx.accounts.market.outcome;

    // check_prediction(pred_ctxt: Enc<Mxe, u8>, outcome: u8).
    // Enc<Mxe> input order: nonce, then ciphertext (read from the account), then
    // the plaintext outcome — matching the circuit parameter order.
    let args = ArgBuilder::new()
        .plaintext_u128(nonce)
        .account(prediction_key, PREDICTION_CIPHERTEXT_OFFSET, 32)
        .plaintext_u8(outcome)
        .build();

    // Mark settled up front to prevent double-settlement / double payout.
    ctx.accounts.prediction.settled = true;

    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        vec![CheckPredictionCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[
                CallbackAccount {
                    pubkey: prediction_key,
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: vault_key,
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: user_key,
                    is_writable: true,
                },
            ],
        )?],
        1,
        0,
        0, // callback_cu_limit (0 = runtime default); new required arg in arcium 0.11
    )?;
    Ok(())
}

pub fn check_prediction_callback_handler(
    ctx: Context<CheckPredictionCallback>,
    output: SignedComputationOutputs<CheckPredictionOutput>,
) -> Result<()> {
    let correct = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(CheckPredictionOutput { field_0 }) => field_0,
        Err(e) => {
            msg!("check_prediction aborted: {}", e);
            return Err(ErrorCode::AbortedComputation.into());
        }
    };

    ctx.accounts.prediction.correct = correct;

    if correct {
        let payout = ctx
            .accounts
            .prediction
            .stake
            .checked_mul(PAYOUT_MULTIPLIER)
            .ok_or(ErrorCode::InsufficientVault)?;

        // Vault is program-owned, so payout is a direct lamport move (no CPI).
        let vault_ai = ctx.accounts.vault.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
        let available = vault_ai.lamports().saturating_sub(rent_min);
        require!(available >= payout, ErrorCode::InsufficientVault);

        **vault_ai.try_borrow_mut_lamports()? -= payout;
        **ctx.accounts.user.try_borrow_mut_lamports()? += payout;
    }

    emit!(PredictionSettled {
        prediction: ctx.accounts.prediction.key(),
        user: ctx.accounts.prediction.user,
        correct,
    });
    Ok(())
}

#[event]
pub struct PredictionSettled {
    pub prediction: Pubkey,
    pub user: Pubkey,
    pub correct: bool,
}
