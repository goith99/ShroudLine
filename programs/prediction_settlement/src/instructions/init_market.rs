use crate::constants::{MARKET_SEED, OUTCOME_UNRESOLVED, VAULT_SEED};
use crate::state::{Market, Vault};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(fixture_id: i64)]
pub struct InitMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, authority.key().as_ref(), &fixture_id.to_le_bytes()],
        bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    pub system_program: Program<'info, System>,
}

pub fn init_market_handler(
    ctx: Context<InitMarket>,
    fixture_id: i64,
    stake_amount: u64,
    is_knockout: bool,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.authority = ctx.accounts.authority.key();
    market.fixture_id = fixture_id;
    market.stake_amount = stake_amount;
    market.total_staked = 0;
    market.prediction_count = 0;
    market.resolved = false;
    market.outcome = OUTCOME_UNRESOLVED;
    market.is_knockout = is_knockout;
    market.needs_manual_review = false;
    market.bump = ctx.bumps.market;
    market.vault_bump = ctx.bumps.vault;

    let vault = &mut ctx.accounts.vault;
    vault.market = market.key();
    vault.bump = ctx.bumps.vault;

    msg!(
        "Market initialized for fixture {} (stake {} lamports)",
        fixture_id,
        stake_amount
    );
    Ok(())
}
