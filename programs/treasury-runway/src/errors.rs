use anchor_lang::prelude::*;

/// The wording here is read by the treasurer, not the developer: the error must say what
/// exactly happened to their money and what to do about it, not name an internal condition.
#[error_code]
pub enum LadderError {
    #[msg("Rung is below the minimum position size — reduce the number of rungs or increase the amount")]
    RungBelowMinimum,

    #[msg("Fee rate cannot exceed 100%")]
    InvalidFeeBps,

    #[msg("Maturity date must be in the future")]
    InvalidMaturity,

    #[msg("Epoch rate is already locked — it is not revised after the first rung is issued")]
    RateAlreadyLocked,

    #[msg("Epoch has not reached its maturity date yet")]
    EpochNotMatured,

    #[msg("Epoch has already been settled")]
    EpochAlreadySettled,

    #[msg("Epoch has not been settled yet — redemption becomes available after settlement")]
    EpochNotSettled,

    #[msg("Only the ladder owner can perform this operation")]
    NotLadderOwner,

    #[msg("Not enough liquidity for an early exit — the position was left untouched")]
    InsufficientExitLiquidity,

    #[msg("Rung has already been redeemed")]
    RungNotActive,

    #[msg("Rolling is disabled for this ladder")]
    RollPolicyDisabled,

    /// Not "just in case": in a product that sells certainty of the amount, a silent
    /// overflow is a wrong payout, not a crash.
    #[msg("Overflow in amount calculation")]
    MathOverflow,
}
