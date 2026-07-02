//! `submit_prediction` — user stakes SOL and submits an encrypted prediction.
//!
//! Flow:
//! 1. Create the user's `Prediction` PDA and pull their stake into the vault.
//! 2. Queue the `store_prediction` circuit, which re-encrypts the user's
//!    `Enc<Shared, u8>` prediction into `Enc<Mxe, u8>` MXE state.
//! 3. The callback writes that ciphertext + nonce onto the `Prediction` account.

use crate::constants::{COMP_DEF_OFFSET_STORE_PREDICTION, MARKET_SEED, PREDICTION_SEED, VAULT_SEED};
use crate::error::ErrorCode;
use crate::state::{Market, Prediction, Vault};
use crate::{ArciumSignerAccount, ID, ID_CONST};
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

#[queue_computation_accounts("store_prediction", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SubmitPrediction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        constraint = !market.resolved @ ErrorCode::AlreadyResolved,
        seeds = [MARKET_SEED, market.authority.as_ref(), &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = payer,
        space = 8 + Prediction::INIT_SPACE,
        seeds = [PREDICTION_SEED, market.key().as_ref(), payer.key().as_ref()],
        bump,
    )]
    pub prediction: Box<Account<'info, Prediction>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_STORE_PREDICTION))]
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

#[callback_accounts("store_prediction")]
#[derive(Accounts)]
pub struct StorePredictionCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_STORE_PREDICTION))]
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
    /// The prediction account the encrypted state is written into.
    #[account(mut)]
    pub prediction: Account<'info, Prediction>,
}

#[init_computation_definition_accounts("store_prediction", payer)]
#[derive(Accounts)]
pub struct InitStorePredictionCompDef<'info> {
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

pub fn init_store_prediction_comp_def_handler(
    ctx: Context<InitStorePredictionCompDef>,
) -> Result<()> {
    init_computation_def(ctx.accounts, None)?;
    Ok(())
}

pub fn submit_prediction_handler(
    ctx: Context<SubmitPrediction>,
    computation_offset: u64,
    ciphertext: [u8; 32],
    pubkey: [u8; 32],
    nonce: u128,
) -> Result<()> {
    let stake = ctx.accounts.market.stake_amount;

    // Pull the user's stake into the vault (SOL only — never TxL, per rules).
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        stake,
    )?;

    let prediction = &mut ctx.accounts.prediction;
    prediction.market = ctx.accounts.market.key();
    prediction.user = ctx.accounts.payer.key();
    prediction.stake = stake;
    prediction.ciphertext = [0u8; 32];
    prediction.nonce = 0;
    prediction.encrypted = false;
    prediction.settled = false;
    prediction.correct = false;
    prediction.bump = ctx.bumps.prediction;

    let market = &mut ctx.accounts.market;
    market.prediction_count += 1;
    market.total_staked += stake;

    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

    // store_prediction(pred_ctxt: Enc<Shared, u8>) — Shared input order:
    // x25519 pubkey, nonce, then the ciphertext.
    let args = ArgBuilder::new()
        .x25519_pubkey(pubkey)
        .plaintext_u128(nonce)
        .encrypted_u8(ciphertext)
        .build();

    let prediction_key = ctx.accounts.prediction.key();
    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        vec![StorePredictionCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[CallbackAccount {
                pubkey: prediction_key,
                is_writable: true,
            }],
        )?],
        1,
        0,
        0, // callback_cu_limit (0 = runtime default); new required arg in arcium 0.11
    )?;
    Ok(())
}

pub fn store_prediction_callback_handler(
    ctx: Context<StorePredictionCallback>,
    output: SignedComputationOutputs<StorePredictionOutput>,
) -> Result<()> {
    let encrypted = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(StorePredictionOutput { field_0 }) => field_0,
        Err(e) => {
            msg!("store_prediction aborted: {}", e);
            return Err(ErrorCode::AbortedComputation.into());
        }
    };

    let prediction = &mut ctx.accounts.prediction;
    prediction.ciphertext = encrypted.ciphertexts[0];
    prediction.nonce = encrypted.nonce;
    prediction.encrypted = true;

    emit!(PredictionStored {
        prediction: prediction.key(),
        market: prediction.market,
        user: prediction.user,
    });
    Ok(())
}

#[event]
pub struct PredictionStored {
    pub prediction: Pubkey,
    pub market: Pubkey,
    pub user: Pubkey,
}
