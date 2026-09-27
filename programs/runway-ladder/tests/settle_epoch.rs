//! `settle_epoch`: one computation per epoch, one ratio for everyone in it (FR-011, FR-011a).

use anchor_lang::prelude::Pubkey;
use anchor_lang::AccountDeserialize;
use mollusk_svm::result::Check;

use runway_ladder::errors::LadderError;
use runway_ladder::math::promise;
use runway_ladder::state::{Epoch, EpochStatus, YieldSource};

mod common;
use common::{anchor_error, constraint_error, key, Balances, Deposits, Env, NOW};

const DAY: i64 = 86_400;
const SPAN: i64 = 90 * DAY;
/// The maturity always lies in the past: the clock cannot be turned between instructions, so a
/// settleable epoch is one that was seeded as already matured.
const MATURED: i64 = NOW - DAY;
const WORKING: u64 = 1_000_000_000;
/// Far more than any single epoch here earns, so a test that is not about the reserve never
/// runs into it.
const RESERVE: u64 = 900_000_000;

/// What the deterministic source owes one deposit of `WORKING` held for `SPAN` at `rate_bps` —
/// the promise minus its principal, which is exactly the accrual (`deterministic.rs` holds the
/// two forms together).
fn income(rate_bps: u16) -> u64 {
    promise(WORKING, rate_bps, SPAN).unwrap() - WORKING
}

/// A market whose source pays `source_bps`, holding one matured epoch that promised `epoch_bps`.
/// The vault starts with the principal, the buffer with whatever the fees have built up, and
/// the reserve with whatever the stand has put there for the source to pay out.
fn env(source_bps: u16, epoch_bps: u16, buffer: u64, reserve: u64) -> (Env, Pubkey) {
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: source_bps });
    env.seed_market(25, Balances { vault: WORKING, buffer, reserve });
    let epoch = env.seed_settled_epoch(MATURED, epoch_bps, Deposits::single(WORKING, epoch_bps, SPAN));
    (env, epoch)
}

fn settle(env: &Env) -> mollusk_svm::result::InstructionResult {
    env.mollusk.process_and_validate_instruction_chain(
        &[(&env.settle_epoch(MATURED), &[Check::success()])],
        &env.accounts,
    )
}

fn settled_epoch(result: &mollusk_svm::result::InstructionResult, at: Pubkey) -> Epoch {
    let raw = &result.get_account(&key(at)).expect("epoch").data;
    Epoch::try_deserialize(&mut &raw[..]).expect("decodes as Epoch")
}

#[test]
fn settles_at_par_when_the_source_covers_the_promise() {
    // The source and the epoch run at the same rate, so the accrual is the very computation the
    // promise was made with — there is nothing for the buffer to do.
    let (env, epoch_key) = env(800, 800, 500_000_000, RESERVE);
    let result = settle(&env);

    let epoch = settled_epoch(&result, epoch_key);
    let expected = promise(WORKING, 800, SPAN).unwrap();
    assert_eq!(epoch.status, EpochStatus::Settled { paid: expected });
    assert_eq!(epoch.total_promised, expected);

    // The income arrived as tokens: the vault now holds what the epoch will pay out, and the
    // reserve is short by exactly that income.
    assert_eq!(env.token_balance(&result, env.vault), expected);
    assert_eq!(env.token_balance(&result, env.source_reserve), RESERVE - income(800));
    // Untouched: a promise met from the source alone must not move the protocol's money.
    assert_eq!(env.token_balance(&result, env.buffer_vault), 500_000_000);
}

#[test]
fn a_surplus_moves_into_the_buffer() {
    // The source outruns the promise. FR-011b: what is left above the promise is the protocol's
    // margin for carrying the rate risk, and it travels to the buffer as tokens — the vault is
    // left holding the promise and nothing more.
    let buffer = 500_000_000;
    let (env, epoch_key) = env(1_200, 800, buffer, RESERVE);
    let result = settle(&env);

    let promised = promise(WORKING, 800, SPAN).unwrap();
    let surplus = WORKING + income(1_200) - promised;
    assert!(surplus > 0, "the test proves nothing if the source did not outrun the promise");

    assert_eq!(settled_epoch(&result, epoch_key).status, EpochStatus::Settled { paid: promised });
    assert_eq!(env.token_balance(&result, env.vault), promised);
    assert_eq!(env.token_balance(&result, env.buffer_vault), buffer + surplus);
    assert_eq!(env.token_balance(&result, env.source_reserve), RESERVE - income(1_200));
}

#[test]
fn draws_the_shortfall_from_the_buffer_and_actually_moves_it() {
    // The source pays half the promised rate. The buffer is deliberately far larger than the
    // gap, so the shortfall is covered and the treasury keeps its full promise.
    let buffer = 500_000_000;
    let (env, epoch_key) = env(400, 800, buffer, RESERVE);
    let result = settle(&env);

    let promised = promise(WORKING, 800, SPAN).unwrap();
    let shortfall = promised - (WORKING + income(400));
    assert!(shortfall > 0, "the test proves nothing if the source covered the promise");

    assert_eq!(settled_epoch(&result, epoch_key).status, EpochStatus::Settled { paid: promised });

    // The whole point of moving the money rather than only recording it: the buffer's balance is
    // the buffer, so the next epoch to settle sees what this one left behind and cannot spend it
    // a second time.
    assert_eq!(env.token_balance(&result, env.buffer_vault), buffer - shortfall);
    assert_eq!(env.token_balance(&result, env.vault), promised);
}

#[test]
fn marks_a_deficit_once_the_buffer_is_gone() {
    // A buffer of one unit: enough to prove it is drained to the last unit before the treasury
    // loses anything, and far too little to cover the gap.
    let (env, epoch_key) = env(400, 800, 1, RESERVE);
    let result = settle(&env);

    let promised = promise(WORKING, 800, SPAN).unwrap();
    let realized = WORKING + income(400);

    // FR-011a: the shortfall is in the variant, so there is no way to read the amount paid
    // without also seeing that it fell short.
    assert_eq!(
        settled_epoch(&result, epoch_key).status,
        EpochStatus::SettledWithDeficit { paid: realized + 1, deficit: promised - realized - 1 }
    );

    assert_eq!(env.token_balance(&result, env.buffer_vault), 0);
    assert_eq!(env.token_balance(&result, env.vault), realized + 1);
}

#[test]
fn counts_only_the_income_the_reserve_actually_holds() {
    // The formula says the epoch earned `income(800)`; the reserve holds a third of it. The
    // program must settle on the third — the rest is a shortfall like any other, which the
    // buffer covers here — and must never pay the difference out of the shared vault.
    let buffer = 500_000_000;
    let held = income(800) / 3;
    let (env, epoch_key) = env(800, 800, buffer, held);
    let result = settle(&env);

    let promised = promise(WORKING, 800, SPAN).unwrap();
    let from_buffer = promised - (WORKING + held);

    assert_eq!(settled_epoch(&result, epoch_key).status, EpochStatus::Settled { paid: promised });
    assert_eq!(env.token_balance(&result, env.source_reserve), 0);
    assert_eq!(env.token_balance(&result, env.buffer_vault), buffer - from_buffer);
    assert_eq!(env.token_balance(&result, env.vault), promised);
}

#[test]
fn an_unfunded_source_is_a_marked_deficit_not_a_raid_on_the_vault() {
    // Nobody topped up the reserve and the buffer is empty. Under the formula alone this epoch
    // would settle at par and quietly take its income out of other epochs' principal; with the
    // reserve as the only source of income it is a deficit, and the deficit is in the status.
    let (env, epoch_key) = env(800, 800, 0, 0);
    let result = settle(&env);

    assert_eq!(
        settled_epoch(&result, epoch_key).status,
        EpochStatus::SettledWithDeficit { paid: WORKING, deficit: income(800) }
    );
    assert_eq!(env.token_balance(&result, env.vault), WORKING);
}

#[test]
fn rejects_a_reserve_that_is_not_the_markets() {
    // An account the market owns, of the right mint, funded — everything the owner check alone
    // would accept. Only its address is wrong, and the address is the whole guard: otherwise a
    // caller could hand in any market-owned account as "income".
    let (mut env, _) = env(800, 800, 0, 0);
    let impostor = env.fund_tokens(env.market, RESERVE);

    let mut ix = env.settle_epoch(MATURED);
    let slot = ix
        .accounts
        .iter_mut()
        .find(|meta| meta.pubkey == key(env.source_reserve))
        .expect("the reserve is among the accounts");
    slot.pubkey = key(impostor);

    env.mollusk.process_and_validate_instruction_chain(
        &[(&ix, &[Check::err(constraint_error(anchor_lang::error::ErrorCode::ConstraintSeeds))])],
        &env.accounts,
    );
}

#[test]
fn rejects_settlement_before_the_maturity_date() {
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: 800 });
    env.seed_market(25, Balances { vault: WORKING, reserve: RESERVE, ..Balances::default() });
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
    let (env, _) = env(400, 800, 500_000_000, RESERVE);

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
    env.seed_market(25, Balances { reserve: RESERVE, ..Balances::default() });
    let epoch_key = env.seed_settled_epoch(MATURED, 800, Deposits::default());

    let result = settle(&env);

    assert_eq!(settled_epoch(&result, epoch_key).status, EpochStatus::Settled { paid: 0 });
    // Nothing was earned, so nothing is taken from the reserve.
    assert_eq!(env.token_balance(&result, env.source_reserve), RESERVE);
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
        env.seed_market(25, Balances { vault: WORKING, buffer: 500_000_000, reserve: RESERVE });
        env.seed_settled_epoch(MATURED, 800, deposits);
        settle(&env).compute_units_consumed
    });

    assert_eq!(
        consumed[0], consumed[1],
        "settlement cost moved with the rung count: {consumed:?}"
    );
}
