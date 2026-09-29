//! `redeem_rung`: the promise at par, or the epoch's ratio with the deficit marked (FR-012,
//! FR-011a).

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::AccountDeserialize;
use mollusk_svm::result::{Check, InstructionResult};

use runway_ladder::errors::LadderError;
use runway_ladder::state::{Epoch, EpochStatus, RollPolicy, Rung, RungStatus, YieldSource};

mod common;
use common::{anchor_error, constraint_error, key, svm, Balances, Deposits, Env, NOW};

const MATURED: i64 = NOW - 86_400;
/// Principal of other epochs of the same market, sitting in the same vault. Every test keeps it
/// there, because the failure a redemption must not have is paying out of it.
const OTHERS: u64 = 5_000_000_000;

struct Stand {
    env: Env,
    owner: Pubkey,
    ladder: Pubkey,
    epoch: Pubkey,
    /// The owner's own token account, empty, where the redemption should land.
    wallet: Pubkey,
}

/// One rung per promise in `promises`, all of `owner` and all in one matured epoch whose status
/// is `status`. Each rung sits in a ladder of its own, as its number 0, so a test names a rung by
/// its ladder alone. The vault holds what the epoch settled for on top of `OTHERS`.
fn stand(status: EpochStatus, promises: &[u64], policy: RollPolicy) -> (Stand, Vec<Pubkey>) {
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: 800 });

    let total_promised: u64 = promises.iter().sum();
    let paid = match status {
        EpochStatus::Active => 0,
        EpochStatus::Settled { paid } | EpochStatus::SettledWithDeficit { paid, .. } => paid,
    };
    env.seed_market(25, Balances { vault: OTHERS + paid, ..Balances::default() });

    let epoch = env.seed_settled_epoch(
        MATURED,
        800,
        Deposits { total_deposited: total_promised, total_promised, status, ..Deposits::default() },
    );

    let owner = Pubkey::new_unique();
    env.fund(owner);
    let wallet = env.fund_tokens(owner, 0);

    let ladders: Vec<Pubkey> = promises
        .iter()
        .enumerate()
        .map(|(seed, promised)| {
            let ladder = env.seed_ladder(owner, seed as u64, policy);
            env.seed_rung(ladder, epoch, *promised);
            ladder
        })
        .collect();

    (Stand { env, owner, ladder: ladders[0], epoch, wallet }, ladders)
}

fn redeem(s: &Stand, ladder: Pubkey) -> svm::Instruction {
    s.env.redeem_rung(s.owner, ladder, s.epoch, 0, s.wallet)
}

fn rung_status(s: &Stand, result: &InstructionResult, ladder: Pubkey) -> RungStatus {
    let raw = &result.get_account(&key(s.env.rung(ladder, 0))).expect("rung").data;
    Rung::try_deserialize(&mut &raw[..]).expect("decodes as Rung").status
}

fn epoch_redeemed(s: &Stand, result: &InstructionResult) -> u64 {
    let raw = &result.get_account(&key(s.epoch)).expect("epoch").data;
    Epoch::try_deserialize(&mut &raw[..]).expect("decodes as Epoch").redeemed
}

#[test]
fn pays_the_promise_at_par() {
    let promised = 1_014_794_520;
    let (s, _) = stand(EpochStatus::Settled { paid: promised }, &[promised], RollPolicy::None);

    let result = s
        .env
        .mollusk
        .process_and_validate_instruction_chain(&[(&redeem(&s, s.ladder), &[Check::success()])], &s.env.accounts);

    assert_eq!(rung_status(&s, &result, s.ladder), RungStatus::Redeemed { amount: promised });
    assert_eq!(s.env.token_balance(&result, s.wallet), promised);
    // The other epochs' principal is exactly where it was.
    assert_eq!(s.env.token_balance(&result, s.env.vault), OTHERS);
    assert_eq!(epoch_redeemed(&s, &result), promised);
}

#[test]
fn pays_the_epoch_ratio_and_marks_the_deficit_in_the_rung() {
    // The epoch promised 1 000 and settled for 750. A rung promised 600 receives
    // floor(600 × 750 / 1 000) = 450, and the status carries both numbers — there is no way to
    // read the 450 without also reading that 600 was owed.
    let status = EpochStatus::SettledWithDeficit { paid: 750, deficit: 250 };
    let (s, _) = stand(status, &[600, 400], RollPolicy::None);

    let result = s
        .env
        .mollusk
        .process_and_validate_instruction_chain(&[(&redeem(&s, s.ladder), &[Check::success()])], &s.env.accounts);

    assert_eq!(
        rung_status(&s, &result, s.ladder),
        RungStatus::RedeemedWithDeficit { amount: 450, promised: 600 }
    );
    assert_eq!(s.env.token_balance(&result, s.wallet), 450);
}

#[test]
fn every_rung_gets_the_same_ratio_whichever_is_redeemed_first() {
    // Awkward numbers on purpose: each division leaves a remainder, so the dust is real. Redeemed
    // in both orders, each rung receives the same amount, the epoch never pays past `paid`, and
    // what stays in the vault above the other epochs' money is only the rounding dust.
    let promises = [333_333_337, 250_000_001, 416_666_669];
    let total: u64 = promises.iter().sum();
    let paid = total - 123_456_789;
    let status = EpochStatus::SettledWithDeficit { paid, deficit: total - paid };

    let run = |order: [usize; 3]| {
        let (s, ladders) = stand(status, &promises, RollPolicy::None);
        let chain: Vec<svm::Instruction> = order.iter().map(|&i| redeem(&s, ladders[i])).collect();
        let ok = [Check::success()];
        let steps: Vec<(&svm::Instruction, &[Check])> =
            chain.iter().map(|ix| (ix, &ok[..])).collect();
        let result = s.env.mollusk.process_and_validate_instruction_chain(&steps, &s.env.accounts);

        let amounts: Vec<u64> = ladders
            .iter()
            .map(|l| match rung_status(&s, &result, *l) {
                RungStatus::RedeemedWithDeficit { amount, .. } => amount,
                other => panic!("expected a marked deficit, got {other:?}"),
            })
            .collect();
        let vault = s.env.token_balance(&result, s.env.vault);
        (amounts, vault, epoch_redeemed(&s, &result))
    };

    let (forward, vault, redeemed) = run([0, 1, 2]);
    let (backward, _, _) = run([2, 1, 0]);
    assert_eq!(forward, backward);

    let sum: u64 = forward.iter().sum();
    assert_eq!(redeemed, sum);
    assert!(sum <= paid);
    // Rounding leaves less than one unit per rung, and the dust is all that stays behind.
    assert!(paid - sum < promises.len() as u64);
    assert_eq!(vault, OTHERS + (paid - sum));
    assert!(paid - sum > 0, "the test proves nothing about dust if the division was exact");
}

#[test]
fn a_roll_policy_does_not_lock_the_owner_out() {
    // Decision 2026-09-27: the policy permits the crank, it does not restrict the owner.
    let (s, _) = stand(EpochStatus::Settled { paid: 1_000 }, &[1_000], RollPolicy::Roll);

    let result = s
        .env
        .mollusk
        .process_and_validate_instruction_chain(&[(&redeem(&s, s.ladder), &[Check::success()])], &s.env.accounts);

    assert_eq!(rung_status(&s, &result, s.ladder), RungStatus::Redeemed { amount: 1_000 });
}

#[test]
fn rejects_redemption_before_the_epoch_is_settled() {
    let (s, _) = stand(EpochStatus::Active, &[1_000], RollPolicy::None);

    s.env.mollusk.process_and_validate_instruction_chain(
        &[(&redeem(&s, s.ladder), &[Check::err(anchor_error(LadderError::EpochNotSettled))])],
        &s.env.accounts,
    );
}

#[test]
fn rejects_a_second_redemption() {
    let (s, _) = stand(EpochStatus::Settled { paid: 1_000 }, &[1_000], RollPolicy::None);

    s.env.mollusk.process_and_validate_instruction_chain(
        &[
            (&redeem(&s, s.ladder), &[Check::success()]),
            (&redeem(&s, s.ladder), &[Check::err(anchor_error(LadderError::RungNotActive))]),
        ],
        &s.env.accounts,
    );
}

#[test]
fn a_stranger_cannot_redeem_the_owners_rung() {
    let (mut s, _) = stand(EpochStatus::Settled { paid: 1_000 }, &[1_000], RollPolicy::None);
    let stranger = Pubkey::new_unique();
    s.env.fund(stranger);
    let theirs = s.env.fund_tokens(stranger, 0);

    let ix = s.env.redeem_rung(stranger, s.ladder, s.epoch, 0, theirs);
    s.env.mollusk.process_and_validate_instruction_chain(
        &[(&ix, &[Check::err(anchor_error(LadderError::NotLadderOwner))])],
        &s.env.accounts,
    );
}

#[test]
fn the_owner_cannot_redeem_into_someone_elses_account() {
    let (mut s, _) = stand(EpochStatus::Settled { paid: 1_000 }, &[1_000], RollPolicy::None);
    let theirs = s.env.fund_tokens(Pubkey::new_unique(), 0);

    let ix = s.env.redeem_rung(s.owner, s.ladder, s.epoch, 0, theirs);
    s.env.mollusk.process_and_validate_instruction_chain(
        &[(&ix, &[Check::err(constraint_error(ErrorCode::ConstraintTokenOwner))])],
        &s.env.accounts,
    );
}

#[test]
fn a_rung_cannot_be_redeemed_against_another_epochs_ratio() {
    // The rung sits in an epoch that settled at a deficit; a second epoch of the same market
    // settled at par. Passing the par epoch next to the deficit rung would pay it in full — the
    // epoch the rung names (`has_one = epoch`) is what makes that pairing impossible. The seeds
    // no longer do: they carry the rung's number, not its epoch.
    let (mut s, _) =
        stand(EpochStatus::SettledWithDeficit { paid: 500, deficit: 500 }, &[1_000], RollPolicy::None);
    let at_par = s.env.seed_settled_epoch(
        MATURED - 86_400,
        800,
        Deposits {
            total_deposited: 1_000,
            total_promised: 1_000,
            status: EpochStatus::Settled { paid: 1_000 },
            ..Deposits::default()
        },
    );

    let mut ix = redeem(&s, s.ladder);
    let slot = ix
        .accounts
        .iter_mut()
        .find(|meta| meta.pubkey == key(s.epoch))
        .expect("the epoch is among the accounts");
    slot.pubkey = key(at_par);

    s.env.mollusk.process_and_validate_instruction_chain(
        &[(&ix, &[Check::err(constraint_error(ErrorCode::ConstraintHasOne))])],
        &s.env.accounts,
    );
}

#[test]
fn a_rung_cannot_be_redeemed_through_another_ladder_of_the_same_owner() {
    // Both ladders are the owner's, so `has_one = owner` passes for either. Only the seeds tie
    // the rung to its own ladder — and with them its roll policy and its bookkeeping.
    let (s, ladders) = stand(EpochStatus::Settled { paid: 2_000 }, &[1_000, 1_000], RollPolicy::None);

    let mut ix = redeem(&s, ladders[1]);
    let slot = ix
        .accounts
        .iter_mut()
        .find(|meta| meta.pubkey == key(s.env.rung(ladders[1], 0)))
        .expect("the rung is among the accounts");
    slot.pubkey = key(s.env.rung(ladders[0], 0));

    s.env.mollusk.process_and_validate_instruction_chain(
        &[(&ix, &[Check::err(constraint_error(ErrorCode::ConstraintSeeds))])],
        &s.env.accounts,
    );
}

#[test]
fn an_epoch_never_pays_past_what_it_settled_for() {
    // Unreachable through the instructions — `payout` rounds down — so the state is placed by
    // hand: an epoch whose counter already stands one unit below `paid`. The vault holds plenty
    // of other epochs' money, which is exactly why the program must refuse rather than pay.
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: 800 });
    env.seed_market(25, Balances { vault: OTHERS, ..Balances::default() });
    let epoch = env.seed_settled_epoch(
        MATURED,
        800,
        Deposits {
            total_deposited: 1_000,
            total_promised: 1_000,
            status: EpochStatus::Settled { paid: 1_000 },
            redeemed: 999,
            ..Deposits::default()
        },
    );
    let owner = Pubkey::new_unique();
    env.fund(owner);
    let wallet = env.fund_tokens(owner, 0);
    let ladder = env.seed_ladder(owner, 0, RollPolicy::None);
    env.seed_rung(ladder, epoch, 1_000);

    env.mollusk.process_and_validate_instruction_chain(
        &[(
            &env.redeem_rung(owner, ladder, epoch, 0, wallet),
            &[Check::err(anchor_error(LadderError::EpochOverpaid))],
        )],
        &env.accounts,
    );
}
