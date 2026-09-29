use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::errors::LadderError;
use crate::events::{RungIssued, RungRolled};
use crate::math::{fee, promise};
use crate::state::{transfer_as_market, Epoch, Ladder, Market, RollPolicy, Rung, RungStatus};

/// Rolling one matured rung into a new rung at the end of the horizon (FR-013).
///
/// **Permissionless, and the destination is not a parameter.** The new rung's address follows
/// from the same ladder's seeds and its next number, the target epoch is fixed by the market, and
/// the only transfer is the issuance fee between the protocol's own accounts. A caller chooses
/// nothing but whether to pay the rent — so a stranger's crank can do exactly what the owner's
/// keeper would, and nothing else.
///
/// The funds do not move: the old rung's payout already sits in the vault, and it goes back to
/// work there under a new promise. Only the counters say which epoch it belongs to now.
#[derive(Accounts)]
pub struct RollRung<'info> {
    /// Whoever sends the crank. Pays the rent of the new rung and nothing else; who it is does
    /// not matter to the program.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub market: Box<Account<'info, Market>>,

    /// Mutable for `rung_count`. No `has_one = owner`: the owner does not sign here, and the
    /// policy on the ladder is the owner's standing permission.
    #[account(mut, has_one = market)]
    pub ladder: Box<Account<'info, Ladder>>,

    /// The epoch the rung matured in. Mutable for `redeemed`, which counts rolled funds exactly
    /// as it counts redeemed ones.
    #[account(mut, has_one = market)]
    pub epoch: Box<Account<'info, Epoch>>,

    #[account(
        mut,
        seeds = [b"rung", ladder.key().as_ref(), &rung.index.to_le_bytes()],
        bump = rung.bump,
        has_one = epoch,
    )]
    pub rung: Box<Account<'info, Rung>>,

    /// The market's furthest epoch — the crank chooses neither the date nor the rate.
    #[account(
        mut,
        has_one = market,
        constraint = target.maturity_ts == market.latest_maturity @ LadderError::RollTargetNotLatest,
    )]
    pub target: Box<Account<'info, Epoch>>,

    /// The ladder's next number, like any other rung it issues.
    #[account(
        init,
        payer = payer,
        space = 8 + Rung::INIT_SPACE,
        seeds = [b"rung", ladder.key().as_ref(), &ladder.rung_count.to_le_bytes()],
        bump,
    )]
    pub new_rung: Box<Account<'info, Rung>>,

    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    /// Where the issuance fee of the new rung goes — the only fee a roll takes (FR-024).
    #[account(mut, address = market.buffer_vault)]
    pub buffer_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn roll_rung(ctx: Context<RollRung>) -> Result<()> {
    require!(
        matches!(ctx.accounts.ladder.roll_policy, RollPolicy::Roll),
        LadderError::RollPolicyDisabled
    );
    require!(
        matches!(ctx.accounts.rung.status, RungStatus::Active),
        LadderError::RungNotActive
    );

    let now = Clock::get()?.unix_timestamp;
    // The furthest epoch has matured when the operator has not opened a later one. There is
    // nowhere to roll into, and the rung waits — or the owner redeems it.
    require!(ctx.accounts.target.maturity_ts > now, LadderError::EpochAlreadyMatured);

    // Exactly what a redemption would have paid, counted against the epoch the same way. Under a
    // deficit that is less than the promise, and the new rung is issued from it: there is no
    // money to top it up with, since the buffer is already spent by the time a deficit exists.
    let old_promised = ctx.accounts.rung.promised;
    let (amount, with_deficit) = ctx.accounts.epoch.take_payout(old_promised)?;

    // A rung too small to be worth its redemption fee is not issued by a roll either. The old
    // rung stays active, and the owner redeems it by hand.
    require!(amount > 0, LadderError::ZeroAmount);
    require!(amount >= ctx.accounts.market.min_rung_amount, LadderError::RungBelowMinimum);

    // The issuance fee, as on a deposit, and no other (FR-024).
    let split = fee(amount, ctx.accounts.market.fee_bps)?;
    let seconds = ctx.accounts.target.maturity_ts - now;
    let promised = promise(split.working, ctx.accounts.target.rate_bps, seconds)?;

    let ladder_key = ctx.accounts.ladder.key();
    let new_key = ctx.accounts.new_rung.key();
    let index = ctx.accounts.ladder.rung_count;

    ctx.accounts.target.record_issue(split.working, promised, seconds)?;
    ctx.accounts.ladder.rung_count = index.checked_add(1).ok_or(LadderError::MathOverflow)?;

    ctx.accounts.rung.status = if with_deficit {
        RungStatus::RolledWithDeficit { amount, promised: old_promised, into: new_key }
    } else {
        RungStatus::Rolled { amount, into: new_key }
    };

    let target_key = ctx.accounts.target.key();
    let new_rung = &mut ctx.accounts.new_rung;
    new_rung.ladder = ladder_key;
    new_rung.epoch = target_key;
    new_rung.index = index;
    new_rung.deposited = split.working;
    new_rung.promised = promised;
    new_rung.fee_paid = split.fee;
    new_rung.status = RungStatus::Active;
    new_rung.bump = ctx.bumps.new_rung;

    let a = &ctx.accounts;
    transfer_as_market(&a.market, &a.token_program, &a.vault, &a.buffer_vault, split.fee)?;

    emit!(RungRolled {
        ladder: ladder_key,
        rung: a.rung.key(),
        epoch: a.epoch.key(),
        into: new_key,
        promised: old_promised,
        amount,
        with_deficit,
        rolled_at: now,
    });
    emit!(RungIssued {
        ladder: ladder_key,
        rung: new_key,
        epoch: target_key,
        maturity_ts: a.target.maturity_ts,
        rate_bps: a.target.rate_bps,
        deposited: split.working,
        promised,
        fee_paid: split.fee,
    });

    Ok(())
}
