//! The protocol fee: how much is withheld, where it goes and what the promise is computed on.
//!
//! The deposit tests in `ladder_deposit.rs` deliberately run on a market without a fee —
//! they check the split. Here the market has a fee, and the question is different: do the
//! parts add up, and does the treasurer see the withheld amount as a separate movement (FR-022, FR-023).

use anchor_lang::prelude::Pubkey;
use anchor_lang::AccountDeserialize;
use mollusk_svm::result::{Check, InstructionResult};

use runway_ladder::math::Distribution;
use runway_ladder::state::{Epoch, RollPolicy, Rung, YieldSource};

mod common;
use common::{key, Env, NOW};

const DAY: i64 = 86_400;
const RATE_BPS: u16 = 800;
const DEPOSIT: u64 = 1_000_000_000;
/// 0.25% — the same rate as in the market fixture.
const FEE_BPS: u16 = 25;

/// A market with a fee, four epochs, an open ladder and a deposit of the whole amount.
fn deposit_with_fee(fee_bps: u16) -> (Env, Pubkey, Pubkey, [i64; 4], InstructionResult) {
    let owner = Pubkey::new_unique();
    let maturities = [NOW + 90 * DAY, NOW + 180 * DAY, NOW + 270 * DAY, NOW + 360 * DAY];

    let mut env = Env::new(YieldSource::Deterministic { rate_bps: 600 });
    env.fund(owner);

    let ladder = env.ladder(owner, 0);
    env.expect_created(ladder);
    for maturity in maturities {
        let epoch = env.epoch(maturity);
        env.expect_created(epoch);
        env.expect_created(env.rung(ladder, epoch));
    }
    let source = env.fund_tokens(owner, DEPOSIT);

    let success: &[Check] = &[Check::success()];
    let mut chain = vec![env.init_market(fee_bps)];
    for maturity in maturities {
        chain.push(env.create_epoch(env.authority, maturity, RATE_BPS));
    }
    chain.push(env.open_ladder(owner, 0, RollPolicy::None));
    chain.push(
        env.ladder_deposit(owner, 0, source, DEPOSIT, Distribution::Even { rungs: 4 }, &maturities),
    );

    let steps: Vec<(&common::svm::Instruction, &[Check])> =
        chain.iter().map(|ix| (ix, success)).collect();
    let result = env.mollusk.process_and_validate_instruction_chain(&steps, &env.accounts);

    (env, ladder, source, maturities, result)
}

fn rung_at(result: &InstructionResult, address: Pubkey) -> Rung {
    let raw = &result.get_account(&key(address)).expect("rung").data;
    Rung::try_deserialize(&mut &raw[..]).expect("decodes as Rung")
}

#[test]
fn withholds_the_fee_from_every_rung_into_the_buffer() {
    let (env, ladder, source, maturities, result) = deposit_with_fee(FEE_BPS);

    // 250_000_000 principal per rung, 0.25% of it — 625_000.
    for maturity in maturities {
        let rung = rung_at(&result, env.rung(ladder, env.epoch(maturity)));
        assert_eq!(rung.fee_paid, 625_000, "withheld from rung {maturity}");
        assert_eq!(rung.deposited, 249_375_000, "to work from rung {maturity}");
    }

    assert_eq!(env.token_balance(&result, env.buffer_vault), 2_500_000);
    assert_eq!(env.token_balance(&result, env.vault), 997_500_000);

    // Money neither disappears nor appears: the wallet is empty, and the vault and the buffer
    // together hold exactly what the treasurer signed.
    assert_eq!(env.token_balance(&result, source), 0);
    assert_eq!(
        env.token_balance(&result, env.vault) + env.token_balance(&result, env.buffer_vault),
        DEPOSIT
    );
}

#[test]
fn the_promise_stands_on_what_actually_went_to_work() {
    // A promise on the principal would mean yield on funds the protocol does not have:
    // the fee has already gone to the buffer and takes no part in the work.
    let (env, ladder, _, maturities, result) = deposit_with_fee(FEE_BPS);
    let promised = [254_294_178u64, 259_213_356, 264_132_534, 269_051_712];

    for (index, maturity) in maturities.iter().enumerate() {
        let epoch_key = env.epoch(*maturity);
        let rung = rung_at(&result, env.rung(ladder, epoch_key));
        assert_eq!(rung.promised, promised[index], "rung {index}");

        // The epoch counts what is at work, not the principal: the payout ratio will later come
        // out of these sums, and the principal would inflate its denominator.
        let raw = &result.get_account(&key(epoch_key)).expect("epoch").data;
        let epoch = Epoch::try_deserialize(&mut &raw[..]).expect("decodes as Epoch");
        assert_eq!(epoch.total_deposited, 249_375_000, "epoch {index}");
        assert_eq!(epoch.total_promised, promised[index], "epoch {index}");
    }
}

#[test]
fn a_market_without_a_fee_leaves_the_buffer_empty() {
    let (env, ladder, _, maturities, result) = deposit_with_fee(0);

    assert_eq!(env.token_balance(&result, env.buffer_vault), 0);
    assert_eq!(env.token_balance(&result, env.vault), DEPOSIT);

    let rung = rung_at(&result, env.rung(ladder, env.epoch(maturities[0])));
    assert_eq!(rung.fee_paid, 0);
    assert_eq!(rung.deposited, 250_000_000);
}

#[test]
fn the_split_between_work_and_buffer_never_creates_or_loses_a_unit() {
    // The fee is computed per rung, not from the whole amount, so there are four
    // roundings here, not one. The invariant must hold at any rate.
    for fee_bps in [1u16, 25, 137, 5_000, 9_999] {
        let (env, ladder, source, maturities, result) = deposit_with_fee(fee_bps);

        let vault = env.token_balance(&result, env.vault);
        let buffer = env.token_balance(&result, env.buffer_vault);

        assert_eq!(vault + buffer, DEPOSIT, "rate {fee_bps}");
        assert_eq!(env.token_balance(&result, source), 0, "rate {fee_bps}");

        let withheld: u64 = maturities
            .iter()
            .map(|m| rung_at(&result, env.rung(ladder, env.epoch(*m))).fee_paid)
            .sum();
        let working: u64 = maturities
            .iter()
            .map(|m| rung_at(&result, env.rung(ladder, env.epoch(*m))).deposited)
            .sum();

        // What is in the buffer equals the sum withheld across the rungs: if the fee were
        // computed from the total, these two numbers would differ by units,
        // and neither balance would say which of them is right.
        assert_eq!(withheld, buffer, "rate {fee_bps}: buffer vs rungs");
        assert_eq!(working, vault, "rate {fee_bps}: vault vs rungs");
    }
}
