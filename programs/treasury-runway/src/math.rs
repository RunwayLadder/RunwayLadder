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

/// How the treasurer divides the amount between rungs.
///
/// A mirror of `Distribution` from `packages/math/src/ladder.ts`, and the even
/// split is just as much a separate variant here, not sugar over the weights
/// `[10000 / n, ...]`: for `n` that does not divide 10000 (3, 6, 7) such integer weights
/// do not exist, and a round-trip through bps would give a split that is called even
/// but is not. The dashboard shows the treasurer the preview with exactly that code, so a
/// discrepancy here is a different amount on screen and on chain.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum Distribution {
    Even { rungs: u8 },
    Weighted { weights_bps: Vec<u16> },
}

impl Distribution {
    pub fn rungs(&self) -> usize {
        match self {
            Distribution::Even { rungs } => usize::from(*rungs),
            Distribution::Weighted { weights_bps } => weights_bps.len(),
        }
    }
}

/// Splitting the ladder amount across rungs.
///
/// Invariant: `sum(parts) == total` for any input. The division remainder is neither
/// dropped nor duplicated — the ladder has no right to promise an amount other than the one
/// it accepted. It is handed out one unit at a time from the first rung; the choice is arbitrary
/// but fixed in `fixtures/vectors.json`, because the same layout is computed
/// twice — here and in TypeScript.
///
/// There is deliberately no minimum rung size here: it is a market parameter, not a
/// property of the arithmetic. On a tiny amount the function honestly returns zeros, which is
/// exactly why FR-006 checks the minimum **after** the split but **before** the debit.
pub fn split(total: u64, distribution: &Distribution) -> Result<Vec<u64>> {
    let mut parts = match distribution {
        Distribution::Even { rungs } => {
            let rungs = usize::from(*rungs);
            require!(rungs >= 1, LadderError::InvalidDistribution);

            vec![total / rungs as u64; rungs]
        }
        Distribution::Weighted { weights_bps } => {
            require!(!weights_bps.is_empty(), LadderError::InvalidDistribution);

            let mut sum: u128 = 0;
            for weight in weights_bps {
                // A rung without funds must not exist: a zero weight is
                // a request to create an account that promises nothing and to pay
                // rent for it.
                require!(*weight > 0, LadderError::InvalidDistribution);
                sum += u128::from(*weight);
            }
            // Weights must add up to the whole: normalisation would add a second rounding
            // where the first one already costs units.
            require!(sum == BPS_DENOMINATOR, LadderError::InvalidDistribution);

            weights_bps
                .iter()
                .map(|weight| {
                    let part = u128::from(total)
                        .checked_mul(u128::from(*weight))
                        .ok_or(LadderError::MathOverflow)?
                        / BPS_DENOMINATOR;

                    u64::try_from(part).map_err(|_| LadderError::MathOverflow.into())
                })
                .collect::<Result<Vec<u64>>>()?
        }
    };

    // Each division rounds down and loses less than one unit, so the remainder is always smaller
    // than the number of rungs and is handed out exactly one unit each.
    let mut remainder = parts.iter().try_fold(total, |left, part| left.checked_sub(*part))
        .ok_or(LadderError::MathOverflow)?;

    for part in parts.iter_mut() {
        if remainder == 0 {
            break;
        }
        *part = part.checked_add(1).ok_or(LadderError::MathOverflow)?;
        remainder -= 1;
    }

    Ok(parts)
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

    #[test]
    fn split_matches_the_shared_even_vectors() {
        for case in vectors()["split"]["even_cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let rungs = case["rungs"].as_u64().unwrap() as u8;
            let parts = split(u64_field(case, "total"), &Distribution::Even { rungs })
                .unwrap_or_else(|_| panic!("{name}"));

            let expected: Vec<u64> = case["parts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p.as_str().unwrap().parse().unwrap())
                .collect();

            assert_eq!(parts, expected, "{name}");
        }
    }

    #[test]
    fn split_matches_the_shared_weighted_vectors() {
        for case in vectors()["split"]["weighted_cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let weights_bps: Vec<u16> = case["weights_bps"]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| w.as_u64().unwrap() as u16)
                .collect();

            let parts = split(u64_field(case, "total"), &Distribution::Weighted { weights_bps })
                .unwrap_or_else(|_| panic!("{name}"));

            let expected: Vec<u64> = case["parts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p.as_str().unwrap().parse().unwrap())
                .collect();

            assert_eq!(parts, expected, "{name}");
        }
    }

    #[test]
    fn split_never_creates_or_loses_a_unit() {
        for total in [0u64, 1, 3, 999, 1_000_000_000, 1_000_000_000_000_001] {
            for rungs in 1u8..=12 {
                let parts = split(total, &Distribution::Even { rungs }).unwrap();
                assert_eq!(parts.iter().sum::<u64>(), total, "total={total} rungs={rungs}");
                assert_eq!(parts.len(), usize::from(rungs));
            }
        }
    }

    #[test]
    fn split_keeps_the_rungs_within_one_unit_of_each_other() {
        // The even split stays as even as integers allow: otherwise
        // "equal rungs" on screen would be unequal by
        // more than a speck.
        let parts = split(1_000_000_000_000_007, &Distribution::Even { rungs: 9 }).unwrap();
        let max = parts.iter().max().unwrap();
        let min = parts.iter().min().unwrap();

        assert!(max - min <= 1, "{parts:?}");
    }

    #[test]
    fn split_rejects_weights_that_do_not_add_up() {
        assert!(split(1_000, &Distribution::Weighted { weights_bps: vec![5_000, 4_000] }).is_err());
        assert!(split(1_000, &Distribution::Weighted { weights_bps: vec![6_000, 5_000] }).is_err());
    }

    #[test]
    fn split_rejects_a_rung_with_no_weight() {
        assert!(split(1_000, &Distribution::Weighted { weights_bps: vec![10_000, 0] }).is_err());
    }

    #[test]
    fn split_rejects_a_ladder_without_rungs() {
        assert!(split(1_000, &Distribution::Even { rungs: 0 }).is_err());
        assert!(split(1_000, &Distribution::Weighted { weights_bps: vec![] }).is_err());
    }
}
