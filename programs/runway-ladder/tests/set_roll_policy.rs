//! `set_roll_policy`: the treasurer turns the crank's permission on or off at any time, and the
//! rungs already issued stay as they were (FR-014).

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use mollusk_svm::result::{Check, InstructionResult};

use runway_ladder::errors::LadderError;
use runway_ladder::state::{EpochStatus, Ladder, RollPolicy, Rung, RungStatus, YieldSource};

mod common;
use common::{
    anchor_error, constraint_error, key, svm, without_signature, Balances, Deposits, Env, NOW,
};

const DAY: i64 = 86_400;
const MATURED: i64 = NOW - DAY;
const FURTHEST: i64 = NOW + 90 * DAY;
const RATE_BPS: u16 = 800;
const PROMISED: u64 = 1_000_000_000;

struct Stand {
    env: Env,
    owner: Pubkey,
    ladder: Pubkey,
    epoch: Pubkey,
    target: Pubkey,
    keeper: Pubkey,
    /// The owner's token account a redemption pays into.
    wallet: Pubkey,
}

/// Rung number 0 of a ladder under `policy` in an epoch settled in full, next to the market's
/// furthest epoch — everything a crank and a redemption need, so both can be tried after the
/// policy changes.
fn stand_for(owner: Pubkey, policy: RollPolicy) -> Stand {
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: RATE_BPS });
    env.seed_market(25, Balances { vault: PROMISED, ..Balances::default() });

    let epoch = env.seed_settled_epoch(
        MATURED,
        RATE_BPS,
        Deposits {
            total_deposited: PROMISED,
            total_promised: PROMISED,
            status: EpochStatus::Settled { paid: PROMISED },
            ..Deposits::default()
        },
    );
    let target = env.seed_epoch(FURTHEST, RATE_BPS);

    let ladder = env.seed_ladder(owner, 0, policy);
    env.seed_rung(ladder, epoch, PROMISED);

    env.fund(owner);
    let wallet = env.fund_tokens(owner, 0);
    let keeper = Pubkey::new_unique();
    env.fund(keeper);
    env.expect_created(env.rung(ladder, 1));

    Stand { env, owner, ladder, epoch, target, keeper, wallet }
}

fn stand(policy: RollPolicy) -> Stand {
    stand_for(Pubkey::new_unique(), policy)
}

fn set(s: &Stand, policy: RollPolicy) -> svm::Instruction {
    s.env.set_roll_policy(s.owner, s.ladder, policy)
}

fn roll(s: &Stand) -> svm::Instruction {
    s.env.roll_rung(s.keeper, s.ladder, s.epoch, 0, s.target)
}

fn redeem(s: &Stand) -> svm::Instruction {
    s.env.redeem_rung(s.owner, s.ladder, s.epoch, 0, s.wallet)
}

fn run(s: &Stand, ix: &svm::Instruction, check: Check) -> InstructionResult {
    s.env.mollusk.process_and_validate_instruction_chain(&[(ix, &[check])], &s.env.accounts)
}

/// Runs `ix` on the accounts `after` left behind. A mollusk chain stops at its first failure,
/// so "the crank is refused, and then the owner redeems" is two runs from the same state.
fn then(
    s: &Stand,
    after: &InstructionResult,
    ix: &svm::Instruction,
    check: Check,
) -> InstructionResult {
    s.env.mollusk.process_and_validate_instruction_chain(&[(ix, &[check])], &after.resulting_accounts)
}

fn account_data(s: &Stand, address: Pubkey) -> Vec<u8> {
    let (_, account) =
        s.env.accounts.iter().find(|(k, _)| *k == key(address)).expect("account in the stand");
    account.data.clone()
}

#[test]
fn turning_the_policy_off_stops_the_crank_on_rungs_already_issued() {
    let s = stand(RollPolicy::Roll);
    let rung_before = account_data(&s, s.env.rung(s.ladder, 0));

    let off = run(&s, &set(&s, RollPolicy::None), Check::success());

    let ladder: Ladder = s.env.decode(&off, s.ladder);
    assert_eq!(ladder.roll_policy, RollPolicy::None);

    // The rung was issued under `Roll`, and still the crank no longer reaches it.
    then(&s, &off, &roll(&s), Check::err(anchor_error(LadderError::RollPolicyDisabled)));

    // Not touched: the rung is byte for byte what it was — still active, the same promise.
    let rung_after = off.get_account(&key(s.env.rung(s.ladder, 0))).expect("the rung").data.clone();
    assert_eq!(rung_after, rung_before);
    let rung: Rung = s.env.decode(&off, s.env.rung(s.ladder, 0));
    assert_eq!(rung.status, RungStatus::Active);
}

#[test]
fn after_turning_the_policy_off_the_owner_redeems_the_rung_at_par() {
    let s = stand(RollPolicy::Roll);
    let off = run(&s, &set(&s, RollPolicy::None), Check::success());

    let redeemed = then(&s, &off, &redeem(&s), Check::success());

    let rung: Rung = s.env.decode(&redeemed, s.env.rung(s.ladder, 0));
    assert_eq!(rung.status, RungStatus::Redeemed { amount: PROMISED });
    assert_eq!(s.env.token_balance(&redeemed, s.wallet), PROMISED);
}

#[test]
fn turning_the_policy_back_on_lets_the_crank_roll_rungs_already_issued() {
    // The mirror of the switch-off: the rung was issued under `None`, and the policy read at the
    // moment of the roll is what decides.
    let s = stand(RollPolicy::None);

    let result = s.env.mollusk.process_and_validate_instruction_chain(
        &[(&set(&s, RollPolicy::Roll), &[Check::success()]), (&roll(&s), &[Check::success()])],
        &s.env.accounts,
    );

    let rung: Rung = s.env.decode(&result, s.env.rung(s.ladder, 0));
    assert_eq!(rung.status, RungStatus::Rolled { amount: PROMISED, into: s.env.rung(s.ladder, 1) });
}

#[test]
fn setting_the_policy_the_ladder_already_has_changes_nothing() {
    // Two proposals of one multisig safe landing in turn: the second is not a failure.
    let s = stand(RollPolicy::Roll);
    let before = account_data(&s, s.ladder);

    let after = run(&s, &set(&s, RollPolicy::Roll), Check::success());

    assert_eq!(after.get_account(&key(s.ladder)).expect("the ladder").data, before);
}

#[test]
fn a_stranger_cannot_change_the_owners_policy() {
    // The one who would gain is a crank operator turning the policy on for someone else's
    // ladder — rolling funds the treasurer meant to take out.
    let mut s = stand(RollPolicy::None);
    let stranger = Pubkey::new_unique();
    s.env.fund(stranger);

    run(
        &s,
        &s.env.set_roll_policy(stranger, s.ladder, RollPolicy::Roll),
        Check::err(anchor_error(LadderError::NotLadderOwner)),
    );
}

#[test]
fn the_owner_has_to_sign() {
    let s = stand(RollPolicy::None);

    run(
        &s,
        &without_signature(set(&s, RollPolicy::Roll), s.owner),
        Check::err(constraint_error(ErrorCode::AccountNotSigner)),
    );
}

#[test]
fn a_multisig_safe_changes_the_policy_by_the_same_path() {
    // A Squads safe is a PDA; its signature comes through CPI (FR-020a).
    let safe = Pubkey::find_program_address(&[b"squads-safe"], &Pubkey::new_unique()).0;
    assert!(!safe.is_on_curve(), "the safe must be a PDA, otherwise the test checks nothing");
    let s = stand_for(safe, RollPolicy::Roll);

    let result = run(&s, &set(&s, RollPolicy::None), Check::success());

    let ladder: Ladder = s.env.decode(&result, s.ladder);
    assert_eq!(ladder.roll_policy, RollPolicy::None);
}
