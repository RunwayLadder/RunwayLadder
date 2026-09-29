use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer};

use crate::errors::LadderError;
use crate::events::{LadderFunded, RungIssued, RungRedeemed};
use crate::math::{fee, promise, split, Distribution};
use crate::state::{transfer_as_market, Epoch, Ladder, Market};

/// What happened to the rung. A union rather than a sum of boolean flags: the variant
/// "redeemed for less than promised, unmarked" does not exist in the type, so a deficit cannot
/// become silent through a forgotten check (FR-011a).
///
/// The actual amount lives in the variant, not in a separate field, and this is a deliberate
/// departure from the table in `docs/PLAN.md`: a `settled_amount` field next to the status would
/// give exactly the representability the invariant forbids.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RungStatus {
    /// Funds at work, the maturity date ahead.
    Active,
    /// Redeemed for exactly the promised amount.
    Redeemed { amount: u64 },
    /// Redeemed for less than promised: carries both the actual and the promised amount so the
    /// difference is visible without reconciling against another account.
    RedeemedWithDeficit { amount: u64, promised: u64 },
    /// Early exit at a discounted value (FR-016).
    Exited { amount: u64 },
    /// Rolled by the crank into a new rung of the same ladder (FR-013): `amount` never left the
    /// protocol, it went to work again in `into`. Not a kind of `Redeemed` — the treasury received
    /// nothing, and a history that read it as a payout would count the same money twice.
    Rolled { amount: u64, into: Pubkey },
    /// Rolled after the epoch settled below its promise: the new rung was issued from what the
    /// rung actually received, and the shortfall stays visible here rather than disappearing into
    /// a fresh promise.
    RolledWithDeficit { amount: u64, promised: u64, into: Pubkey },
}

/// A rung: one date, one fixed promise.
///
/// `promised` is written once, at creation. An instruction that overwrites it does not
/// exist — and this is not a flag check but the absence of a path: to change the terms
/// one would have to create another rung.
///
/// The address is `["rung", ladder, index]`, not `["rung", ladder, epoch]`: a ladder may hold
/// several rungs in one epoch — a second deposit, or a roll into an epoch the ladder already
/// uses (FR-013). The tie to the epoch is the `epoch` field, checked with `has_one`.
#[account]
#[derive(InitSpace)]
pub struct Rung {
    pub ladder: Pubkey,
    pub epoch: Pubkey,
    /// The rung's number within its ladder — the ladder's `rung_count` at the moment the rung
    /// was issued. Kept in the account because it is part of the seeds: without it, an
    /// instruction taking this rung could not check its address.
    pub index: u32,
    /// How much actually went to work — the amount after the protocol fee.
    pub deposited: u64,
    /// How much the treasury receives on the maturity date. The same number the treasurer
    /// saw in the deposit preview (FR-007).
    pub promised: u64,
    pub fee_paid: u64,
    pub status: RungStatus,
    pub bump: u8,
}

/// Rungs arrive in `remaining_accounts` as "epoch, rung" pairs: their
/// count is the treasurer's choice, while `#[derive(Accounts)]` describes a fixed set.
/// The limit on how many pairs fit in one signature is measured by a separate test (T026).
#[derive(Accounts)]
pub struct LadderDeposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub market: Account<'info, Market>,

    /// `has_one = owner` is FR-020 itself: a foreign wallet sees the ladder but
    /// has no path to put funds into it. `has_one = market` is deliberately left on
    /// Anchor's built-in error: a mismatch here means a broken
    /// client, not a treasurer's decision, and it gets no wording of its own.
    #[account(mut, has_one = owner @ LadderError::NotLadderOwner, has_one = market)]
    pub ladder: Account<'info, Ladder>,

    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    /// The protocol buffer: the fee from the principal goes here (FR-023). It also stands
    /// as the second step of the waterfall, so the fee is not funds leaving the system
    /// but a top-up of what covers a shortfall.
    #[account(mut, address = market.buffer_vault)]
    pub buffer_vault: Account<'info, TokenAccount>,

    /// The wallet the funds leave from. It must belong to the ladder owner —
    /// otherwise the treasurer's signature would debit someone else's account.
    #[account(mut, token::mint = market.asset_mint, token::authority = owner)]
    pub source: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn ladder_deposit<'info>(
    ctx: Context<'_, '_, 'info, 'info, LadderDeposit<'info>>,
    amount: u64,
    distribution: Distribution,
) -> Result<()> {
    require!(amount > 0, LadderError::ZeroAmount);

    let rungs = distribution.rungs();
    require!(
        rungs > 0 && ctx.remaining_accounts.len() == rungs * 2,
        LadderError::RungAccountsMismatch
    );

    let parts = split(amount, &distribution)?;

    // All validation first, and only then the first movement of funds. The order here is
    // not style: the US1 scenario requires a rejected deposit to leave the treasury
    // balance untouched, not to roll back half of the transfers.
    for part in &parts {
        require!(*part >= ctx.accounts.market.min_rung_amount, LadderError::RungBelowMinimum);
    }

    let now = Clock::get()?.unix_timestamp;
    let ladder_key = ctx.accounts.ladder.key();
    let market_key = ctx.accounts.market.key();
    // The rungs of this deposit take the ladder's next numbers in order. A client that read
    // `rung_count` before someone else issued a rung here derives stale addresses and is
    // refused below, before any funds move.
    let first_index = ctx.accounts.ladder.rung_count;

    // The fee is computed from each rung's principal separately, not from the whole amount:
    // otherwise rounding down would happen once instead of n times, and the total withheld
    // would not match what is recorded in the rungs themselves (FR-022).
    let fees = parts
        .iter()
        .map(|part| Ok(fee(*part, ctx.accounts.market.fee_bps)?.fee))
        .collect::<Result<Vec<u64>>>()?;

    let withheld = fees
        .iter()
        .try_fold(0u64, |sum, f| sum.checked_add(*f))
        .ok_or(LadderError::MathOverflow)?;
    let working_total = amount.checked_sub(withheld).ok_or(LadderError::MathOverflow)?;

    // Two transfers, one signature: the treasurer sees both what went to work and what
    // was withheld as separate movements, without having to subtract one from the other.
    transfer_from_owner(&ctx, ctx.accounts.vault.to_account_info(), working_total)?;
    transfer_from_owner(&ctx, ctx.accounts.buffer_vault.to_account_info(), withheld)?;

    for (index, (part, fee_paid)) in parts.iter().zip(fees).enumerate() {
        let epoch_info = &ctx.remaining_accounts[index * 2];
        let rung_info = &ctx.remaining_accounts[index * 2 + 1];

        // `Account::try_from` checks the account owner and its discriminator:
        // slipping something other than an epoch in is not possible.
        let mut epoch: Account<Epoch> = Account::try_from(epoch_info)?;
        require_keys_eq!(epoch.market, market_key, LadderError::RungAccountsMismatch);
        require!(epoch.maturity_ts > now, LadderError::EpochAlreadyMatured);

        // The promise is computed from what really went to work, not from the
        // principal: otherwise the protocol would promise yield on funds it does not have.
        let working = part.checked_sub(fee_paid).ok_or(LadderError::MathOverflow)?;
        let seconds = epoch.maturity_ts - now;
        let promised = promise(working, epoch.rate_bps, seconds)?;

        let epoch_key = epoch.key();
        let rung_index = u32::try_from(index)
            .ok()
            .and_then(|offset| first_index.checked_add(offset))
            .ok_or(LadderError::MathOverflow)?;
        let index_bytes = rung_index.to_le_bytes();
        let seeds: &[&[u8]] = &[b"rung", ladder_key.as_ref(), &index_bytes];
        let (expected, bump) = Pubkey::find_program_address(seeds, &crate::ID);
        require_keys_eq!(rung_info.key(), expected, LadderError::RungAccountsMismatch);

        let space = 8 + Rung::INIT_SPACE;
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::CreateAccount {
                    from: ctx.accounts.owner.to_account_info(),
                    to: rung_info.clone(),
                },
                &[&[b"rung", ladder_key.as_ref(), &index_bytes, &[bump]]],
            ),
            Rent::get()?.minimum_balance(space),
            space as u64,
            &crate::ID,
        )?;

        let rung = Rung {
            ladder: ladder_key,
            epoch: epoch_key,
            index: rung_index,
            deposited: working,
            promised,
            fee_paid,
            status: RungStatus::Active,
            bump,
        };
        rung.try_serialize(&mut &mut rung_info.try_borrow_mut_data()?[..])?;

        emit!(RungIssued {
            ladder: ladder_key,
            rung: rung_info.key(),
            epoch: epoch_key,
            maturity_ts: epoch.maturity_ts,
            rate_bps: epoch.rate_bps,
            deposited: working,
            promised,
            fee_paid,
        });

        // Epoch accumulators: the payout ratio is computed once per epoch, and without
        // these sums there would be nothing to compute it from. `seconds` is positive — the
        // maturity was checked to lie ahead.
        epoch.record_issue(working, promised, seconds)?;
        epoch.exit(&crate::ID)?;
    }

    let ladder = &mut ctx.accounts.ladder;
    ladder.rung_count = ladder
        .rung_count
        .checked_add(u32::try_from(rungs).map_err(|_| LadderError::RungAccountsMismatch)?)
        .ok_or(LadderError::MathOverflow)?;

    emit!(LadderFunded {
        ladder: ladder_key,
        owner: ctx.accounts.owner.key(),
        amount,
        working_total,
        withheld,
        rungs: u32::try_from(rungs).map_err(|_| LadderError::RungAccountsMismatch)?,
    });

    Ok(())
}

/// A transfer from the treasurer's wallet under their own signature. Zero is skipped: a
/// zero transfer is compute spent on a record that changes nothing.
fn transfer_from_owner<'info>(
    ctx: &Context<'_, '_, 'info, 'info, LadderDeposit<'info>>,
    to: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    anchor_spl::token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source.to_account_info(),
                to,
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )
}

/// Redeeming one rung after its epoch has settled (FR-012): the promise at par, or the epoch's
/// ratio applied to it with the deficit marked in the rung's status — never a smaller number
/// under the same label (FR-011a).
///
/// **The owner signs, and the owner chooses the account.** The destination is any token
/// account of the market's asset whose authority is the ladder owner — the mirror of `source`
/// in `ladder_deposit`. A multisig safe as the owner redeems the same way, since the check reads
/// who the owner is, not what kind of account it is.
///
/// **The roll policy does not lock the owner out** (decision 2026-09-27). `RollPolicy::Roll`
/// is a permission for the permissionless crank, not a restriction on the owner; whichever of
/// the two comes first consumes the rung, once, and the other finds it no longer active.
#[derive(Accounts)]
pub struct RedeemRung<'info> {
    pub owner: Signer<'info>,

    pub market: Account<'info, Market>,

    #[account(has_one = owner @ LadderError::NotLadderOwner, has_one = market)]
    pub ladder: Account<'info, Ladder>,

    /// Mutable for `redeemed`: the running total that keeps the epoch's redemptions inside what
    /// it settled for.
    #[account(mut, has_one = market)]
    pub epoch: Account<'info, Epoch>,

    /// The seeds bind the rung to this ladder, `has_one` to this epoch: a rung of another ladder
    /// has a different address, and a rung of another epoch names that epoch. The epoch mismatch
    /// stays on Anchor's built-in error, like `has_one = market` above — it means a broken
    /// client, not an owner's decision.
    #[account(
        mut,
        seeds = [b"rung", ladder.key().as_ref(), &rung.index.to_le_bytes()],
        bump = rung.bump,
        has_one = epoch,
    )]
    pub rung: Account<'info, Rung>,

    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    /// Where the funds go. It must belong to the ladder owner — otherwise the owner's signature
    /// would send the treasury's money to someone else's account.
    #[account(mut, token::mint = market.asset_mint, token::authority = owner)]
    pub destination: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn redeem_rung(ctx: Context<RedeemRung>) -> Result<()> {
    require!(
        matches!(ctx.accounts.rung.status, RungStatus::Active),
        LadderError::RungNotActive
    );

    // One ratio for the whole epoch, read from its status: `EpochNotSettled` until the crank
    // has settled it, and the same numbers for every rung after that.
    let promised = ctx.accounts.rung.promised;
    let (amount, with_deficit) = ctx.accounts.epoch.take_payout(promised)?;

    // State first, then the funds: a failed transfer rolls the whole instruction back anyway,
    // and nothing below reads the fields written here.
    ctx.accounts.rung.status = if with_deficit {
        RungStatus::RedeemedWithDeficit { amount, promised }
    } else {
        RungStatus::Redeemed { amount }
    };

    let a = &ctx.accounts;
    transfer_as_market(&a.market, &a.token_program, &a.vault, &a.destination, amount)?;

    emit!(RungRedeemed {
        ladder: a.ladder.key(),
        rung: a.rung.key(),
        epoch: a.epoch.key(),
        destination: a.destination.key(),
        promised,
        amount,
        with_deficit,
        redeemed_at: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
