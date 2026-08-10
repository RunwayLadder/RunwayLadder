use anchor_lang::prelude::*;

use crate::math::promise;

/// A source with a fixed rate: funds stay in the market vault, and the yield
/// is accrued by formula. Not for production but for two things without which
/// the project cannot be shown: reproducible runs and devnet, where third-party protocols
/// do not exist at all.
///
/// The formula is deliberately the same one that computes the rung's promise. The difference
/// between the epoch rate and the source rate is precisely the yield side's profit or loss, and
/// it must be the difference of two identical computations, not two similar ones.
pub fn accrued(rate_bps: u16, principal: u64, elapsed: i64) -> Result<u64> {
    Ok(promise(principal, rate_bps, elapsed)? - principal)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400;

    #[test]
    fn accrues_nothing_before_any_time_has_passed() {
        assert_eq!(accrued(800, 1_000_000_000, 0).unwrap(), 0);
    }

    #[test]
    fn accrues_nothing_at_a_zero_rate() {
        assert_eq!(accrued(0, 1_000_000_000, 365 * DAY).unwrap(), 0);
    }

    #[test]
    fn is_exactly_the_promise_minus_the_principal() {
        for (rate_bps, elapsed) in [(500u16, 30 * DAY), (800, 90 * DAY), (1_200, 365 * DAY)] {
            let principal = 997_500_000;
            assert_eq!(
                accrued(rate_bps, principal, elapsed).unwrap(),
                promise(principal, rate_bps, elapsed).unwrap() - principal,
            );
        }
    }

    #[test]
    fn reports_overflow_instead_of_wrapping() {
        assert!(accrued(10_000, u64::MAX, 365 * DAY).is_err());
    }

    #[test]
    fn rejects_time_running_backwards() {
        assert!(accrued(800, 1_000_000_000, -1).is_err());
    }
}
