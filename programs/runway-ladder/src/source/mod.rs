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
///
/// **The unit of time is `deposit_seconds`, not `(principal, elapsed)`** (2026-09-25). Deposits
/// into one epoch arrive at different moments, so a single `elapsed` for the epoch does not
/// exist; what does exist is the sum of `principal × elapsed` over its rungs, which
/// `Epoch.deposit_seconds` accumulates as the deposits happen. Asking for the pair instead
/// would force the caller to invent an average, and an average is where the amount on the
/// treasurer's screen starts drifting from the amount the program pays.
pub fn accrued(source: &YieldSource, deposit_seconds: u128) -> Result<u64> {
    match source {
        YieldSource::Deterministic { rate_bps } => deterministic::accrued(*rate_bps, deposit_seconds),
    }
}
