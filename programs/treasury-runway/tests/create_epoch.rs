use anchor_lang::prelude::Pubkey;
use anchor_lang::AccountDeserialize;
use mollusk_svm::result::Check;

use treasury_runway::errors::LadderError;
use treasury_runway::state::{Epoch, YieldSource};

mod common;
use common::{anchor_error, key, Env, FUNDED, NOW};

const DAY: i64 = 86_400;

fn env_with_epoch(maturity_ts: i64) -> (Env, Pubkey) {
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: 600 });
    let epoch = env.epoch(maturity_ts);
    env.expect_created(epoch);
    (env, epoch)
}

#[test]
fn records_the_rate_and_who_set_it() {
    let (env, epoch_key) = env_with_epoch(NOW + 90 * DAY);

    let result = env.mollusk.process_and_validate_instruction_chain(
        &[
            (&env.init_market(25), &[Check::success()]),
            (&env.create_epoch(env.authority, NOW + 90 * DAY, 800), &[Check::success()]),
        ],
        &env.accounts,
    );

    let raw = &result.get_account(&key(epoch_key)).expect("epoch").data;
    let epoch = Epoch::try_deserialize(&mut &raw[..]).expect("decodes as Epoch");

    assert_eq!(epoch.market, env.market);
    assert_eq!(epoch.maturity_ts, NOW + 90 * DAY);
    assert_eq!(epoch.rate_bps, 800);

    // FR-010a: the rate is set by a person, so the treasurer must see who exactly and when.
    // If this lived only in the transaction logs, the dashboard would have nothing to show.
    assert_eq!(epoch.created_by, env.authority);
    assert_eq!(epoch.created_at, NOW);

    // The accumulators are empty: there are no rungs yet, and it is their appearance that makes
    // the rate effectively immutable — an instruction to overwrite it does not exist at all.
    assert_eq!(epoch.total_deposited, 0);
    assert_eq!(epoch.total_promised, 0);
}

#[test]
fn rejects_a_maturity_that_has_already_passed() {
    let (env, _) = env_with_epoch(NOW - DAY);

    env.mollusk.process_and_validate_instruction_chain(
        &[
            (&env.init_market(25), &[Check::success()]),
            (
                &env.create_epoch(env.authority, NOW - DAY, 800),
                &[Check::err(anchor_error(LadderError::InvalidMaturity))],
            ),
        ],
        &env.accounts,
    );
}

#[test]
fn rejects_a_maturity_exactly_at_now() {
    let (env, _) = env_with_epoch(NOW);

    env.mollusk.process_and_validate_instruction_chain(
        &[
            (&env.init_market(25), &[Check::success()]),
            (
                &env.create_epoch(env.authority, NOW, 800),
                &[Check::err(anchor_error(LadderError::InvalidMaturity))],
            ),
        ],
        &env.accounts,
    );
}

#[test]
fn rejects_a_signer_who_is_not_the_market_operator() {
    let maturity = NOW + 90 * DAY;
    let (mut env, _) = env_with_epoch(maturity);

    let stranger = Pubkey::new_unique();
    let system = mollusk_svm::program::keyed_account_for_system_program();
    env.accounts.push((key(stranger), solana_account::Account::new(FUNDED, 0, &system.0)));

    env.mollusk.process_and_validate_instruction_chain(
        &[
            (&env.init_market(25), &[Check::success()]),
            (
                &env.create_epoch(stranger, maturity, 800),
                &[Check::err(anchor_error(LadderError::NotMarketAuthority))],
            ),
        ],
        &env.accounts,
    );
}
