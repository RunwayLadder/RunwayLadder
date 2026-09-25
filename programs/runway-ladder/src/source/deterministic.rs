use anchor_lang::prelude::*;

use crate::errors::LadderError;
use crate::math::{BPS_DENOMINATOR, SECONDS_PER_YEAR};

/// A source with a fixed rate: funds stay in the market vault, and the yield
/// is accrued by formula. Not for production but for two things without which
/// the project cannot be shown: reproducible runs and devnet, where third-party protocols
/// do not exist at all.
///
/// The formula is deliberately the accrual term of `math::promise`, with `principal × seconds`
/// already summed into `deposit_seconds`. The difference between the epoch rate and the source
/// rate is precisely the yield side's profit or loss, and it must be the difference of two
/// identical computations, not two similar ones — `is_the_promise_accrual_for_a_single_deposit`
/// below is what holds the two together.
///
/// One rounding note that belongs in the caller's head, not only here: this divides **once**,
/// after the sum, while `promise` divides per rung. Since `Σ floor(x) ≤ floor(Σ x)`, an epoch's
/// accrual computed here is never smaller than the sum of its rungs' accruals, and can exceed it
/// by up to one unit per rung. The direction is deliberate — the dust stays with the treasury.
pub fn accrued(rate_bps: u16, deposit_seconds: u128) -> Result<u64> {
    let accrued = deposit_seconds
        .checked_mul(u128::from(rate_bps))
        .ok_or(LadderError::MathOverflow)?
        / (BPS_DENOMINATOR * SECONDS_PER_YEAR);

    u64::try_from(accrued).map_err(|_| LadderError::MathOverflow.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::promise;

    const DAY: i64 = 86_400;

    /// What `ladder_deposit` accumulates for one rung.
    fn deposit_seconds(principal: u64, elapsed: i64) -> u128 {
        u128::from(principal) * u128::try_from(elapsed).unwrap()
    }

    #[test]
    fn accrues_nothing_before_any_time_has_passed() {
        assert_eq!(accrued(800, deposit_seconds(1_000_000_000, 0)).unwrap(), 0);
    }

    #[test]
    fn accrues_nothing_at_a_zero_rate() {
        assert_eq!(accrued(0, deposit_seconds(1_000_000_000, 365 * DAY)).unwrap(), 0);
    }

    /// The bridge between the two forms: for a single deposit the aggregate must be exactly the
    /// promise minus the principal. Without this the epoch-level formula would be a second,
    /// similar computation rather than the same one.
    #[test]
    fn is_the_promise_accrual_for_a_single_deposit() {
        for (rate_bps, elapsed) in [(500u16, 30 * DAY), (800, 90 * DAY), (1_200, 365 * DAY)] {
            let principal = 997_500_000;
            assert_eq!(
                accrued(rate_bps, deposit_seconds(principal, elapsed)).unwrap(),
                promise(principal, rate_bps, elapsed).unwrap() - principal,
            );
        }
    }

    /// The dust, asserted rather than described: summing first and dividing once can only round
    /// up relative to dividing per rung, and never by as much as one unit per rung.
    #[test]
    fn the_epoch_aggregate_is_never_below_the_sum_of_its_rungs() {
        let rate_bps = 777;
        // Deliberately awkward amounts and spans: round numbers divide exactly and would hide
        // the very rounding this test is about.
        let rungs = [(333_333_333u64, 31 * DAY), (777_777_777, 97 * DAY), (1, 1)];

        let per_rung: u64 = rungs
            .iter()
            .map(|(p, t)| promise(*p, rate_bps, *t).unwrap() - p)
            .sum();
        let total: u128 = rungs.iter().map(|(p, t)| deposit_seconds(*p, *t)).sum();
        let aggregate = accrued(rate_bps, total).unwrap();

        assert!(aggregate >= per_rung, "{aggregate} < {per_rung}");
        assert!(aggregate - per_rung < rungs.len() as u64, "dust exceeds one unit per rung");
    }

    #[test]
    fn reports_overflow_instead_of_wrapping() {
        assert!(accrued(10_000, u128::MAX).is_err());
    }

    /// `deposit_seconds` is unsigned, so "time running backwards" is unrepresentable here
    /// rather than rejected. The check that a maturity lies ahead stays where the seconds are
    /// produced — `create_epoch` and `ladder_deposit`.
    #[test]
    fn a_zero_span_accrues_nothing_whatever_the_rate() {
        for rate_bps in [0u16, 1, 10_000] {
            assert_eq!(accrued(rate_bps, 0).unwrap(), 0);
        }
    }
}
