//! The Kamino snapshot in `fixtures/kamino/` is enough to run Kamino (T045).
//!
//! Real klend — the mainnet binary, verified against Kamino's own build — over the mainnet
//! accounts of the USDC reserve, with nothing fetched at run time. Two things are shown:
//!
//! - the reserve route works on the snapshot as it is: USDC goes in, kTokens come out, and
//!   redeeming them at the same slot returns the deposit. If a needed account were missing
//!   from the snapshot, this is where it would fail;
//! - interest accrues when the clock moves. That is what the Kamino adapter's `accrued` will
//!   be built on (T046), and a snapshot on which the exchange rate stood still would make
//!   every fork run look like a zero-rate source.
//!
//! The clock starts at the snapshot's slot, not at zero: the reserve remembers the slot it
//! was last refreshed at, and klend subtracts it from the current one.

mod common;

use std::path::PathBuf;

use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token::spl_token;
use base64::Engine;
use common::{key, svm};
use mollusk_svm::program::loader_keys::LOADER_V3;
use mollusk_svm::result::{InstructionResult, ProgramResult};
use mollusk_svm::Mollusk;
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_account::Account;

const KLEND: svm::Pubkey = svm::Pubkey::from_str_const("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const INSTRUCTIONS_SYSVAR: svm::Pubkey =
    svm::Pubkey::from_str_const("Sysvar1nstructions1111111111111111111111111");

/// 1 000 USDC: small enough to stay far from the reserve's deposit and withdrawal caps.
const AMOUNT: u64 = 1_000_000_000;
const SLOTS_PER_DAY: u64 = 216_000;
const DAY: i64 = 86_400;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/kamino")
}

fn read_json(name: &str) -> Value {
    let path = fixtures().join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).expect("valid JSON")
}

fn pubkey(v: &Value) -> svm::Pubkey {
    svm::Pubkey::from_str_const(v.as_str().expect("a base58 string"))
}

/// One file in the `solana account --output json` format, as `solana-test-validator --account`
/// would read it.
fn load_account(file: &str) -> (svm::Pubkey, Account) {
    let json = read_json(file);
    let a = &json["account"];
    let data = base64::engine::general_purpose::STANDARD
        .decode(a["data"][0].as_str().expect("base64 data"))
        .expect("valid base64");
    let account = Account {
        lamports: a["lamports"].as_u64().expect("lamports"),
        data,
        owner: pubkey(&a["owner"]),
        executable: a["executable"].as_bool().expect("executable"),
        rent_epoch: a["rentEpoch"].as_u64().expect("rentEpoch"),
    };
    (pubkey(&json["pubkey"]), account)
}

fn token_account(mint: svm::Pubkey, owner: svm::Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; spl_token::state::Account::LEN];
    spl_token::state::Account {
        mint: anchor_lang::prelude::Pubkey::new_from_array(mint.to_bytes()),
        owner: anchor_lang::prelude::Pubkey::new_from_array(owner.to_bytes()),
        amount,
        state: spl_token::state::AccountState::Initialized,
        ..Default::default()
    }
    .pack_into_slice(&mut data);
    Account { lamports: 2_039_280, data, owner: key(spl_token::ID), executable: false, rent_epoch: 0 }
}

fn amount_of(result: &InstructionResult, account: &svm::Pubkey) -> u64 {
    let raw = &result.get_account(account).expect("token account in the result").data;
    spl_token::state::Account::unpack(raw).expect("SPL token account").amount
}

/// Anchor's global instruction discriminator followed by one `u64` argument.
fn ix_data(name: &str, arg: u64) -> Vec<u8> {
    let hash = Sha256::digest(format!("global:{name}").as_bytes());
    let mut data = hash[..8].to_vec();
    data.extend_from_slice(&arg.to_le_bytes());
    data
}

struct Fork {
    mollusk: Mollusk,
    accounts: Vec<(svm::Pubkey, Account)>,
    market: svm::Pubkey,
    authority: svm::Pubkey,
    reserve: svm::Pubkey,
    supply: svm::Pubkey,
    collateral_mint: svm::Pubkey,
    usdc_mint: svm::Pubkey,
    owner: svm::Pubkey,
    user_usdc: svm::Pubkey,
    user_ktokens: svm::Pubkey,
    slot: u64,
    block_time: i64,
}

impl Fork {
    fn new() -> Self {
        let manifest = read_json("manifest.json");
        let elf = std::fs::read(fixtures().join(manifest["klend"]["file"].as_str().unwrap()))
            .expect("klend.so");

        let mut mollusk = Mollusk::default();
        mollusk.add_program_with_loader_and_elf(&KLEND, &LOADER_V3, &elf);
        mollusk_svm_programs_token::token::add_program(&mut mollusk);

        let mut accounts: Vec<_> = manifest["accounts"]
            .as_array()
            .expect("accounts")
            .iter()
            .map(|a| load_account(a["file"].as_str().expect("file")))
            .collect();
        let find = |name: &str| {
            let entry = manifest["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["name"] == name)
                .unwrap_or_else(|| panic!("{name} in the manifest"));
            pubkey(&entry["pubkey"])
        };

        let usdc_mint = find("usdc-mint");
        let collateral_mint = find("usdc-reserve-collateral-mint");
        let owner = svm::Pubkey::new_unique();
        let user_usdc = svm::Pubkey::new_unique();
        let user_ktokens = svm::Pubkey::new_unique();
        let system = mollusk_svm::program::keyed_account_for_system_program();
        accounts.extend([
            (owner, Account::new(1_000_000_000, 0, &system.0)),
            (user_usdc, token_account(usdc_mint, owner, AMOUNT)),
            (user_ktokens, token_account(collateral_mint, owner, 0)),
            mollusk_svm_programs_token::token::keyed_account(),
            system,
        ]);

        let mut fork = Fork {
            mollusk,
            accounts,
            market: find("lending-market"),
            authority: find("lending-market-authority"),
            reserve: find("usdc-reserve"),
            supply: find("usdc-reserve-liquidity-supply"),
            collateral_mint,
            usdc_mint,
            owner,
            user_usdc,
            user_ktokens,
            slot: manifest["slot"].as_u64().expect("slot"),
            block_time: manifest["blockTime"].as_i64().expect("blockTime"),
        };
        fork.warp(0);
        fork
    }

    /// `warp_to_slot` rebuilds the clock from defaults, so the time is set after it.
    fn warp(&mut self, days: u64) {
        self.mollusk.warp_to_slot(self.slot + days * SLOTS_PER_DAY);
        self.mollusk.sysvars.clock.unix_timestamp = self.block_time + days as i64 * DAY;
    }

    fn run(&mut self, ix: svm::Instruction) -> InstructionResult {
        let result = self.mollusk.process_instruction(&ix, &self.accounts);
        assert!(
            matches!(result.program_result, ProgramResult::Success),
            "{:?}",
            result.program_result
        );
        for (k, a) in &result.resulting_accounts {
            if let Some(slot) = self.accounts.iter_mut().find(|(key, _)| key == k) {
                slot.1 = a.clone();
            }
        }
        result
    }

    fn deposit(&mut self, amount: u64) -> InstructionResult {
        use svm::AccountMeta as M;
        let ix = svm::Instruction {
            program_id: KLEND,
            accounts: vec![
                M::new_readonly(self.owner, true),
                M::new(self.reserve, false),
                M::new_readonly(self.market, false),
                M::new_readonly(self.authority, false),
                M::new_readonly(self.usdc_mint, false),
                M::new(self.supply, false),
                M::new(self.collateral_mint, false),
                M::new(self.user_usdc, false),
                M::new(self.user_ktokens, false),
                M::new_readonly(key(spl_token::ID), false),
                M::new_readonly(key(spl_token::ID), false),
                M::new_readonly(INSTRUCTIONS_SYSVAR, false),
            ],
            data: ix_data("deposit_reserve_liquidity", amount),
        };
        self.run(ix)
    }

    fn redeem(&mut self, ktokens: u64) -> InstructionResult {
        use svm::AccountMeta as M;
        let ix = svm::Instruction {
            program_id: KLEND,
            accounts: vec![
                M::new_readonly(self.owner, true),
                M::new_readonly(self.market, false),
                M::new(self.reserve, false),
                M::new_readonly(self.authority, false),
                M::new_readonly(self.usdc_mint, false),
                M::new(self.collateral_mint, false),
                M::new(self.supply, false),
                M::new(self.user_ktokens, false),
                M::new(self.user_usdc, false),
                M::new_readonly(key(spl_token::ID), false),
                M::new_readonly(key(spl_token::ID), false),
                M::new_readonly(INSTRUCTIONS_SYSVAR, false),
            ],
            data: ix_data("redeem_reserve_collateral", ktokens),
        };
        self.run(ix)
    }
}

#[test]
fn deposit_and_redeem_at_the_snapshot_slot_return_the_deposit() {
    let mut fork = Fork::new();

    let deposited = fork.deposit(AMOUNT);
    let ktokens = amount_of(&deposited, &fork.user_ktokens);
    // klend takes only what whole kTokens cover, not what was asked: the remainder stays
    // with the depositor. The Kamino adapter (T046) has to count what left the vault, never
    // the requested amount — the difference is real, if tiny.
    let spent = AMOUNT - amount_of(&deposited, &fork.user_usdc);
    assert!(spent <= AMOUNT && AMOUNT - spent <= 1, "spent {spent} of {AMOUNT}");
    assert!(ktokens > 0 && ktokens < spent, "a kToken is worth more than 1 USDC: {ktokens}");
    println!(
        "deposit: asked {AMOUNT}, spent {spent} → {ktokens} kTokens, {} CU",
        deposited.compute_units_consumed
    );

    let redeemed = fork.redeem(ktokens);
    let back = amount_of(&redeemed, &fork.user_usdc) - (AMOUNT - spent);
    // Redeeming rounds down in the reserve's favour too: nothing is gained at the same slot,
    // and at most a unit is lost.
    assert!(back <= spent && spent - back <= 1, "got back {back} of {spent}");
    assert_eq!(amount_of(&redeemed, &fork.user_ktokens), 0);
    println!("redeem: {ktokens} kTokens → {back}, {} CU", redeemed.compute_units_consumed);
}

#[test]
fn interest_accrues_when_the_clock_moves() {
    let mut fork = Fork::new();
    let ktokens = amount_of(&fork.deposit(AMOUNT), &fork.user_ktokens);

    fork.warp(30);
    // The whole wallet, the undeposited remainder included: what the depositor had before
    // against what it has after.
    let back = amount_of(&fork.redeem(ktokens), &fork.user_usdc);

    let gained = back.checked_sub(AMOUNT).expect("redeemed less than deposited after 30 days");
    // Annualised just to make the number readable next to Kamino's own APY; the assertion
    // is only that it is positive and not absurd for a USDC lending rate.
    let apy_bps = gained as u128 * 10_000 * 365 / 30 / AMOUNT as u128;
    println!("30 days: {AMOUNT} → {back} (+{gained}, ≈{apy_bps} bps a year)");
    assert!(gained > 0, "the exchange rate did not move");
    assert!(apy_bps < 5_000, "{apy_bps} bps a year is not a USDC lending rate");
}
