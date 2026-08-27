use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer};

use crate::errors::LadderError;
use crate::math::{promise, split, Distribution};
use crate::state::{Epoch, Ladder, Market};

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
}

/// A rung: one date, one fixed promise.
///
/// `promised` is written once, at creation. An instruction that overwrites it does not
/// exist — and this is not a flag check but the absence of a path: to change the terms
/// one would have to create another rung in another epoch.
#[account]
#[derive(InitSpace)]
pub struct Rung {
    pub ladder: Pubkey,
    pub epoch: Pubkey,
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

    anchor_spl::token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    for (index, part) in parts.iter().enumerate() {
        let epoch_info = &ctx.remaining_accounts[index * 2];
        let rung_info = &ctx.remaining_accounts[index * 2 + 1];

        // `Account::try_from` checks the account owner and its discriminator:
        // slipping something other than an epoch in is not possible.
        let mut epoch: Account<Epoch> = Account::try_from(epoch_info)?;
        require_keys_eq!(epoch.market, market_key, LadderError::RungAccountsMismatch);
        require!(epoch.maturity_ts > now, LadderError::EpochAlreadyMatured);

        // The protocol fee arrives in T024: for now the whole rung amount goes
        // to work, and `fee_paid` honestly says that zero was withheld.
        let promised = promise(*part, epoch.rate_bps, epoch.maturity_ts - now)?;

        let epoch_key = epoch.key();
        let seeds: &[&[u8]] = &[b"rung", ladder_key.as_ref(), epoch_key.as_ref()];
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
                &[&[b"rung", ladder_key.as_ref(), epoch_key.as_ref(), &[bump]]],
            ),
            Rent::get()?.minimum_balance(space),
            space as u64,
            &crate::ID,
        )?;

        let rung = Rung {
            ladder: ladder_key,
            epoch: epoch_key,
            deposited: *part,
            promised,
            fee_paid: 0,
            status: RungStatus::Active,
            bump,
        };
        rung.try_serialize(&mut &mut rung_info.try_borrow_mut_data()?[..])?;

        // Epoch accumulators: the payout ratio is computed once per epoch, and without
        // these sums there would be nothing to compute it from.
        epoch.total_deposited =
            epoch.total_deposited.checked_add(*part).ok_or(LadderError::MathOverflow)?;
        epoch.total_promised =
            epoch.total_promised.checked_add(promised).ok_or(LadderError::MathOverflow)?;
        epoch.exit(&crate::ID)?;
    }

    let ladder = &mut ctx.accounts.ladder;
    ladder.rung_count = ladder
        .rung_count
        .checked_add(u32::try_from(rungs).map_err(|_| LadderError::RungAccountsMismatch)?)
        .ok_or(LadderError::MathOverflow)?;

    Ok(())
}
