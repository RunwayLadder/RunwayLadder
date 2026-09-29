//! `roll_rung`: a matured rung goes back to work in the market's furthest epoch, by anyone's
//! crank, and nowhere else (FR-013, FR-024).

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use mollusk_svm::result::{Check, InstructionResult};

use runway_ladder::errors::LadderError;
use runway_ladder::math::{fee, promise};
use runway_ladder::state::{Epoch, EpochStatus, Ladder, RollPolicy, Rung, RungStatus, YieldSource};

mod common;
use common::{anchor_error, constraint_error, key, svm, Balances, Deposits, Env, NOW};

const DAY: i64 = 86_400;
const MATURED: i64 = NOW - DAY;
const FURTHEST: i64 = NOW + 90 * DAY;
const FEE_BPS: u16 = 25;
const RATE_BPS: u16 = 800;
/// Principal of other epochs of the same market, sitting in the same vault. A roll moves no
/// money but the fee, so every test can check that this is exactly where it was.
const OTHERS: u64 = 5_000_000_000;

struct Stand {
    env: Env,
    owner: Pubkey,
    ladder: Pubkey,
    /// The epoch the rung matured in.
    epoch: Pubkey,
    /// The market's furthest epoch — the roll target.
    target: Pubkey,
    /// Whoever sends the crank: neither the owner nor the operator.
    keeper: Pubkey,
}

/// One rung promised `promised`, number 0 of a ladder under `policy`, in a matured epoch whose
/// status is `status`, next to an empty furthest epoch at `FURTHEST`. The rung is the first of
/// `promises`; the rest sit in the same epoch in ladders of their own, so the epoch's total is
/// what a ratio needs.
fn stand(status: EpochStatus, promises: &[u64], policy: RollPolicy) -> Stand {
    stand_with_minimum(0, status, promises, policy)
}

/// The same, on a market that refuses rungs under `min_rung_amount`.
fn stand_with_minimum(
    min_rung_amount: u64,
    status: EpochStatus,
    promises: &[u64],
    policy: RollPolicy,
) -> Stand {
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: RATE_BPS });
    env.min_rung_amount = min_rung_amount;

    let total_promised: u64 = promises.iter().sum();
    let paid = match status {
        EpochStatus::Active => 0,
        EpochStatus::Settled { paid } | EpochStatus::SettledWithDeficit { paid, .. } => paid,
    };
    env.seed_market(FEE_BPS, Balances { vault: OTHERS + paid, ..Balances::default() });

    let epoch = env.seed_settled_epoch(
        MATURED,
        RATE_BPS,
        Deposits { total_deposited: total_promised, total_promised, status, ..Deposits::default() },
    );
    let target = env.seed_epoch(FURTHEST, RATE_BPS);

    let owner = Pubkey::new_unique();
    let mut ladders = Vec::new();
    for (seed, promised) in (0u64..).zip(promises) {
        let ladder = env.seed_ladder(owner, seed, policy);
        env.seed_rung(ladder, epoch, *promised);
        ladders.push(ladder);
    }

    let keeper = Pubkey::new_unique();
    env.fund(keeper);
    // The new rung of the ladder under test: number 1, since the rung it rolls is number 0.
    env.expect_created(env.rung(ladders[0], 1));

    Stand { env, owner, ladder: ladders[0], epoch, target, keeper }
}

fn roll(s: &Stand) -> svm::Instruction {
    s.env.roll_rung(s.keeper, s.ladder, s.epoch, 0, s.target)
}

fn run(s: &Stand, ix: &svm::Instruction, check: Check) -> InstructionResult {
    s.env.mollusk.process_and_validate_instruction_chain(&[(ix, &[check])], &s.env.accounts)
}

#[test]
fn a_strangers_crank_rolls_the_rung_into_the_furthest_epoch() {
    let promised = 1_014_794_520;
    let s = stand(EpochStatus::Settled { paid: promised }, &[promised], RollPolicy::Roll);
    let ix = roll(&s);
    // The owner does not sign — the crank is anyone's.
    assert!(ix.accounts.iter().all(|m| m.pubkey != key(s.owner)));

    let result = run(&s, &ix, Check::success());

    let into = s.env.rung(s.ladder, 1);
    let old: Rung = s.env.decode(&result, s.env.rung(s.ladder, 0));
    assert_eq!(old.status, RungStatus::Rolled { amount: promised, into });

    // The new rung is the old payout issued afresh: the deposit's fee, the target's rate, the
    // span from now to the furthest date.
    let split = fee(promised, FEE_BPS).unwrap();
    let new: Rung = s.env.decode(&result, into);
    assert_eq!(new.ladder, s.ladder);
    assert_eq!(new.epoch, s.target);
    assert_eq!(new.index, 1);
    assert_eq!(new.deposited, split.working);
    assert_eq!(new.fee_paid, split.fee);
    assert_eq!(new.promised, promise(split.working, RATE_BPS, FURTHEST - NOW).unwrap());
    assert_eq!(new.status, RungStatus::Active);

    let ladder: Ladder = s.env.decode(&result, s.ladder);
    assert_eq!(ladder.rung_count, 2);

    // The old epoch counts the rolled amount as taken, exactly as a redemption would.
    let epoch: Epoch = s.env.decode(&result, s.epoch);
    assert_eq!(epoch.redeemed, promised);

    let target: Epoch = s.env.decode(&result, s.target);
    assert_eq!(target.total_deposited, split.working);
    assert_eq!(target.total_promised, new.promised);
    assert_eq!(target.deposit_seconds, u128::from(split.working) * (FURTHEST - NOW) as u128);

    // Only the fee moved, and only into the buffer (FR-024).
    assert_eq!(s.env.token_balance(&result, s.env.vault), OTHERS + promised - split.fee);
    assert_eq!(s.env.token_balance(&result, s.env.buffer_vault), split.fee);
}

#[test]
fn under_a_deficit_the_new_rung_is_issued_from_what_the_rung_received() {
    // The epoch promised 1 000 and settled for 750; the rung promised 600 receives 450, and that
    // is all there is to put back to work. Both numbers stay on the old rung.
    let status = EpochStatus::SettledWithDeficit { paid: 750, deficit: 250 };
    let s = stand(status, &[600, 400], RollPolicy::Roll);

    let result = run(&s, &roll(&s), Check::success());

    let into = s.env.rung(s.ladder, 1);
    let old: Rung = s.env.decode(&result, s.env.rung(s.ladder, 0));
    assert_eq!(old.status, RungStatus::RolledWithDeficit { amount: 450, promised: 600, into });

    let new: Rung = s.env.decode(&result, into);
    let split = fee(450, FEE_BPS).unwrap();
    assert_eq!(new.deposited, split.working);
    assert_eq!(new.promised, promise(split.working, RATE_BPS, FURTHEST - NOW).unwrap());
}

#[test]
fn a_stranger_cannot_divert_the_roll_into_a_rung_of_their_own() {
    // The only thing a crank could point elsewhere is the new rung. The stranger passes the next
    // rung of their own ladder in its place; its address does not follow from this ladder's
    // seeds, so nothing is issued anywhere. There is no token account to substitute at all.
    let mut s = stand(EpochStatus::Settled { paid: 1_000 }, &[1_000], RollPolicy::Roll);
    let theirs = s.env.seed_ladder(s.keeper, 0, RollPolicy::Roll);
    let their_rung = s.env.rung(theirs, 0);
    s.env.expect_created(their_rung);

    let mut ix = roll(&s);
    let slot = ix
        .accounts
        .iter_mut()
        .find(|m| m.pubkey == key(s.env.rung(s.ladder, 1)))
        .expect("the new rung is among the accounts");
    slot.pubkey = key(their_rung);

    run(&s, &ix, Check::err(constraint_error(ErrorCode::ConstraintSeeds)));
}

#[test]
fn a_stranger_cannot_roll_the_rung_through_a_ladder_of_their_own() {
    // The stranger swaps the ladder for their own and passes that ladder's next rung — a new
    // rung that would pass its seeds. The rung under roll is still the owner's, and its address
    // does not follow from the stranger's ladder.
    let mut s = stand(EpochStatus::Settled { paid: 1_000 }, &[1_000], RollPolicy::Roll);
    let theirs = s.env.seed_ladder(s.keeper, 0, RollPolicy::Roll);
    let their_rung = s.env.rung(theirs, 0);
    s.env.expect_created(their_rung);

    let mut ix = roll(&s);
    for meta in &mut ix.accounts {
        if meta.pubkey == key(s.ladder) {
            meta.pubkey = key(theirs);
        } else if meta.pubkey == key(s.env.rung(s.ladder, 1)) {
            meta.pubkey = key(their_rung);
        }
    }

    run(&s, &ix, Check::err(constraint_error(ErrorCode::ConstraintSeeds)));
}

#[test]
fn a_ladder_without_the_roll_policy_is_left_to_its_owner() {
    let s = stand(EpochStatus::Settled { paid: 1_000 }, &[1_000], RollPolicy::None);
    run(&s, &roll(&s), Check::err(anchor_error(LadderError::RollPolicyDisabled)));
}

#[test]
fn the_crank_cannot_choose_a_nearer_epoch() {
    // A second future epoch, nearer than the furthest: a shorter promise, and the crank must not
    // be the one to pick it.
    let mut s = stand(EpochStatus::Settled { paid: 1_000 }, &[1_000], RollPolicy::Roll);
    let nearer = s.env.seed_epoch(NOW + 30 * DAY, RATE_BPS);

    let ix = s.env.roll_rung(s.keeper, s.ladder, s.epoch, 0, nearer);
    run(&s, &ix, Check::err(anchor_error(LadderError::RollTargetNotLatest)));
}

#[test]
fn nothing_rolls_while_the_furthest_epoch_has_already_matured() {
    // The operator has not opened anything past the dates already gone: the market's furthest
    // epoch lies behind the clock, and there is nowhere to put the funds.
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: RATE_BPS });
    env.seed_market(FEE_BPS, Balances { vault: OTHERS + 1_000, ..Balances::default() });
    let epoch = env.seed_settled_epoch(
        MATURED - DAY,
        RATE_BPS,
        Deposits {
            total_deposited: 1_000,
            total_promised: 1_000,
            status: EpochStatus::Settled { paid: 1_000 },
            ..Deposits::default()
        },
    );
    let furthest = env.seed_epoch(MATURED, RATE_BPS);
    let ladder = env.seed_ladder(Pubkey::new_unique(), 0, RollPolicy::Roll);
    env.seed_rung(ladder, epoch, 1_000);
    let keeper = Pubkey::new_unique();
    env.fund(keeper);
    env.expect_created(env.rung(ladder, 1));

    env.mollusk.process_and_validate_instruction_chain(
        &[(
            &env.roll_rung(keeper, ladder, epoch, 0, furthest),
            &[Check::err(anchor_error(LadderError::EpochAlreadyMatured))],
        )],
        &env.accounts,
    );
}

#[test]
fn nothing_rolls_before_the_epoch_is_settled() {
    let s = stand(EpochStatus::Active, &[1_000], RollPolicy::Roll);
    run(&s, &roll(&s), Check::err(anchor_error(LadderError::EpochNotSettled)));
}

#[test]
fn a_rolled_rung_is_consumed_for_the_owner_too() {
    // Whichever comes first consumes the rung, once: after the crank, the owner's redemption
    // finds it no longer active and pays nothing out of the vault.
    let mut s = stand(EpochStatus::Settled { paid: 1_000 }, &[1_000], RollPolicy::Roll);
    s.env.fund(s.owner);
    let wallet = s.env.fund_tokens(s.owner, 0);

    s.env.mollusk.process_and_validate_instruction_chain(
        &[
            (&roll(&s), &[Check::success()]),
            (
                &s.env.redeem_rung(s.owner, s.ladder, s.epoch, 0, wallet),
                &[Check::err(anchor_error(LadderError::RungNotActive))],
            ),
        ],
        &s.env.accounts,
    );
}

#[test]
fn a_redeemed_rung_cannot_be_rolled() {
    let mut s = stand(EpochStatus::Settled { paid: 1_000 }, &[1_000], RollPolicy::Roll);
    s.env.fund(s.owner);
    let wallet = s.env.fund_tokens(s.owner, 0);

    s.env.mollusk.process_and_validate_instruction_chain(
        &[
            (&s.env.redeem_rung(s.owner, s.ladder, s.epoch, 0, wallet), &[Check::success()]),
            (&roll(&s), &[Check::err(anchor_error(LadderError::RungNotActive))]),
        ],
        &s.env.accounts,
    );
}

#[test]
fn a_haircut_below_the_market_minimum_is_not_rolled() {
    // The rung promised 600 receives 450 under the deficit, and the market will not issue a rung
    // under 500. It stays active for the owner to redeem by hand.
    let s = stand_with_minimum(
        500,
        EpochStatus::SettledWithDeficit { paid: 750, deficit: 250 },
        &[600, 400],
        RollPolicy::Roll,
    );

    run(&s, &roll(&s), Check::err(anchor_error(LadderError::RungBelowMinimum)));
}
