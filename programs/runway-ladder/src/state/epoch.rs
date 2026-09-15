use anchor_lang::prelude::*;

use crate::errors::LadderError;
use crate::state::Market;

/// A maturity epoch: one date and one rate for everyone who enters it.
///
/// The rate has no instruction that overwrites it — none. The invariant "a promise cannot
/// change after issuance" is held by the absence of a path, not by checking a flag:
/// to change the terms one would have to create another epoch, while rungs stay
/// bound to their own.
#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub market: Pubkey,
    pub maturity_ts: i64,
    pub rate_bps: u16,
    /// FR-010a: the operator is a conscious point of trust, so exactly who set
    /// the rate and when lives in the account, not only in the transaction logs.
    pub created_by: Pubkey,
    pub created_at: i64,
    /// The amount that actually went to work across the whole epoch (after fees).
    pub total_deposited: u64,
    /// The sum of promises across the whole epoch. Together with the funds available on the
    /// maturity date it gives the payout ratio — one per epoch, not per rung.
    pub total_promised: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(maturity_ts: i64)]
pub struct CreateEpoch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority @ LadderError::NotMarketAuthority)]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = authority,
        space = 8 + Epoch::INIT_SPACE,
        seeds = [b"epoch", market.key().as_ref(), &maturity_ts.to_le_bytes()],
        bump,
    )]
    pub epoch: Account<'info, Epoch>,

    pub system_program: Program<'info, System>,
}

pub fn create_epoch(ctx: Context<CreateEpoch>, maturity_ts: i64, rate_bps: u16) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(maturity_ts > now, LadderError::InvalidMaturity);

    let epoch = &mut ctx.accounts.epoch;
    epoch.market = ctx.accounts.market.key();
    epoch.maturity_ts = maturity_ts;
    epoch.rate_bps = rate_bps;
    epoch.created_by = ctx.accounts.authority.key();
    epoch.created_at = now;
    epoch.total_deposited = 0;
    epoch.total_promised = 0;
    epoch.bump = ctx.bumps.epoch;

    Ok(())
}
