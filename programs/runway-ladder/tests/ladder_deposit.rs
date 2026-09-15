//! The deposit: all rungs in one signature.
//!
//! The numbers here are deliberately written as literals rather than computed with the same
//! formula as in the program: `promise()` is already checked against the shared vectors, and a
//! test that computes the expected value with the same code would check the code against itself.

use anchor_lang::prelude::Pubkey;
use anchor_lang::AccountDeserialize;
use mollusk_svm::result::{Check, InstructionResult};

use runway_ladder::errors::LadderError;
use runway_ladder::math::Distribution;
use runway_ladder::state::{Epoch, Ladder, Rung, RollPolicy, RungStatus, YieldSource};

mod common;
use common::{anchor_error, key, Env, NOW};

const DAY: i64 = 86_400;
const RATE_BPS: u16 = 800;
/// 1000 units of an asset with six decimals.
const DEPOSIT: u64 = 1_000_000_000;

/// The market, the epochs and an open ladder — everything that must exist **before** the deposit.
fn ready(owner: Pubkey, maturities: &[i64], min_rung_amount: u64) -> (Env, Pubkey, Pubkey) {
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: 600 });
    env.min_rung_amount = min_rung_amount;
    env.fund(owner);

    let ladder = env.ladder(owner, 0);
    env.expect_created(ladder);

    for maturity in maturities {
        let epoch = env.epoch(*maturity);
        env.expect_created(epoch);
        env.expect_created(env.rung(ladder, epoch));
    }

    let source = env.fund_tokens(owner, DEPOSIT);

    (env, ladder, source)
}

/// init_market + create_epoch for every date + open_ladder: after which
/// only the deposit itself remains.
fn preamble(env: &Env, maturities: &[i64], owner: Pubkey) -> Vec<common::svm::Instruction> {
    let mut chain = vec![env.init_market(0)];
    for maturity in maturities {
        chain.push(env.create_epoch(env.authority, *maturity, RATE_BPS));
    }
    chain.push(env.open_ladder(owner, 0, RollPolicy::None));
    chain
}

fn run(
    env: &Env,
    maturities: &[i64],
    owner: Pubkey,
    deposit: common::svm::Instruction,
    check: Check,
) -> InstructionResult {
    let mut chain: Vec<(&common::svm::Instruction, &[Check])> = Vec::new();
    let preamble = preamble(env, maturities, owner);
    let success: &[Check] = &[Check::success()];
    for ix in &preamble {
        chain.push((ix, success));
    }
    let last: &[Check] = std::slice::from_ref(&check);
    chain.push((&deposit, last));

    env.mollusk.process_and_validate_instruction_chain(&chain, &env.accounts)
}

fn rung_at(result: &InstructionResult, address: Pubkey) -> Rung {
    let raw = &result.get_account(&key(address)).expect("rung").data;
    Rung::try_deserialize(&mut &raw[..]).expect("decodes as Rung")
}

fn epoch_at(result: &InstructionResult, address: Pubkey) -> Epoch {
    let raw = &result.get_account(&key(address)).expect("epoch").data;
    Epoch::try_deserialize(&mut &raw[..]).expect("decodes as Epoch")
}

#[test]
fn splits_the_deposit_across_every_rung_in_one_signature() {
    let owner = Pubkey::new_unique();
    let maturities = [NOW + 90 * DAY, NOW + 180 * DAY, NOW + 270 * DAY, NOW + 360 * DAY];
    let (env, ladder_key, source) = ready(owner, &maturities, 0);

    let deposit =
        env.ladder_deposit(owner, 0, source, DEPOSIT, Distribution::Even { rungs: 4 }, &maturities);
    let result = run(&env, &maturities, owner, deposit, Check::success());

    // Each rung's promise is from its own date: that is the whole product.
    let promised = [254_931_506u64, 259_863_013, 264_794_520, 269_726_027];

    for (index, maturity) in maturities.iter().enumerate() {
        let epoch_key = env.epoch(*maturity);
        let rung = rung_at(&result, env.rung(ladder_key, epoch_key));

        assert_eq!(rung.ladder, ladder_key, "rung {index}");
        assert_eq!(rung.epoch, epoch_key, "rung {index}");
        assert_eq!(rung.deposited, 250_000_000, "rung {index}");
        assert_eq!(rung.promised, promised[index], "rung {index}");
        assert_eq!(rung.status, RungStatus::Active, "rung {index}");

        let epoch = epoch_at(&result, epoch_key);
        assert_eq!(epoch.total_deposited, 250_000_000, "epoch {index}");
        assert_eq!(epoch.total_promised, promised[index], "epoch {index}");
    }

    // The funds went from the treasury to the market vault in one transfer.
    assert_eq!(env.token_balance(&result, source), 0);
    assert_eq!(env.token_balance(&result, env.vault), DEPOSIT);

    let raw = &result.get_account(&key(ladder_key)).expect("ladder").data;
    let ladder = Ladder::try_deserialize(&mut &raw[..]).expect("decodes as Ladder");
    assert_eq!(ladder.rung_count, 4);
}

#[test]
fn weighted_rungs_follow_the_weights() {
    let owner = Pubkey::new_unique();
    let maturities = [NOW + 90 * DAY, NOW + 180 * DAY, NOW + 270 * DAY];
    let (env, ladder_key, source) = ready(owner, &maturities, 0);

    let deposit = env.ladder_deposit(
        owner,
        0,
        source,
        DEPOSIT,
        Distribution::Weighted { weights_bps: vec![5_000, 3_000, 2_000] },
        &maturities,
    );
    let result = run(&env, &maturities, owner, deposit, Check::success());

    let expected = [
        (500_000_000u64, 509_863_013u64),
        (300_000_000, 311_835_616),
        (200_000_000, 211_835_616),
    ];

    for (index, maturity) in maturities.iter().enumerate() {
        let rung = rung_at(&result, env.rung(ladder_key, env.epoch(*maturity)));
        assert_eq!((rung.deposited, rung.promised), expected[index], "rung {index}");
    }
}

#[test]
fn a_rung_below_the_market_minimum_leaves_the_money_untouched() {
    // Scenario US1: "the amount is not enough for a meaningful deposit — the operation
    // is rejected with the minimum explained, and no funds are debited".
    let owner = Pubkey::new_unique();
    let maturities = [NOW + 90 * DAY, NOW + 180 * DAY, NOW + 270 * DAY, NOW + 360 * DAY];
    let (env, _, source) = ready(owner, &maturities, 300_000_000);

    let deposit =
        env.ladder_deposit(owner, 0, source, DEPOSIT, Distribution::Even { rungs: 4 }, &maturities);
    let result = run(
        &env,
        &maturities,
        owner,
        deposit,
        Check::err(anchor_error(LadderError::RungBelowMinimum)),
    );

    // The check comes before the transfer, not after: half a deposit that was
    // then rolled back would leave the treasurer wondering where their money is.
    assert_eq!(env.token_balance(&result, source), DEPOSIT);
    assert_eq!(env.token_balance(&result, env.vault), 0);
}

#[test]
fn a_stranger_cannot_deposit_into_someone_elses_ladder() {
    let owner = Pubkey::new_unique();
    let maturities = [NOW + 90 * DAY];
    let (mut env, _, _) = ready(owner, &maturities, 0);

    let stranger = Pubkey::new_unique();
    env.fund(stranger);
    let their_money = env.fund_tokens(stranger, DEPOSIT);

    // The ladder is someone else's, the money is their own — which is exactly why the refusal
    // here is not about funds but about who has the right to control the ladder (FR-020).
    let deposit = env.ladder_deposit_as(
        stranger,
        owner,
        0,
        their_money,
        DEPOSIT,
        Distribution::Even { rungs: 1 },
        &maturities,
    );

    run(&env, &maturities, owner, deposit, Check::err(anchor_error(LadderError::NotLadderOwner)));
}

#[test]
fn rejects_an_epoch_whose_maturity_has_already_passed() {
    let owner = Pubkey::new_unique();
    let (mut env, ladder, source) = ready(owner, &[], 0);

    let past = NOW - DAY;
    let epoch = env.seed_epoch(past, RATE_BPS);
    env.expect_created(env.rung(ladder, epoch));

    let deposit =
        env.ladder_deposit(owner, 0, source, DEPOSIT, Distribution::Even { rungs: 1 }, &[past]);
    let result = run(
        &env,
        &[],
        owner,
        deposit,
        Check::err(anchor_error(LadderError::EpochAlreadyMatured)),
    );

    // An epoch that has already matured is a promise in the past. No rung exists in it,
    // and the funds stayed with the treasury.
    assert!(result.get_account(&key(env.rung(ladder, epoch))).expect("rung").data.is_empty());
}

#[test]
fn rejects_a_deposit_whose_accounts_do_not_match_the_distribution() {
    let owner = Pubkey::new_unique();
    let maturities = [NOW + 90 * DAY, NOW + 180 * DAY, NOW + 270 * DAY];
    let (env, _, source) = ready(owner, &maturities, 0);

    // A deposit across four rungs with accounts for three: silently placing three
    // quarters of the amount would mean sending the fourth nowhere.
    let deposit =
        env.ladder_deposit(owner, 0, source, DEPOSIT, Distribution::Even { rungs: 4 }, &maturities);

    run(
        &env,
        &maturities,
        owner,
        deposit,
        Check::err(anchor_error(LadderError::RungAccountsMismatch)),
    );
}

#[test]
fn rejects_an_empty_deposit() {
    let owner = Pubkey::new_unique();
    let maturities = [NOW + 90 * DAY];
    let (env, _, source) = ready(owner, &maturities, 0);

    let deposit =
        env.ladder_deposit(owner, 0, source, 0, Distribution::Even { rungs: 1 }, &maturities);

    run(&env, &maturities, owner, deposit, Check::err(anchor_error(LadderError::ZeroAmount)));
}
