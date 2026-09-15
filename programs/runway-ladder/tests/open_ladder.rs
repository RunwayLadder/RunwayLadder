//! The ladder and whom it belongs to.
//!
//! What matters here is not the fields but that the ownership check nowhere narrows the
//! account type (FR-020a). A treasury that really has something to place almost certainly
//! signs with a multisig safe, and if the program assumed anywhere that "the owner is a
//! system account", the product would fail precisely for its own buyer.

use anchor_lang::prelude::Pubkey;
use anchor_lang::AccountDeserialize;
use mollusk_svm::result::Check;

use runway_ladder::state::{Ladder, RollPolicy, YieldSource};

mod common;
use common::{constraint_error, key, without_signature, Env, NOW};

/// The market is ready, the ladder is not yet: `expect_created` gives mollusk room for the
/// account the instruction is expected to create.
fn env_for(owner: Pubkey, seed: u64) -> (Env, Pubkey) {
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: 600 });
    let ladder = env.ladder(owner, seed);
    env.fund(owner);
    env.expect_created(ladder);
    (env, ladder)
}

fn decode(result: &mollusk_svm::result::InstructionResult, ladder: Pubkey) -> Ladder {
    let raw = &result.get_account(&key(ladder)).expect("ladder").data;
    Ladder::try_deserialize(&mut &raw[..]).expect("decodes as Ladder")
}

#[test]
fn records_the_owner_market_and_policy() {
    let owner = Pubkey::new_unique();
    let (env, ladder_key) = env_for(owner, 0);

    let result = env.mollusk.process_and_validate_instruction_chain(
        &[
            (&env.init_market(25), &[Check::success()]),
            (&env.open_ladder(owner, 0, RollPolicy::Roll), &[Check::success()]),
        ],
        &env.accounts,
    );

    let ladder = decode(&result, ladder_key);

    assert_eq!(ladder.owner, owner);
    assert_eq!(ladder.market, env.market);
    assert_eq!(ladder.seed, 0);
    assert_eq!(ladder.roll_policy, RollPolicy::Roll);
    assert_eq!(ladder.created_at, NOW);

    // A counter, not a plan: rungs appear in `ladder_deposit`, and
    // rolling adds more — a number declared up front would drift from
    // reality on the very first crank.
    assert_eq!(ladder.rung_count, 0);
}

#[test]
fn a_multisig_safe_owns_a_ladder_by_the_same_path() {
    // A Squads safe is a PDA: no private key exists for this address at all,
    // the signature comes from CPI. If there is an assumption about the account type anywhere
    // in the path, this is where it will fail.
    let safe = Pubkey::find_program_address(&[b"squads-safe"], &Pubkey::new_unique()).0;
    assert!(!safe.is_on_curve(), "the safe must be a PDA, otherwise the test checks nothing");

    let (env, ladder_key) = env_for(safe, 3);

    let result = env.mollusk.process_and_validate_instruction_chain(
        &[
            (&env.init_market(25), &[Check::success()]),
            (&env.open_ladder(safe, 3, RollPolicy::None), &[Check::success()]),
        ],
        &env.accounts,
    );

    let ladder = decode(&result, ladder_key);

    assert_eq!(ladder.owner, safe);
    assert_eq!(ladder.roll_policy, RollPolicy::None);
}

#[test]
fn one_owner_keeps_several_ladders_apart() {
    // A treasury keeps ladders for different budget lines. `seed` tells them apart,
    // and it is what makes two ladders of one owner different accounts.
    let owner = Pubkey::new_unique();
    let (mut env, first_key) = env_for(owner, 0);
    let second_key = env.ladder(owner, 1);
    env.expect_created(second_key);

    assert_ne!(first_key, second_key);

    let result = env.mollusk.process_and_validate_instruction_chain(
        &[
            (&env.init_market(25), &[Check::success()]),
            (&env.open_ladder(owner, 0, RollPolicy::Roll), &[Check::success()]),
            (&env.open_ladder(owner, 1, RollPolicy::None), &[Check::success()]),
        ],
        &env.accounts,
    );

    let first = decode(&result, first_key);
    let second = decode(&result, second_key);

    assert_eq!((first.seed, first.roll_policy), (0, RollPolicy::Roll));
    assert_eq!((second.seed, second.roll_policy), (1, RollPolicy::None));
}

#[test]
fn a_stranger_cannot_open_a_ladder_at_the_owners_address() {
    // FR-020 is held here by the address, not by a check: the owner is part of the seeds,
    // so this address simply cannot be derived from a stranger's key.
    let owner = Pubkey::new_unique();
    let (mut env, ladder_key) = env_for(owner, 0);

    let stranger = Pubkey::new_unique();
    env.fund(stranger);

    env.mollusk.process_and_validate_instruction_chain(
        &[
            (&env.init_market(25), &[Check::success()]),
            (
                &env.open_ladder_at(stranger, ladder_key, 0, RollPolicy::Roll),
                &[Check::err(constraint_error(anchor_lang::error::ErrorCode::ConstraintSeeds))],
            ),
        ],
        &env.accounts,
    );
}

#[test]
fn the_owner_has_to_sign() {
    // The ladder is opened for whoever signed, not for whoever was named:
    // otherwise a stranger could create a ladder for someone else's treasury with a roll
    // policy that treasury never chose.
    let owner = Pubkey::new_unique();
    let (env, _) = env_for(owner, 0);

    env.mollusk.process_and_validate_instruction_chain(
        &[
            (&env.init_market(25), &[Check::success()]),
            (
                &without_signature(env.open_ladder(owner, 0, RollPolicy::Roll), owner),
                &[Check::err(constraint_error(anchor_lang::error::ErrorCode::AccountNotSigner))],
            ),
        ],
        &env.accounts,
    );
}
