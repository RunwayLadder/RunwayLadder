use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::AccountDeserialize;
use anchor_spl::token::spl_token;
use mollusk_svm::result::Check;

use runway_ladder::errors::LadderError;
use runway_ladder::state::{Market, YieldSource};

mod common;
use common::{anchor_error, key, Env};

#[test]
fn creates_a_market_with_its_own_vault_and_buffer() {
    let mut env = Env::new(YieldSource::Deterministic { rate_bps: 600 });
    env.min_rung_amount = 100_000_000;

    let result = env.mollusk.process_and_validate_instruction(
        &env.init_market(25),
        &env.accounts,
        &[Check::success()],
    );

    let raw = &result.get_account(&key(env.market)).expect("market").data;
    let market = Market::try_deserialize(&mut &raw[..]).expect("decodes as Market");

    assert_eq!(market.authority, env.authority);
    assert_eq!(market.asset_mint, env.asset_mint);
    assert_eq!(market.fee_bps, 25);

    // The minimum rung size is set by the market operator, not by the treasurer in a
    // deposit parameter: a minimum the constrained party sets for itself
    // constrains nothing (FR-006).
    assert_eq!(market.min_rung_amount, 100_000_000);
    assert_eq!(market.source, YieldSource::Deterministic { rate_bps: 600 });
    assert_eq!(market.vault, env.vault);
    assert_eq!(market.buffer_vault, env.buffer_vault);

    // The vault and the buffer are different accounts, and that is not cosmetic: the buffer
    // is the second step of the waterfall, so mixing it with treasury deposits would mean
    // covering a shortfall with their own funds.
    assert_ne!(market.vault, market.buffer_vault);

    for (name, pubkey) in [("vault", env.vault), ("buffer", env.buffer_vault)] {
        let account = result.get_account(&key(pubkey)).unwrap_or_else(|| panic!("{name}"));
        let token = spl_token::state::Account::unpack(&account.data)
            .unwrap_or_else(|_| panic!("{name} is not a token account"));

        assert_eq!(token.mint, env.asset_mint, "{name}: mint");
        assert_eq!(token.owner, env.market, "{name}: controlled by the market, not the operator");
        assert_eq!(token.amount, 0, "{name}");
    }
}

#[test]
fn rejects_a_fee_above_the_whole_amount() {
    let env = Env::new(YieldSource::Deterministic { rate_bps: 600 });

    env.mollusk.process_and_validate_instruction(
        &env.init_market(10_001),
        &env.accounts,
        &[Check::err(anchor_error(LadderError::InvalidFeeBps))],
    );
}
