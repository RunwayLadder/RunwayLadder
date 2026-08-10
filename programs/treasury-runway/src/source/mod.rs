use anchor_lang::prelude::*;

use crate::state::YieldSource;

pub mod deterministic;

/// The yield source adapter boundary: everything the ladder core is allowed to know.
///
/// A deliberate narrowing of the original intent: for now the boundary holds **only
/// `accrued`**, without `deposit` and `withdraw`. The reason: with the deterministic source
/// funds go nowhere, they stay in the market vault, so both operations
/// would be empty functions with an invented set of accounts. Their shape cannot be
/// verified while there is no second implementation under the boundary; they will arrive
/// together with the Kamino adapter (T046), which really moves funds through CPI.
///
/// An interface designed for a single implementation is a guess, not an abstraction.
pub fn accrued(source: &YieldSource, principal: u64, elapsed: i64) -> Result<u64> {
    match source {
        YieldSource::Deterministic { rate_bps } => {
            deterministic::accrued(*rate_bps, principal, elapsed)
        }
    }
}
