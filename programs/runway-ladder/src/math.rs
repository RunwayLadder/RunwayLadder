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
    let mut remainder = parts
        .iter()
        .try_fold(total, |left, part| left.checked_sub(*part))
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

/// What the epoch holds on its maturity date, before anyone is paid.
///
/// A struct rather than three `u64` arguments: swapping `realized` and `buffer` at a call site
/// would still compile and would still settle — just on the wrong numbers.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct EpochMaturity {
    /// The sum of promises across the epoch — `Epoch.total_promised`.
    pub promised: u64,
    /// What the yield source actually returned: the principal that went to work plus the income
    /// it accrued. A source that lost principal simply returns less than it took, so covering a
    /// shortfall does not depend on the principal being intact.
    pub realized: u64,
    /// The protocol buffer: the only thing standing between a shortfall and the treasury's
    /// principal. Filled by fees (FR-023) and by the surplus of epochs that came in above their
    /// promise (FR-011b).
    pub buffer: u64,
}

/// The epoch's settlement — computed once, then applied to every rung with [`payout`].
///
/// Two variants instead of a `deficit` field next to `paid`: a deficit that is not marked must be
/// unrepresentable, and `Settled { paid < promised }` is exactly the state that must not exist.
/// `SettledWithDeficit` carries the deficit because it is never zero there; `Settled` carries the
/// surplus because the deficit is always zero there. A mirror of `Settlement` from
/// `packages/math/src/waterfall.ts`; `Epoch.status` mirrors the same split on chain in T036.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Settlement {
    Settled {
        promised: u64,
        /// Equals `promised`.
        paid: u64,
        /// What is left above the promise — it goes to the protocol buffer (FR-011b).
        surplus: u64,
        from_buffer: u64,
    },
    SettledWithDeficit {
        promised: u64,
        /// Strictly less than `promised`.
        paid: u64,
        /// `promised - paid`, never zero.
        deficit: u64,
        /// Equals the whole buffer: the haircut comes only after it is drained.
        from_buffer: u64,
    },
}

impl Settlement {
    /// There are accessors only for the three fields both variants carry. `surplus` and `deficit`
    /// deliberately have none: they are the numbers that say which variant this is, and reading
    /// one of them without seeing the status is the mistake the split exists to prevent.
    pub fn promised(&self) -> u64 {
        match self {
            Settlement::Settled { promised, .. }
            | Settlement::SettledWithDeficit { promised, .. } => *promised,
        }
    }

    pub fn paid(&self) -> u64 {
        match self {
            Settlement::Settled { paid, .. } | Settlement::SettledWithDeficit { paid, .. } => *paid,
        }
    }

    pub fn from_buffer(&self) -> u64 {
        match self {
            Settlement::Settled { from_buffer, .. }
            | Settlement::SettledWithDeficit { from_buffer, .. } => *from_buffer,
        }
    }
}

/// Covering a shortfall: the protocol buffer, then a pro-rata haircut (FR-011). The only
/// implementation of the order on chain, mirrored one-to-one by `waterfall()` in
/// `packages/math/src/waterfall.ts` on the vectors in `fixtures/vectors.json`.
///
/// The order is what makes the promise a promise. The buffer is the protocol's own money and it
/// goes first; the treasury takes a haircut only when the buffer is gone — and the haircut is a
/// separate variant, never a smaller number under the same label.
///
/// **There is no yield-pool step, and this is a decision rather than an omission (2026-09-25).**
/// A three-step order once put "the yield owners' income" ahead of the buffer, but that income is
/// already inside `realized`: by the time `realized < promised` the yield side has received
/// nothing, so the step could only ever draw zero. Money above `realized` would have to come from
/// a third party underwriting the epoch, and the product has no such party — see `docs/SPEC.md`,
/// FR-011.
///
/// Money is never created: `realized + from_buffer == paid + surplus` holds exactly, and the
/// buffer step draws at most what the buffer holds.
pub fn waterfall(epoch: EpochMaturity) -> Result<Settlement> {
    let EpochMaturity { promised, realized, buffer } = epoch;

    if realized >= promised {
        return Ok(Settlement::Settled {
            promised,
            paid: promised,
            surplus: realized.checked_sub(promised).ok_or(LadderError::MathOverflow)?,
            from_buffer: 0,
        });
    }

    let mut shortfall = promised.checked_sub(realized).ok_or(LadderError::MathOverflow)?;

    let from_buffer = shortfall.min(buffer);
    shortfall = shortfall.checked_sub(from_buffer).ok_or(LadderError::MathOverflow)?;

    if shortfall == 0 {
        return Ok(Settlement::Settled { promised, paid: promised, surplus: 0, from_buffer });
    }

    Ok(Settlement::SettledWithDeficit {
        promised,
        paid: promised.checked_sub(shortfall).ok_or(LadderError::MathOverflow)?,
        deficit: shortfall,
        from_buffer,
    })
}

/// What one rung receives out of the epoch's settlement: its promise scaled by `paid / promised`.
/// One ratio for the whole epoch, so a rung is paid the same whether it is redeemed first or last
/// — a per-rung haircut would favour whoever came first.
///
/// Rounds down, so the sum over the rungs never exceeds `paid`: rounding leaves dust in the vault
/// rather than creating a unit that is not there. Under a deficit every rung with a non-zero
/// promise receives strictly less than it — the deficit is not lost in rounding.
pub fn payout(rung_promised: u64, settlement: &Settlement) -> Result<u64> {
    require!(
        rung_promised <= settlement.promised(),
        LadderError::RungExceedsEpochPromise
    );

    match settlement {
        // Not just a shortcut: an empty epoch has `promised == 0`, and dividing by it would be the
        // only way this function could fail. At par there is nothing to scale.
        Settlement::Settled { .. } => Ok(rung_promised),
        // `promised` is above zero here by construction: the deficit is never zero and never
        // exceeds `promised`, so the division below has no zero case to guard.
        Settlement::SettledWithDeficit { promised, paid, .. } => {
            let scaled = u128::from(rung_promised)
                .checked_mul(u128::from(*paid))
                .ok_or(LadderError::MathOverflow)?
                / u128::from(*promised);

            u64::try_from(scaled).map_err(|_| LadderError::MathOverflow.into())
        }
    }
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

    fn settlement_of(paid: u64, promised: u64) -> Settlement {
        if paid == promised {
            Settlement::Settled { promised, paid, surplus: 0, from_buffer: 0 }
        } else {
            Settlement::SettledWithDeficit {
                promised,
                paid,
                deficit: promised - paid,
                from_buffer: 0,
            }
        }
    }

    /// The grid the sweeps below run over: every combination of an epoch's three sums. The
    /// TypeScript side walks 400 simulated rate trajectories (SC-004); replicating its seeded
    /// generator here would only reproduce the generator, so this side takes the other approach
    /// and covers the ends instead — `u64::MAX` is where a mirror that forgot `u128` in `payout`
    /// stops agreeing with it.
    ///
    /// `BUFFER` carries the values that used to be split across two axes, so the grid keeps
    /// reaching the same boundaries with one dimension fewer: 180 epochs instead of 480.
    fn sweep() -> Vec<EpochMaturity> {
        const PROMISED: [u64; 5] = [0, 3, 1_000, 1_030_000_000, u64::MAX];
        const REALIZED: [u64; 6] = [0, 1, 999, 1_000, 1_020_000_000, u64::MAX];
        const BUFFER: [u64; 6] = [0, 1, 2_000_000, 5_000_000, 999_999_999, u64::MAX];

        let mut epochs =
            Vec::with_capacity(PROMISED.len() * REALIZED.len() * BUFFER.len());
        for promised in PROMISED {
            for realized in REALIZED {
                for buffer in BUFFER {
                    epochs.push(EpochMaturity { promised, realized, buffer });
                }
            }
        }
        epochs
    }

    fn surplus_and_deficit(settlement: &Settlement) -> (u64, u64) {
        match settlement {
            Settlement::Settled { surplus, .. } => (*surplus, 0),
            Settlement::SettledWithDeficit { deficit, .. } => (0, *deficit),
        }
    }

    #[test]
    fn waterfall_matches_the_shared_vectors() {
        for case in vectors()["waterfall"]["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let settlement = waterfall(EpochMaturity {
                promised: u64_field(case, "promised"),
                realized: u64_field(case, "realized"),
                buffer: u64_field(case, "buffer"),
            })
            .unwrap_or_else(|_| panic!("{name}"));

            assert_eq!(settlement.paid(), u64_field(case, "paid"), "{name}: paid");
            assert_eq!(
                settlement.from_buffer(),
                u64_field(case, "from_buffer"),
                "{name}: from the buffer"
            );

            let (surplus, deficit) = surplus_and_deficit(&settlement);
            assert_eq!(surplus, u64_field(case, "surplus"), "{name}: surplus");
            assert_eq!(deficit, u64_field(case, "deficit"), "{name}: deficit");
        }
    }

    #[test]
    fn payout_matches_the_shared_vectors() {
        for case in vectors()["waterfall"]["payout"]["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let settlement = settlement_of(u64_field(case, "paid"), u64_field(case, "promised"));

            let got = payout(u64_field(case, "rung_promised"), &settlement)
                .unwrap_or_else(|_| panic!("{name}"));

            assert_eq!(got, u64_field(case, "payout"), "{name}");
        }
    }

    #[test]
    fn waterfall_reaches_every_branch_of_the_order() {
        let mut by_source = 0;
        let mut by_buffer = 0;
        let mut with_deficit = 0;
        let mut with_surplus = 0;

        for epoch in sweep() {
            match waterfall(epoch).unwrap() {
                Settlement::Settled { surplus, from_buffer, .. } => {
                    if surplus > 0 {
                        with_surplus += 1;
                    }
                    if from_buffer > 0 {
                        by_buffer += 1;
                    } else {
                        by_source += 1;
                    }
                }
                Settlement::SettledWithDeficit { .. } => with_deficit += 1,
            }
        }

        // A property asserted over an empty branch proves nothing, so the grid has to reach all
        // of them — and this test is what notices when it stops.
        for (branch, count) in [
            ("source", by_source),
            ("buffer", by_buffer),
            ("deficit", with_deficit),
            ("surplus", with_surplus),
        ] {
            assert!(count >= 20, "{branch}: only {count} of {} epochs", sweep().len());
        }
    }

    #[test]
    fn waterfall_never_creates_money_and_never_overdraws_the_buffer() {
        for epoch in sweep() {
            let settlement = waterfall(epoch).unwrap();
            let (surplus, _) = surplus_and_deficit(&settlement);

            assert!(settlement.paid() <= settlement.promised(), "{epoch:?}");
            assert!(settlement.from_buffer() <= epoch.buffer, "{epoch:?}");

            // Checked in u128: `realized` may already be `u64::MAX` before the buffer adds
            // anything.
            assert_eq!(
                u128::from(epoch.realized) + u128::from(settlement.from_buffer()),
                u128::from(settlement.paid()) + u128::from(surplus),
                "{epoch:?}"
            );
        }
    }

    #[test]
    fn waterfall_drains_the_buffer_before_the_haircut() {
        for epoch in sweep() {
            match waterfall(epoch).unwrap() {
                Settlement::Settled { promised, paid, surplus, from_buffer } => {
                    assert_eq!(paid, promised, "{epoch:?}");
                    // A surplus means the source covered the promise on its own.
                    if surplus > 0 {
                        assert_eq!(from_buffer, 0, "{epoch:?}");
                    }
                }
                Settlement::SettledWithDeficit { promised, paid, deficit, from_buffer } => {
                    // The haircut is last: the buffer is gone before the treasury loses a unit.
                    // With one step left, "buffer first" and "haircut last" are the same
                    // statement, and this is where it is asserted.
                    assert_eq!(from_buffer, epoch.buffer, "{epoch:?}");
                    assert!(paid < promised, "{epoch:?}");
                    assert_eq!(deficit, promised - paid, "{epoch:?}");
                    assert!(deficit > 0, "{epoch:?}");
                }
            }
        }
    }

    #[test]
    fn payout_pays_every_rung_at_par_or_strictly_less_across_the_sweep() {
        for epoch in sweep() {
            let settlement = waterfall(epoch).unwrap();

            for rungs in [1u8, 3, 5, 11] {
                let promises =
                    split(settlement.promised(), &Distribution::Even { rungs }).unwrap();
                let amounts: Vec<u64> =
                    promises.iter().map(|p| payout(*p, &settlement).unwrap()).collect();
                let total: u128 = amounts.iter().map(|a| u128::from(*a)).sum();

                assert!(total <= u128::from(settlement.paid()), "{epoch:?} rungs={rungs}");
                // Rounding leaves less than one unit per rung as dust — never more.
                assert!(
                    total + u128::from(rungs) > u128::from(settlement.paid()),
                    "{epoch:?} rungs={rungs}"
                );

                for (promised, amount) in promises.iter().zip(&amounts) {
                    match settlement {
                        Settlement::Settled { .. } => assert_eq!(amount, promised, "{epoch:?}"),
                        // A rung promised nothing receives nothing: there is no less than zero.
                        Settlement::SettledWithDeficit { .. } if *promised == 0 => {
                            assert_eq!(*amount, 0, "{epoch:?}")
                        }
                        Settlement::SettledWithDeficit { .. } => {
                            assert!(amount < promised, "{epoch:?} rungs={rungs}")
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn payout_rejects_a_rung_promised_more_than_its_whole_epoch() {
        assert!(payout(11, &settlement_of(10, 10)).is_err());
        assert!(payout(11, &settlement_of(9, 10)).is_err());
    }

    #[test]
    fn payout_pays_an_empty_epoch_nothing_without_dividing_by_zero() {
        assert_eq!(payout(0, &settlement_of(0, 0)).unwrap(), 0);
    }

    #[test]
    fn payout_uses_u128_for_the_product() {
        // `rung_promised * paid` leaves `u64` long before the division brings it back. Done in
        // `u64` this case would panic under `overflow-checks` instead of paying the rung.
        let settlement = settlement_of(u64::MAX - 1, u64::MAX);

        assert_eq!(payout(u64::MAX, &settlement).unwrap(), u64::MAX - 1);
        assert_eq!(payout(u64::MAX / 2, &settlement).unwrap(), u64::MAX / 2 - 1);
    }
}
