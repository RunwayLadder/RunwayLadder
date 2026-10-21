use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::errors::LadderError;
use crate::events::EpochSettled;
use crate::math::{payout, waterfall, EpochMaturity, PayoutRatio, Settlement};
use crate::source::Source;
use crate::state::{transfer_as_market, Market};

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
    /// The units the yield source issued for the epoch's principal, in the source's own terms:
    /// kTokens for Kamino, the principal itself for the deterministic source. Handed back to the
    /// source whole at settlement. The core adds these up and never converts them — what they
    /// are worth is known only once the source has paid them out.
    ///
    /// Per epoch, not per market: the market's kTokens sit in one account, but each epoch
    /// entered at its own moments, and the exchange rate has already weighed that — the kTokens
    /// a deposit bought are exactly its share of what the reserve has earned since.
    pub source_shares: u64,
    /// What its rungs have taken out of the vault so far. Never above `paid`: the vault is
    /// shared by every epoch of the market, so a redemption past it would not fail — it would
    /// pay out of another epoch's principal. The difference that remains once every rung is
    /// redeemed is the rounding dust, which stays with the treasury side of the vault.
    pub redeemed: u64,
    /// `Active` until the crank settles the epoch, then the payout ratio in union form.
    pub status: EpochStatus,
    pub bump: u8,
}

impl Epoch {
    /// The settlement as `payout` consumes it. `total_promised` is the denominator in both
    /// variants; the status only contributes `paid`, which is all it keeps.
    pub fn payout_ratio(&self) -> Result<PayoutRatio> {
        let paid = match self.status {
            EpochStatus::Active => return err!(LadderError::EpochNotSettled),
            EpochStatus::Settled { paid } | EpochStatus::SettledWithDeficit { paid, .. } => paid,
        };

        Ok(PayoutRatio { paid, promised: self.total_promised })
    }

    /// What one rung promised `promised` takes out of this settled epoch, counted against `paid`.
    /// Redemption and rolling both go through here, so whichever consumes the rung, the epoch's
    /// running total is the same and never passes what it settled for.
    ///
    /// Returns the amount and whether the epoch settled with a deficit.
    pub fn take_payout(&mut self, promised: u64) -> Result<(u64, bool)> {
        let ratio = self.payout_ratio()?;
        let amount = payout(promised, ratio)?;

        // `payout` rounds down, so the rungs of one epoch cannot add up past `paid`. The check is
        // here anyway because the vault would not stop it: it holds every epoch's money, and an
        // excess would be paid out of someone else's principal instead of failing.
        let redeemed = self.redeemed.checked_add(amount).ok_or(LadderError::MathOverflow)?;
        require!(redeemed <= ratio.paid, LadderError::EpochOverpaid);
        self.redeemed = redeemed;

        Ok((amount, matches!(self.status, EpochStatus::SettledWithDeficit { .. })))
    }

    /// Adds one freshly issued rung to the epoch's accumulators. `seconds` is the span from
    /// issuance to maturity the promise was computed over, and must be positive; `shares` is
    /// what the source issued for `working`.
    pub fn record_issue(
        &mut self,
        working: u64,
        promised: u64,
        seconds: i64,
        shares: u64,
    ) -> Result<()> {
        self.total_deposited =
            self.total_deposited.checked_add(working).ok_or(LadderError::MathOverflow)?;
        self.total_promised =
            self.total_promised.checked_add(promised).ok_or(LadderError::MathOverflow)?;

        // The same product the promise was computed from, kept instead of recomputed: it is the
        // one thing `settle_epoch` cannot reconstruct later, because by then the moment the rung
        // was issued is gone.
        let rung_seconds = u128::from(working)
            .checked_mul(u128::try_from(seconds).map_err(|_| LadderError::InvalidMaturity)?)
            .ok_or(LadderError::MathOverflow)?;
        self.deposit_seconds =
            self.deposit_seconds.checked_add(rung_seconds).ok_or(LadderError::MathOverflow)?;
        self.source_shares =
            self.source_shares.checked_add(shares).ok_or(LadderError::MathOverflow)?;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(maturity_ts: i64)]
pub struct CreateEpoch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Mutable for `latest_maturity`, which a new epoch may move forward.
    #[account(mut, has_one = authority @ LadderError::NotMarketAuthority)]
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
    epoch.source_shares = 0;
    epoch.redeemed = 0;
    epoch.status = EpochStatus::Active;
    epoch.bump = ctx.bumps.epoch;

    let market = &mut ctx.accounts.market;
    market.latest_maturity = market.latest_maturity.max(maturity_ts);

    Ok(())
}

/// Settling the epoch: one computation, one ratio, for everyone who entered it (FR-011).
///
/// **Permissionless and without a signer.** The instruction takes no destination and no amount,
/// and every transfer it makes runs between the protocol's own accounts — the source, the vault
/// and the buffer — so there is nothing for a caller to divert. The source's accounts, if it has
/// any, come in `remaining_accounts` and are checked against the market's pinned source. The same property
/// `roll_rung` relies on. The transaction fee payer is whoever sends it; the program does not
/// care who that is.
#[derive(Accounts)]
pub struct SettleEpoch<'info> {
    pub market: Account<'info, Market>,

    #[account(mut, has_one = market)]
    pub epoch: Account<'info, Epoch>,

    /// Where the epoch's principal sits, and where the source's income and the buffer's
    /// contribution land.
    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    /// The protocol buffer (FR-023). Its balance **is** the buffer in the waterfall — there is
    /// no mirrored field to drift out of step with it, and moving the drawn amount out of it
    /// here is what stops a second epoch from settling against money this one already used.
    #[account(mut, address = market.buffer_vault)]
    pub buffer_vault: Account<'info, TokenAccount>,

    /// The deterministic source's income, held as tokens. Checked by its seeds and not merely
    /// by its owner: the vault and the buffer are owned by the market too, and passing the
    /// vault here would count the epoch's own principal a second time as income. Every market
    /// has one; a Kamino market's simply stays empty.
    #[account(mut, seeds = [b"reserve", market.key().as_ref()], bump)]
    pub source_reserve: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    // remaining_accounts: the source's, see `source::Source`.
}

pub fn settle_epoch<'info>(ctx: Context<'_, '_, 'info, 'info, SettleEpoch<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    require!(ctx.accounts.epoch.maturity_ts <= now, LadderError::EpochNotMatured);
    require!(
        matches!(ctx.accounts.epoch.status, EpochStatus::Active),
        LadderError::EpochAlreadySettled
    );

    // The epoch's principal and income, brought into the vault — counted in tokens that
    // arrived, never by a formula alone. The vault is shared by every epoch of the market, so
    // counting income that never arrived would not fail here: it would quietly pay this epoch
    // out of another epoch's principal, and the last epoch to redeem would find the hole
    // unmarked. A source that delivers less becomes an ordinary shortfall, which the buffer and
    // then the haircut handle in the open.
    //
    // For the deterministic source the span ends at `maturity_ts`, already baked into
    // `deposit_seconds`, so a late crank changes nothing. Kamino earns until the redemption
    // itself; whatever a late crank adds goes to the buffer as surplus, since the promise does
    // not move — see `source::kamino`.
    let a = &ctx.accounts;
    let source = Source::from_accounts(&a.market, ctx.remaining_accounts)?;
    let withdrawal =
        source.withdraw(&a.market, &a.vault, &a.token_program, &a.source_reserve, &a.epoch)?;
    let realized = withdrawal.realized;

    // For the deterministic source, `total_promised` is a sum of per-rung `floor`s while
    // `accrued` divides once over the summed `deposit_seconds`, so `realized` can exceed the
    // rung-by-rung total by up to one unit per rung. The direction is chosen, not accidental:
    // the dust stays with the treasury.
    let settlement = waterfall(EpochMaturity {
        promised: ctx.accounts.epoch.total_promised,
        realized,
        buffer: ctx.accounts.buffer_vault.amount,
    })?;

    let surplus = match settlement {
        Settlement::Settled { surplus, .. } => surplus,
        Settlement::SettledWithDeficit { .. } => 0,
    };

    // The source's money had to arrive before the waterfall could be computed — what Kamino
    // returns is known only once it has returned it — so the order here is income, then the
    // waterfall, then the buffer. A failure anywhere still leaves every balance untouched: the
    // transaction is one unit. After these the vault holds exactly `paid` for this epoch on top
    // of what other epochs brought, which is what lets `redeem_rung` pay out of it without
    // reaching into anyone else's principal.
    transfer_as_market(&a.market, &a.token_program, &a.buffer_vault, &a.vault, settlement.from_buffer())?;
    // FR-011b: the surplus is the protocol's margin for carrying the rate risk.
    transfer_as_market(&a.market, &a.token_program, &a.vault, &a.buffer_vault, surplus)?;

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
        // apart from a promise that was too large in the first place — nor an underfunded
        // reserve from a source that simply paid less.
        accrued: withdrawal.accrued,
        realized,
        promised: epoch.total_promised,
        paid: settlement.paid(),
        from_buffer: settlement.from_buffer(),
        settled_at: now,
    });

    Ok(())
}
