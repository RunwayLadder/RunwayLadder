//! The Kamino adapter (`source::kamino`, T046): the ladder's principal works in Kamino's USDC
//! reserve through CPI, and settlement pays out of what comes back.
//!
//! Every instruction here is real, on real klend over the T045 snapshot — no state is seeded by
//! hand but the treasurer's wallet. A matured epoch is reached the way the chain reaches it: by
//! moving the clock between instructions.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::AccountMeta;
use mollusk_svm::result::ProgramResult;

use runway_ladder::errors::LadderError;
use runway_ladder::math::Distribution;
use runway_ladder::state::{Epoch, EpochStatus, RollPolicy, Rung, RungStatus, YieldSource};

mod common;
use common::kamino::{with_accounts, KaminoEnv, DAY};
use common::{anchor_error, budget_instructions, signed_size, Balances, Deposits, Env, MAX_CU, PACKET_BYTES};

const FEE_BPS: u16 = 25;
/// 2 × 1 000 USDC: small enough to stay far from the reserve's deposit and withdrawal caps.
const AMOUNT: u64 = 2_000_000_000;

struct Stand {
    k: KaminoEnv,
    owner: Pubkey,
    ladder: Pubkey,
    wallet: Pubkey,
    /// Maturities of the two epochs, 30 and 60 days out.
    near: i64,
    far: i64,
}

/// A Kamino market with two epochs at `rate_bps`, and a ladder under `policy` that has put
/// `AMOUNT` into both of them evenly.
fn deposited(rate_bps: u16, policy: RollPolicy) -> Stand {
    let mut k = KaminoEnv::new();
    let init = with_accounts(k.env.init_market(FEE_BPS), &k.init_accounts());
    k.run(&init);

    let near = k.now + 30 * DAY;
    let far = k.now + 60 * DAY;
    for maturity in [near, far] {
        let epoch = k.env.epoch(maturity);
        k.env.expect_created(epoch);
        let ix = k.env.create_epoch(k.env.authority, maturity, rate_bps);
        k.run(&ix);
    }

    let owner = Pubkey::new_unique();
    k.env.fund(owner);
    let wallet = k.env.fund_tokens(owner, AMOUNT);
    let ladder = k.env.ladder(owner, 0);
    k.env.expect_created(ladder);
    let ix = k.env.open_ladder(owner, 0, policy);
    k.run(&ix);

    for index in 0..2 {
        let rung = k.env.rung(ladder, index);
        k.env.expect_created(rung);
    }
    let ix = k.env.ladder_deposit(owner, 0, wallet, AMOUNT, Distribution::Even { rungs: 2 }, &[near, far]);
    let ix = with_accounts(ix, &k.source_accounts());
    let result = k.run(&ix);
    println!("ladder_deposit, 2 rungs into Kamino: {} CU", result.compute_units_consumed);

    Stand { k, owner, ladder, wallet, near, far }
}

fn settle(s: &mut Stand, maturity: i64) {
    let ix = with_accounts(s.k.env.settle_epoch(maturity), &s.k.source_accounts());
    let result = s.k.run(&ix);
    println!("settle_epoch from Kamino: {} CU", result.compute_units_consumed);
}

fn expect_error(k: &mut KaminoEnv, ix: &common::svm::Instruction, code: LadderError) {
    let result = k.try_run(ix);
    assert_eq!(result.program_result, ProgramResult::Failure(anchor_error(code)));
}

#[test]
fn init_market_creates_the_markets_ktoken_account() {
    let mut k = KaminoEnv::new();
    let ix = with_accounts(k.env.init_market(FEE_BPS), &k.init_accounts());
    k.run(&ix);

    let (_, account) = k
        .env
        .accounts
        .iter()
        .find(|(a, _)| *a == common::key(k.collateral))
        .expect("the collateral account");
    use anchor_lang::solana_program::program_pack::Pack;
    let token = anchor_spl::token::spl_token::state::Account::unpack(&account.data)
        .expect("an SPL token account");
    assert_eq!(token.mint, k.snap.collateral_mint);
    assert_eq!(token.owner, k.env.market, "the market, and only the market, holds the kTokens");
    assert_eq!(token.amount, 0);
}

#[test]
fn init_market_refuses_a_reserve_other_than_the_pinned_one() {
    let mut k = KaminoEnv::new();
    let mut accounts = k.init_accounts();
    // A real account of the right owner would be the subtle case; any key but the pinned one
    // must already be refused.
    accounts[0] = AccountMeta::new_readonly(k.snap.lending_market, false);
    let ix = with_accounts(k.env.init_market(FEE_BPS), &accounts);
    expect_error(&mut k, &ix, LadderError::SourceAccountsMismatch);
}

#[test]
fn init_market_refuses_a_collateral_mint_that_is_not_the_reserves() {
    let mut k = KaminoEnv::new();
    let mut accounts = k.init_accounts();
    accounts[1] = AccountMeta::new_readonly(k.snap.usdc_mint, false);
    let ix = with_accounts(k.env.init_market(FEE_BPS), &accounts);
    expect_error(&mut k, &ix, LadderError::SourceAccountsMismatch);
}

#[test]
fn init_market_on_kamino_refuses_to_go_without_its_accounts() {
    let mut k = KaminoEnv::new();
    let ix = k.env.init_market(FEE_BPS);
    expect_error(&mut k, &ix, LadderError::SourceAccountsMismatch);
}

#[test]
fn a_deposit_puts_the_principal_to_work_in_kamino() {
    let s = deposited(300, RollPolicy::None);
    let k = &s.k;

    let near: Epoch = k.state(k.env.epoch(s.near));
    let far: Epoch = k.state(k.env.epoch(s.far));
    assert!(near.source_shares > 0 && far.source_shares > 0);
    // The kTokens of both epochs, and nothing else, sit in the market's account.
    assert_eq!(k.balance(k.collateral), near.source_shares + far.source_shares);
    // A kToken is worth more than a unit of USDC, so fewer of them were issued.
    assert!(near.source_shares < near.total_deposited);

    // What is left in the vault is what whole kTokens could not cover — at most a unit per rung.
    let vault = k.balance(k.env.vault);
    assert!(vault <= 2, "{vault} left in the vault");
    assert_eq!(k.balance(s.wallet), 0);
}

#[test]
fn settlement_redeems_the_epochs_ktokens_and_pays_the_promise() {
    // 3 % a year against Kamino's ≈ 4 % at the snapshot: the source covers the promise.
    let mut s = deposited(300, RollPolicy::None);
    let buffer_before = s.k.balance(s.k.env.buffer_vault);
    let far_shares = s.k.state::<Epoch>(s.k.env.epoch(s.far)).source_shares;

    s.k.warp(30);
    let near = s.near;
    settle(&mut s, near);

    let epoch: Epoch = s.k.state(s.k.env.epoch(s.near));
    assert_eq!(epoch.status, EpochStatus::Settled { paid: epoch.total_promised });
    // The near epoch's kTokens were redeemed, the far epoch's stay at work.
    assert_eq!(s.k.balance(s.k.collateral), far_shares);
    // What Kamino paid above the promise is the protocol's margin (FR-011b).
    assert!(s.k.balance(s.k.env.buffer_vault) > buffer_before, "no surplus reached the buffer");

    // The vault holds exactly the epoch's payout, plus the deposit dust.
    let vault = s.k.balance(s.k.env.vault);
    assert!(vault >= epoch.total_promised && vault - epoch.total_promised <= 2, "vault {vault}");

    let rung: Rung = s.k.state(s.k.env.rung(s.ladder, 0));
    let ix = s.k.env.redeem_rung(s.owner, s.ladder, s.k.env.epoch(s.near), 0, s.wallet);
    s.k.run(&ix);
    assert_eq!(s.k.balance(s.wallet), rung.promised, "the treasurer gets the promise at par");
}

#[test]
fn a_promise_above_kaminos_rate_settles_with_a_deficit() {
    // 15 % a year: the 5 USDC of fees in the buffer cannot cover what Kamino did not earn.
    let mut s = deposited(1_500, RollPolicy::None);
    s.k.warp(30);
    let near = s.near;
    settle(&mut s, near);

    let epoch: Epoch = s.k.state(s.k.env.epoch(s.near));
    let EpochStatus::SettledWithDeficit { paid, deficit } = epoch.status else {
        panic!("expected a deficit, got {:?}", epoch.status);
    };
    assert_eq!(paid + deficit, epoch.total_promised);
    // More than the principal came back — the deficit is the promise, not a loss.
    assert!(paid > epoch.total_deposited);
    assert_eq!(s.k.balance(s.k.env.buffer_vault), 0, "the buffer is spent before any haircut");

    let ix = s.k.env.redeem_rung(s.owner, s.ladder, s.k.env.epoch(s.near), 0, s.wallet);
    s.k.run(&ix);
    let rung: Rung = s.k.state(s.k.env.rung(s.ladder, 0));
    assert!(matches!(rung.status, RungStatus::RedeemedWithDeficit { .. }), "{:?}", rung.status);
}

#[test]
fn settlement_refuses_ktokens_held_anywhere_but_the_markets_account() {
    let mut s = deposited(300, RollPolicy::None);
    s.k.warp(30);

    // The treasurer's own wallet in place of the market's kToken account.
    let mut accounts = s.k.source_accounts();
    accounts[7] = AccountMeta::new(s.wallet, false);
    let ix = with_accounts(s.k.env.settle_epoch(s.near), &accounts);
    expect_error(&mut s.k, &ix, LadderError::SourceAccountsMismatch);

    // And without the source's accounts at all.
    let ix = s.k.env.settle_epoch(s.near);
    expect_error(&mut s.k, &ix, LadderError::SourceAccountsMismatch);
}

#[test]
fn rolling_puts_the_payout_back_into_kamino() {
    let mut s = deposited(300, RollPolicy::Roll);
    let far_before: Epoch = s.k.state(s.k.env.epoch(s.far));

    s.k.warp(30);
    let near = s.near;
    settle(&mut s, near);

    let keeper = Pubkey::new_unique();
    s.k.env.fund(keeper);
    let new_rung = s.k.env.rung(s.ladder, 2);
    s.k.env.expect_created(new_rung);
    let ix = s.k.env.roll_rung(keeper, s.ladder, s.k.env.epoch(s.near), 0, s.k.env.epoch(s.far));
    let ix = with_accounts(ix, &s.k.source_accounts());
    let result = s.k.run(&ix);
    println!("roll_rung into Kamino: {} CU", result.compute_units_consumed);

    let far: Epoch = s.k.state(s.k.env.epoch(s.far));
    let rolled: Rung = s.k.state(new_rung);
    assert_eq!(far.total_deposited, far_before.total_deposited + rolled.deposited);
    assert!(far.source_shares > far_before.source_shares, "the rolled money is not in Kamino");
    // Everything at work is the far epoch's, rolled money included.
    assert_eq!(s.k.balance(s.k.collateral), far.source_shares);
    // The vault keeps only dust: the payout went back to work, the fee to the buffer.
    let vault = s.k.balance(s.k.env.vault);
    assert!(vault <= 3, "{vault} left in the vault");
}

/// The deterministic market takes no source accounts, and refuses any: a client that confuses
/// the two markets is told so, rather than having its extra accounts ignored.
#[test]
fn a_deterministic_market_refuses_source_accounts() {
    let rate_bps = 800;
    let mut env = Env::new(YieldSource::Deterministic { rate_bps });
    let maturity = common::NOW - DAY;
    env.seed_market(0, Balances { vault: 1_000_000_000, ..Balances::default() });
    env.seed_settled_epoch(maturity, rate_bps, Deposits::single(1_000_000_000, rate_bps, 30 * DAY));

    let extra = [AccountMeta::new_readonly(Pubkey::new_unique(), false)];
    let ix = with_accounts(env.settle_epoch(maturity), &extra);
    let mut accounts = env.accounts.clone();
    accounts.push((common::key(extra[0].pubkey), solana_account::Account::default()));
    let result = env.mollusk.process_instruction(&ix, &accounts);
    assert_eq!(
        result.program_result,
        ProgramResult::Failure(anchor_error(LadderError::SourceAccountsMismatch))
    );
}

/// How many rungs a Kamino deposit fits in one signature. Lower than the deterministic
/// market's 11 (`deposit_limits.rs`): the reserve route adds nine accounts to the message, and
/// those bytes come out of the same 1232-byte packet. A lock like that one — if the source's
/// account set changes, this turns red instead of the dashboard.
const KAMINO_CEILING: usize = 7;

/// A Kamino market with `rungs` epochs and an open ladder, and the deposit into all of them.
fn kamino_ladder(rungs: usize) -> (KaminoEnv, Pubkey, common::svm::Instruction) {
    let mut k = KaminoEnv::new();
    let init = with_accounts(k.env.init_market(FEE_BPS), &k.init_accounts());
    k.run(&init);

    let maturities: Vec<i64> = (1..=rungs).map(|i| k.now + (i as i64) * 30 * DAY).collect();
    for maturity in &maturities {
        let epoch = k.env.epoch(*maturity);
        k.env.expect_created(epoch);
        let ix = k.env.create_epoch(k.env.authority, *maturity, 300);
        k.run(&ix);
    }

    let owner = Pubkey::new_unique();
    k.env.fund(owner);
    let amount = rungs as u64 * 1_000_000_000;
    let wallet = k.env.fund_tokens(owner, amount);
    let ladder = k.env.ladder(owner, 0);
    k.env.expect_created(ladder);
    let ix = k.env.open_ladder(owner, 0, RollPolicy::None);
    k.run(&ix);
    for index in 0..rungs as u32 {
        let rung = k.env.rung(ladder, index);
        k.env.expect_created(rung);
    }

    let distribution = Distribution::Even { rungs: rungs as u8 };
    let ix = k.env.ladder_deposit(owner, 0, wallet, amount, distribution, &maturities);
    let ix = with_accounts(ix, &k.source_accounts());
    (k, owner, ix)
}

/// The first deposit opens the ladder in the same signature (`buildLadderSetup`), and that
/// costs `open_ladder`'s own bytes — which, at 2 bytes of headroom, is a rung.
const KAMINO_SETUP_CEILING: usize = 6;

fn kamino_deposit_bytes(rungs: usize, opens_ladder: bool) -> usize {
    let (k, owner, deposit) = kamino_ladder(rungs);
    let mut instructions = budget_instructions();
    if opens_ladder {
        instructions.push(k.env.open_ladder(owner, 0, RollPolicy::None));
    }
    instructions.push(deposit);
    signed_size(&instructions, owner)
}

#[test]
fn seven_rungs_or_six_with_the_ladder_opened_is_the_kamino_ceiling() {
    for (ceiling, opens_ladder) in [(KAMINO_CEILING, false), (KAMINO_SETUP_CEILING, true)] {
        let at = kamino_deposit_bytes(ceiling, opens_ladder);
        let over = kamino_deposit_bytes(ceiling + 1, opens_ladder);
        println!(
            "Kamino deposit, opens ladder {opens_ladder}: {ceiling} rungs {at} bytes, {} rungs {over} bytes",
            ceiling + 1
        );
        assert!(at <= PACKET_BYTES, "{ceiling} rungs must fit: {at} bytes");
        assert!(over > PACKET_BYTES, "{} rungs fit — the ceiling has risen", ceiling + 1);
    }
}

#[test]
fn the_kamino_ceiling_ladder_stays_within_the_compute_cap() {
    let (mut k, _, deposit) = kamino_ladder(KAMINO_CEILING);
    let used = k.run(&deposit).compute_units_consumed;
    println!("Kamino deposit of {KAMINO_CEILING} rungs: {used} CU");
    assert!(used < MAX_CU, "{used} of {MAX_CU}");
}
