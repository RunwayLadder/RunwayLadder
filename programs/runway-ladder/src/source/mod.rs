use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::errors::LadderError;
use crate::state::{transfer_as_market, Epoch, Market, YieldSource};

pub mod deterministic;
pub mod kamino;

/// The yield source adapter boundary: everything the ladder core is allowed to know.
///
/// Two operations, `deposit` and `withdraw`, and nothing about how either is done. They arrived
/// with the second implementation (T046): while the deterministic source was the only one, the
/// boundary held only `accrued`, because with the principal staying in the vault both
/// operations would have been empty functions over an invented set of accounts. Kamino is what
/// gave them a shape that can be checked.
///
/// **The unit a source hands back is its own** (`shares`). Kamino issues kTokens, whose price in
/// the asset grows as the reserve earns; the deterministic source issues nothing and counts the
/// principal itself. The core adds the units up per epoch (`Epoch.source_shares`) and hands the
/// sum back once, at settlement — it never converts them, so it cannot get the conversion wrong.
///
/// **Income is what arrives, not what a formula says** (2026-09-27). `withdraw` returns the
/// amount that actually landed in the vault: for Kamino that is the redemption itself, for the
/// deterministic source the principal plus what its reserve could pay. The vault is shared by
/// every epoch of the market, so counting money no account contains would quietly pay one epoch
/// out of another's principal.
///
/// **The source's accounts travel in `remaining_accounts`**, after anything the instruction
/// itself puts there, and `Source::from_accounts` checks them against the market before any
/// of them is used. None for the deterministic source, the reserve route's nine for Kamino.
pub enum Source<'a, 'info> {
    Deterministic { rate_bps: u16 },
    Kamino(kamino::Kamino<'a, 'info>),
}

/// What a settlement got back from the source.
pub struct Withdrawal {
    /// What the source earned or owed the epoch: the formula for the deterministic source, the
    /// redemption above the principal for Kamino. Reported, never paid by itself.
    pub accrued: u64,
    /// Principal plus income, in tokens that are now in the vault.
    pub realized: u64,
}

impl<'a, 'info> Source<'a, 'info> {
    pub fn from_accounts(
        market: &Account<'info, Market>,
        accounts: &'a [AccountInfo<'info>],
    ) -> Result<Self> {
        match market.source {
            YieldSource::Deterministic { rate_bps } => {
                require!(accounts.is_empty(), LadderError::SourceAccountsMismatch);
                Ok(Source::Deterministic { rate_bps })
            }
            YieldSource::Kamino { reserve } => {
                Ok(Source::Kamino(kamino::Kamino::from_accounts(market, &reserve, accounts)?))
            }
        }
    }

    /// Puts `amount`, already in the vault, to work. Returns the units the source issued for it.
    pub fn deposit(
        &self,
        market: &Account<'info, Market>,
        vault: &Account<'info, TokenAccount>,
        token_program: &Program<'info, Token>,
        amount: u64,
    ) -> Result<u64> {
        match self {
            // The principal stays where it is; the unit is the asset itself.
            Source::Deterministic { .. } => Ok(amount),
            Source::Kamino(kamino) => kamino.deposit(market, vault, token_program, amount),
        }
    }

    /// Brings the epoch's principal and income into the vault. Called once, by `settle_epoch`.
    ///
    /// `source_reserve` is the deterministic source's income account. It stays a named account
    /// of `settle_epoch` rather than moving into `remaining_accounts`: it predates this
    /// boundary, and every client already passes it.
    pub fn withdraw(
        &self,
        market: &Account<'info, Market>,
        vault: &Account<'info, TokenAccount>,
        token_program: &Program<'info, Token>,
        source_reserve: &Account<'info, TokenAccount>,
        epoch: &Epoch,
    ) -> Result<Withdrawal> {
        match self {
            Source::Deterministic { rate_bps } => {
                let accrued = deterministic::accrued(*rate_bps, epoch.deposit_seconds)?;
                // The formula is a claim, the reserve is the money: an underfunded reserve
                // becomes an ordinary shortfall that the buffer and the haircut handle in the
                // open.
                let collected = accrued.min(source_reserve.amount);
                transfer_as_market(market, token_program, source_reserve, vault, collected)?;
                let realized = epoch
                    .total_deposited
                    .checked_add(collected)
                    .ok_or(LadderError::MathOverflow)?;
                Ok(Withdrawal { accrued, realized })
            }
            Source::Kamino(kamino) => {
                let realized = kamino.redeem(market, vault, token_program, epoch.source_shares)?;
                Ok(Withdrawal { accrued: realized.saturating_sub(epoch.total_deposited), realized })
            }
        }
    }
}

/// Creates whatever the market's source holds for it, from `init_market`.
pub fn init<'info>(
    market: &Account<'info, Market>,
    payer: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
) -> Result<()> {
    match market.source {
        YieldSource::Deterministic { .. } => {
            require!(accounts.is_empty(), LadderError::SourceAccountsMismatch);
            Ok(())
        }
        YieldSource::Kamino { reserve } => {
            kamino::init(market, &reserve, payer, token_program, system_program, accounts)
        }
    }
}
