use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer};

use crate::errors::LadderError;
use crate::events::EpochSettled;
use crate::math::{waterfall, EpochMaturity, Settlement};
use crate::source;
use crate::state::Market;

/// What happened to the epoch as a whole. A union rather than a status flag beside a
/// `payout_ratio` field: the pair would make "settled below the promise, unmarked"
/// representable, which is the one state FR-011a forbids — the same reasoning that shaped
/// `RungStatus`, applied one level up.
///
/// The variants carry `paid` rather than a ratio. A ratio would have to be a fixed-point
/// number chosen here and re-derived at every redemption, while `paid` together with
/// `total_promised` **is** the ratio, exactly as `math::payout` consumes it — and it is the
/// number a treasurer can check against the vault without trusting our rounding.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum EpochStatus {
    /// Funds at work, the maturity date ahead. No ratio exists yet.
    Active,
    /// Settled at par: every rung receives exactly its promise.
    Settled { paid: u64 },
    /// Settled below the promise: each rung receives `promised × paid / total_promised`,
    /// and the shortfall is carried in the variant so it cannot be read without being seen.
    SettledWithDeficit { paid: u64, deficit: u64 },
}

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
    /// `Σ(principal × seconds to maturity)` over the epoch's rungs, accumulated as they are
    /// issued.
    ///
    /// The epoch has no single `elapsed` to hand the source adapter: deposits arrive at
    /// different moments and each rung earns over its own span. This one accumulator carries
    /// exactly the quantity the accrual formula is linear in, so settlement stays **one
    /// computation per epoch** instead of a walk over the rungs — which is the same bound
    /// that puts the payout ratio here rather than on each rung.
    ///
    /// `u128` because the product alone reaches `2^64` for large amounts over long spans.
    pub deposit_seconds: u128,
    /// `Active` until the crank settles the epoch, then the payout ratio in union form.
    pub status: EpochStatus,
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
    epoch.deposit_seconds = 0;
    epoch.status = EpochStatus::Active;
    epoch.bump = ctx.bumps.epoch;

    Ok(())
}

/// Settling the epoch: one computation, one ratio, for everyone who entered it (FR-011).
///
/// **Permissionless and without a signer.** The instruction takes no destination and no amount,
/// and the only funds it moves go from the protocol's own buffer into the protocol's own vault,
/// so there is nothing for a caller to divert — the same property `roll_rung` relies on. The
/// transaction fee payer is whoever sends it; the program does not care who that is.
#[derive(Accounts)]
pub struct SettleEpoch<'info> {
    pub market: Account<'info, Market>,

    #[account(mut, has_one = market)]
    pub epoch: Account<'info, Epoch>,

    /// Where the epoch's principal sits, and where the buffer's contribution lands.
    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    /// The protocol buffer (FR-023). Its balance **is** the buffer in the waterfall — there is
    /// no mirrored field to drift out of step with it, and moving the drawn amount out of it
    /// here is what stops a second epoch from settling against money this one already used.
    #[account(mut, address = market.buffer_vault)]
    pub buffer_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn settle_epoch(ctx: Context<SettleEpoch>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    require!(ctx.accounts.epoch.maturity_ts <= now, LadderError::EpochNotMatured);
    require!(
        matches!(ctx.accounts.epoch.status, EpochStatus::Active),
        LadderError::EpochAlreadySettled
    );

    // What the source returned for the whole epoch. The span ends at `maturity_ts`, which is
    // already baked into `deposit_seconds` — deliberately, because the crank is permissionless
    // and may arrive an hour or three days late. Accruing to `now` would let the moment someone
    // chose to send the transaction decide how much each rung is paid.
    let accrued = source::accrued(&ctx.accounts.market.source, ctx.accounts.epoch.deposit_seconds)?;
    let realized = ctx
        .accounts
        .epoch
        .total_deposited
        .checked_add(accrued)
        .ok_or(LadderError::MathOverflow)?;

    // `total_promised` is a sum of per-rung `floor`s while `accrued` divides once over the
    // summed `deposit_seconds`, so `realized` can exceed the rung-by-rung total by up to one
    // unit per rung. The direction is chosen, not accidental: the dust stays with the treasury.
    let settlement = waterfall(EpochMaturity {
        promised: ctx.accounts.epoch.total_promised,
        realized,
        buffer: ctx.accounts.buffer_vault.amount,
    })?;

    // Validation first, then the movement of funds — as in `ladder_deposit`. A settlement that
    // fails must leave the buffer untouched rather than half drawn.
    draw_from_buffer(&ctx, settlement.from_buffer())?;

    let epoch = &mut ctx.accounts.epoch;
    epoch.status = match settlement {
        Settlement::Settled { paid, .. } => EpochStatus::Settled { paid },
        Settlement::SettledWithDeficit { paid, deficit, .. } => {
            EpochStatus::SettledWithDeficit { paid, deficit }
        }
    };

    emit!(EpochSettled {
        epoch: epoch.key(),
        maturity_ts: epoch.maturity_ts,
        // Neither of these survives in the account, and without them a deficit cannot be told
        // apart from a promise that was too large in the first place.
        accrued,
        realized,
        promised: epoch.total_promised,
        paid: settlement.paid(),
        from_buffer: settlement.from_buffer(),
        settled_at: now,
    });

    Ok(())
}

/// The buffer's contribution, moved rather than merely recorded.
///
/// The protocol signs for its own vaults as the market PDA. A surplus does **not** travel the
/// other way, and the asymmetry is real rather than an oversight: under the deterministic
/// source the accrued income has never left the vault as tokens, so there is nothing to send
/// to the buffer yet. It is recorded in the epoch's status and becomes an actual transfer with
/// the Kamino adapter (T046), which withdraws real funds — see `docs/SPEC.md`, FR-011b.
fn draw_from_buffer(ctx: &Context<SettleEpoch>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    let market = &ctx.accounts.market;
    let asset_mint = market.asset_mint;
    let source_seed = market.source.seed();
    let seeds: &[&[u8]] = &[b"market", asset_mint.as_ref(), &source_seed, &[market.bump]];

    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buffer_vault.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}
