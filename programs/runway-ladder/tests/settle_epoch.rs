//! `settle_epoch`: one computation per epoch, one ratio for everyone in it (FR-011, FR-011a).

use anchor_lang::prelude::Pubkey;
use anchor_lang::AccountDeserialize;
use mollusk_svm::result::Check;

use runway_ladder::errors::LadderError;
use runway_ladder::math::promise;
use runway_ladder::state::{Epoch, EpochStatus, YieldSource};

mod common;
use common::{anchor_error, key, Deposits, Env, NOW};

const DAY: i64 = 86_400;
const SPAN: i64 = 90 * DAY;
/// The maturity always lies in the past: the clock cannot be turned between instructions, so a
/// settleable epoch is one that was seeded as already matured.
const MATURED: i64 = NOW - DAY;
const WORKING: u64 = 1_000_000_000;

/// A market whose source pays `source_bps`, holding one matured epoch that promised `epoch_bps`.
/// The vault starts with the principal and the buffer with whatever the fees have built up.
fn env(source_bps: u16, epoch_bps: u16, buffer: u64) -> (Env, Pubkey) {
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: source_bps });
    env.seed_market(25, WORKING, buffer);
    let epoch = env.seed_settled_epoch(MATURED, epoch_bps, Deposits::single(WORKING, epoch_bps, SPAN));
    (env, epoch)
}

fn settled_epoch(env: &Env, result: &mollusk_svm::result::InstructionResult, at: Pubkey) -> Epoch {
    let _ = env;
    let raw = &result.get_account(&key(at)).expect("epoch").data;
    Epoch::try_deserialize(&mut &raw[..]).expect("decodes as Epoch")
}

#[test]
fn settles_at_par_when_the_source_covers_the_promise() {
    // The source and the epoch run at the same rate, so the accrual is the very computation the
    // promise was made with — there is nothing for the buffer to do.
    let (env, epoch_key) = env(800, 800, 500_000_000);

    let result = env
        .mollusk
        .process_and_validate_instruction_chain(
            &[(&env.settle_epoch(MATURED), &[Check::success()])],
            &env.accounts,
        );

    let epoch = settled_epoch(&env, &result, epoch_key);
    let expected = promise(WORKING, 800, SPAN).unwrap();
    assert_eq!(epoch.status, EpochStatus::Settled { paid: expected });
    assert_eq!(epoch.total_promised, expected);

    // Untouched: a promise met from the source alone must not move the protocol's money.
    assert_eq!(env.token_balance(&result, env.buffer_vault), 500_000_000);
    assert_eq!(env.token_balance(&result, env.vault), WORKING);
}

#[test]
fn a_surplus_is_recorded_without_moving_anything() {
    // The source outruns the promise. Under the deterministic adapter the extra income has never
    // arrived as tokens, so FR-011b is honoured in the state and becomes a transfer only with a
    // source that really withdraws (T046). The point of this test is that nothing pretends
    // otherwise: no balance moves.
    let (env, epoch_key) = env(1_200, 800, 500_000_000);

    let result = env
        .mollusk
        .process_and_validate_instruction_chain(
            &[(&env.settle_epoch(MATURED), &[Check::success()])],
            &env.accounts,
        );

    let epoch = settled_epoch(&env, &result, epoch_key);
    assert_eq!(epoch.status, EpochStatus::Settled { paid: epoch.total_promised });
    assert_eq!(env.token_balance(&result, env.buffer_vault), 500_000_000);
    assert_eq!(env.token_balance(&result, env.vault), WORKING);
}

#[test]
fn draws_the_shortfall_from_the_buffer_and_actually_moves_it() {
    // The source pays half the promised rate. The buffer is deliberately far larger than the
    // gap, so the shortfall is covered and the treasury keeps its full promise.
    let buffer = 500_000_000;
    let (env, epoch_key) = env(400, 800, buffer);

    let result = env
        .mollusk
        .process_and_validate_instruction_chain(
            &[(&env.settle_epoch(MATURED), &[Check::success()])],
            &env.accounts,
        );

    let epoch = settled_epoch(&env, &result, epoch_key);
    let promised = promise(WORKING, 800, SPAN).unwrap();
    let realized = WORKING + (promise(WORKING, 400, SPAN).unwrap() - WORKING);
    let shortfall = promised - realized;

    assert_eq!(epoch.status, EpochStatus::Settled { paid: promised });
    assert!(shortfall > 0, "the test proves nothing if the source covered the promise");

    // The whole point of moving the money rather than only recording it: the buffer's balance is
    // the buffer, so the next epoch to settle sees what this one left behind and cannot spend it
    // a second time.
    assert_eq!(env.token_balance(&result, env.buffer_vault), buffer - shortfall);
    assert_eq!(env.token_balance(&result, env.vault), WORKING + shortfall);
}

#[test]
fn marks_a_deficit_once_the_buffer_is_gone() {
    // A buffer of one unit: enough to prove it is drained to the last unit before the treasury
    // loses anything, and far too little to cover the gap.
    let (env, epoch_key) = env(400, 800, 1);

    let result = env
        .mollusk
        .process_and_validate_instruction_chain(
            &[(&env.settle_epoch(MATURED), &[Check::success()])],
            &env.accounts,
        );

    let epoch = settled_epoch(&env, &result, epoch_key);
    let promised = promise(WORKING, 800, SPAN).unwrap();
    let realized = promise(WORKING, 400, SPAN).unwrap();

    // FR-011a: the shortfall is in the variant, so there is no way to read the amount paid
    // without also seeing that it fell short.
    assert_eq!(
        epoch.status,
        EpochStatus::SettledWithDeficit {
            paid: realized + 1,
            deficit: promised - realized - 1,
        }
    );

    assert_eq!(env.token_balance(&result, env.buffer_vault), 0);
    assert_eq!(env.token_balance(&result, env.vault), WORKING + 1);
}

#[test]
fn rejects_settlement_before_the_maturity_date() {
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: 800 });
    env.seed_market(25, WORKING, 0);
    let ahead = NOW + DAY;
    env.seed_settled_epoch(ahead, 800, Deposits::single(WORKING, 800, SPAN));

    env.mollusk.process_and_validate_instruction_chain(
        &[(
            &env.settle_epoch(ahead),
            &[Check::err(anchor_error(LadderError::EpochNotMatured))],
        )],
        &env.accounts,
    );
}

#[test]
fn rejects_a_second_settlement() {
    // The crank is permissionless, so two keepers racing is ordinary operation. What must not
    // happen is a second ratio computed against a buffer the first settlement already drew on.
    let (env, _) = env(400, 800, 500_000_000);

    env.mollusk.process_and_validate_instruction_chain(
        &[
            (&env.settle_epoch(MATURED), &[Check::success()]),
            (
                &env.settle_epoch(MATURED),
                &[Check::err(anchor_error(LadderError::EpochAlreadySettled))],
            ),
        ],
        &env.accounts,
    );
}

#[test]
fn an_empty_epoch_settles_at_par_without_dividing_by_zero() {
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: 800 });
    env.seed_market(25, 0, 0);
    let epoch_key = env.seed_settled_epoch(MATURED, 800, Deposits::default());

    let result = env
        .mollusk
        .process_and_validate_instruction_chain(
            &[(&env.settle_epoch(MATURED), &[Check::success()])],
            &env.accounts,
        );

    assert_eq!(settled_epoch(&env, &result, epoch_key).status, EpochStatus::Settled { paid: 0 });
}

/// The property the whole design rests on: the epoch is settled by **one** computation, so its
/// cost cannot grow with the number of rungs that entered it. A per-rung settlement would also
/// pay whoever redeemed first more than whoever redeemed last — this test is what notices if
/// `settle_epoch` ever starts walking the rungs.
#[test]
fn costs_the_same_whether_the_epoch_holds_one_rung_or_eleven() {
    let one = Deposits::single(WORKING, 800, SPAN);

    // Eleven rungs — the ceiling one signature fits (T026) — spread over different spans, so
    // the accumulator holds a genuinely different number rather than a multiple of the first.
    let mut many = Deposits::default();
    for i in 1..=11u64 {
        let working = WORKING / 11;
        let seconds = SPAN - (i as i64) * DAY;
        many.total_deposited += working;
        many.total_promised += promise(working, 800, seconds).unwrap();
        many.deposit_seconds += u128::from(working) * u128::try_from(seconds).unwrap();
    }
    assert_ne!(one.deposit_seconds, many.deposit_seconds);

    let consumed = [one, many].map(|deposits| {
        let mut env = Env::new(YieldSource::Deterministic { rate_bps: 400 });
        env.seed_market(25, WORKING, 500_000_000);
        env.seed_settled_epoch(MATURED, 800, deposits);

        env.mollusk
            .process_and_validate_instruction_chain(
                &[(&env.settle_epoch(MATURED), &[Check::success()])],
                &env.accounts,
            )
            .compute_units_consumed
    });

    assert_eq!(
        consumed[0], consumed[1],
        "settlement cost moved with the rung count: {consumed:?}"
    );
}
