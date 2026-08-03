use anchor_lang::prelude::*;

use crate::errors::LadderError;

/// Duplicated from `packages/math/src/constants.ts` and `fixtures/vectors.json`.
/// The test below checks all three copies — a discrepancy in a constant means the dashboard
/// shows the treasurer an amount other than the one the program will pay.
pub const BPS_DENOMINATOR: u128 = 10_000;
pub const SECONDS_PER_YEAR: u128 = 31_536_000;

pub struct FeeSplit {
    /// What the protocol keeps — it also fills the buffer, the second step of the waterfall.
    pub fee: u64,
    /// What actually goes to work and what the promise is computed on.
    pub working: u64,
}

/// Rounds down: the protocol never takes more than the exact value. Together with
/// `working = amount - fee` this gives the invariant "the sum of the parts equals the input amount".
pub fn fee(amount: u64, fee_bps: u16) -> Result<FeeSplit> {
    require!(u128::from(fee_bps) <= BPS_DENOMINATOR, LadderError::InvalidFeeBps);

    let taken = u128::from(amount)
        .checked_mul(u128::from(fee_bps))
        .ok_or(LadderError::MathOverflow)?
        / BPS_DENOMINATOR;

    let taken = u64::try_from(taken).map_err(|_| LadderError::MathOverflow)?;

    Ok(FeeSplit {
        fee: taken,
        working: amount.checked_sub(taken).ok_or(LadderError::MathOverflow)?,
    })
}

/// The rung's promise: how much the treasury receives on the maturity date for `working`
/// placed at `rate_bps` per annum for `seconds`.
///
/// Rounding down is deliberate: rounding up would create money that does not exist, precisely
/// where the product promises certainty.
pub fn promise(working: u64, rate_bps: u16, seconds: i64) -> Result<u64> {
    let seconds = u128::try_from(seconds).map_err(|_| LadderError::InvalidMaturity)?;

    let accrued = u128::from(working)
        .checked_mul(u128::from(rate_bps))
        .ok_or(LadderError::MathOverflow)?
        .checked_mul(seconds)
        .ok_or(LadderError::MathOverflow)?
        / (BPS_DENOMINATOR * SECONDS_PER_YEAR);

    let accrued = u64::try_from(accrued).map_err(|_| LadderError::MathOverflow)?;

    working.checked_add(accrued).ok_or(LadderError::MathOverflow.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::Value;

    fn vectors() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/vectors.json");
        let raw = std::fs::read_to_string(path).expect("fixtures/vectors.json");
        serde_json::from_str(&raw).expect("valid json")
    }

    fn u64_field(case: &Value, key: &str) -> u64 {
        case[key].as_str().expect(key).parse().expect(key)
    }

    #[test]
    fn constants_match_the_fixture() {
        let v = vectors();
        assert_eq!(v["constants"]["bps_denominator"].as_u64().unwrap() as u128, BPS_DENOMINATOR);
        assert_eq!(v["constants"]["seconds_per_year"].as_u64().unwrap() as u128, SECONDS_PER_YEAR);
    }

    #[test]
    fn fee_matches_the_shared_vectors() {
        for case in vectors()["fee"]["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let split = fee(u64_field(case, "amount"), case["fee_bps"].as_u64().unwrap() as u16)
                .unwrap_or_else(|_| panic!("{name}"));

            assert_eq!(split.fee, u64_field(case, "fee"), "{name}: fee");
            assert_eq!(split.working, u64_field(case, "working"), "{name}: working");
        }
    }

    #[test]
    fn promise_matches_the_shared_vectors() {
        for case in vectors()["promise"]["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let got = promise(
                u64_field(case, "working"),
                case["rate_bps"].as_u64().unwrap() as u16,
                case["seconds"].as_i64().unwrap(),
            )
            .unwrap_or_else(|_| panic!("{name}"));

            assert_eq!(got, u64_field(case, "promised"), "{name}");
        }
    }

    #[test]
    fn fee_splits_without_creating_or_losing_a_unit() {
        for amount in [0u64, 1, 999, 1_000_000_000, 1_000_000_000_000_000] {
            for bps in [0u16, 1, 25, 9_999, 10_000] {
                let split = fee(amount, bps).unwrap();
                assert_eq!(split.fee + split.working, amount, "amount={amount} bps={bps}");
            }
        }
    }

    #[test]
    fn fee_above_the_whole_amount_is_rejected() {
        assert!(fee(1_000, 10_001).is_err());
    }

    #[test]
    fn promise_never_returns_less_than_the_principal() {
        for rate_bps in [0u16, 1, 500, 10_000] {
            for seconds in [0i64, 1, 86_400, 31_536_000] {
                assert!(promise(1_000_000_000, rate_bps, seconds).unwrap() >= 1_000_000_000);
            }
        }
    }

    #[test]
    fn promise_rejects_time_before_the_epoch() {
        assert!(promise(1_000_000_000, 800, -1).is_err());
    }

    #[test]
    fn promise_reports_overflow_instead_of_wrapping() {
        assert!(promise(u64::MAX, 10_000, 31_536_000).is_err());
    }
}
