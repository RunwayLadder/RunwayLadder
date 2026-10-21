//! The Kamino snapshot of `fixtures/kamino/` (T045), loaded into mollusk.
//!
//! Real klend — the mainnet binary, verified against Kamino's own build — over the mainnet
//! accounts of the USDC reserve, with nothing fetched at run time. The clock starts at the
//! snapshot's slot, not at zero: the reserve remembers the slot it was last refreshed at, and
//! klend subtracts it from the current one.

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::AccountMeta;
use base64::Engine;
use mollusk_svm::program::loader_keys::LOADER_V3;
use mollusk_svm::result::{InstructionResult, ProgramResult};
use mollusk_svm::Mollusk;
use runway_ladder::source::kamino::{collateral_address, KLEND};
use runway_ladder::state::YieldSource;
use serde_json::Value;
use solana_account::Account;

use super::{key, svm, Env};

pub const SLOTS_PER_DAY: u64 = 216_000;
pub const DAY: i64 = 86_400;

const INSTRUCTIONS_SYSVAR: Pubkey =
    Pubkey::from_str_const("Sysvar1nstructions1111111111111111111111111");

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/kamino")
}

pub fn read_json(name: &str) -> Value {
    let path = fixtures().join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).expect("valid JSON")
}

fn pubkey(v: &Value) -> Pubkey {
    Pubkey::from_str_const(v.as_str().expect("a base58 string"))
}

/// One file in the `solana account --output json` format, as `solana-test-validator --account`
/// would read it.
fn load_account(file: &str) -> (Pubkey, Account) {
    let json = read_json(file);
    let a = &json["account"];
    let data = base64::engine::general_purpose::STANDARD
        .decode(a["data"][0].as_str().expect("base64 data"))
        .expect("valid base64");
    let account = Account {
        lamports: a["lamports"].as_u64().expect("lamports"),
        data,
        owner: key(pubkey(&a["owner"])),
        executable: a["executable"].as_bool().expect("executable"),
        rent_epoch: a["rentEpoch"].as_u64().expect("rentEpoch"),
    };
    (pubkey(&json["pubkey"]), account)
}

/// The snapshot: klend's binary, its accounts, and where in time they were taken.
pub struct Snapshot {
    pub elf: Vec<u8>,
    pub accounts: Vec<(Pubkey, Account)>,
    pub lending_market: Pubkey,
    pub authority: Pubkey,
    pub reserve: Pubkey,
    pub supply: Pubkey,
    pub collateral_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub slot: u64,
    pub block_time: i64,
}

impl Snapshot {
    pub fn load() -> Self {
        let manifest = read_json("manifest.json");
        let elf = std::fs::read(fixtures().join(manifest["klend"]["file"].as_str().unwrap()))
            .expect("klend.so");
        let entries = manifest["accounts"].as_array().expect("accounts");
        let find = |name: &str| {
            let entry = entries
                .iter()
                .find(|a| a["name"] == name)
                .unwrap_or_else(|| panic!("{name} in the manifest"));
            pubkey(&entry["pubkey"])
        };

        Snapshot {
            elf,
            accounts: entries.iter().map(|a| load_account(a["file"].as_str().expect("file"))).collect(),
            lending_market: find("lending-market"),
            authority: find("lending-market-authority"),
            reserve: find("usdc-reserve"),
            supply: find("usdc-reserve-liquidity-supply"),
            collateral_mint: find("usdc-reserve-collateral-mint"),
            usdc_mint: find("usdc-mint"),
            slot: manifest["slot"].as_u64().expect("slot"),
            block_time: manifest["blockTime"].as_i64().expect("blockTime"),
        }
    }

    pub fn add_klend(&self, mollusk: &mut Mollusk) {
        mollusk.add_program_with_loader_and_elf(&key(KLEND), &LOADER_V3, &self.elf);
    }

    /// `warp_to_slot` rebuilds the clock from defaults, so the time is set after it.
    pub fn warp(&self, mollusk: &mut Mollusk, days: u64) {
        mollusk.warp_to_slot(self.slot + days * SLOTS_PER_DAY);
        mollusk.sysvars.clock.unix_timestamp = self.block_time + days as i64 * DAY;
    }
}

/// The ladder's stand over a Kamino market for the snapshot's USDC reserve.
pub struct KaminoEnv {
    pub env: Env,
    pub snap: Snapshot,
    /// The market's kToken account, `["collateral", market]`.
    pub collateral: Pubkey,
    /// The unix time the clock stands at — what `now` is to the program in these tests.
    pub now: i64,
}

impl KaminoEnv {
    pub fn new() -> Self {
        let snap = Snapshot::load();
        let mut env = Env::with_mint(YieldSource::Kamino { reserve: snap.reserve }, snap.usdc_mint);
        snap.add_klend(&mut env.mollusk);
        // klend is an account of the ladder's instructions now, not only the program a test
        // calls, so mollusk needs it among the accounts as well.
        env.accounts.push((
            key(KLEND),
            mollusk_svm::program::create_program_account_loader_v3(&key(KLEND)),
        ));
        for (address, account) in &snap.accounts {
            env.put(*address, account.clone());
        }
        let collateral = collateral_address(&env.market).0;
        env.expect_created(collateral);
        snap.warp(&mut env.mollusk, 0);
        let now = snap.block_time;
        KaminoEnv { env, snap, collateral, now }
    }

    pub fn warp(&mut self, days: u64) {
        self.snap.warp(&mut self.env.mollusk, days);
        self.now = self.snap.block_time + days as i64 * DAY;
    }

    /// What `init_market` takes for Kamino: the reserve, its kToken mint, the account to create.
    pub fn init_accounts(&self) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(self.snap.reserve, false),
            AccountMeta::new_readonly(self.snap.collateral_mint, false),
            AccountMeta::new(self.collateral, false),
        ]
    }

    /// The reserve route's nine, in the order `source::kamino` documents.
    pub fn source_accounts(&self) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(KLEND, false),
            AccountMeta::new_readonly(self.snap.lending_market, false),
            AccountMeta::new_readonly(self.snap.authority, false),
            AccountMeta::new(self.snap.reserve, false),
            AccountMeta::new_readonly(self.snap.usdc_mint, false),
            AccountMeta::new(self.snap.supply, false),
            AccountMeta::new(self.snap.collateral_mint, false),
            AccountMeta::new(self.collateral, false),
            AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR, false),
        ]
    }

    /// Runs one instruction against the stand and keeps its result as the new state — the
    /// clock has to move between instructions here, so a single chain will not do.
    pub fn run(&mut self, ix: &svm::Instruction) -> InstructionResult {
        let result = self.try_run(ix);
        assert!(matches!(result.program_result, ProgramResult::Success), "{:?}", result.program_result);
        result
    }

    /// The same, for an instruction expected to fail: nothing is kept.
    pub fn try_run(&mut self, ix: &svm::Instruction) -> InstructionResult {
        let result = self.env.mollusk.process_instruction(ix, &self.env.accounts);
        if matches!(result.program_result, ProgramResult::Success) {
            for (k, a) in &result.resulting_accounts {
                if let Some(slot) = self.env.accounts.iter_mut().find(|(key, _)| key == k) {
                    slot.1 = a.clone();
                }
            }
        }
        result
    }

    /// A token balance as the stand holds it now.
    pub fn balance(&self, token: Pubkey) -> u64 {
        use anchor_lang::solana_program::program_pack::Pack;
        let (_, account) = self
            .env
            .accounts
            .iter()
            .find(|(k, _)| *k == key(token))
            .unwrap_or_else(|| panic!("{token} in the stand"));
        anchor_spl::token::spl_token::state::Account::unpack(&account.data)
            .expect("SPL token account")
            .amount
    }

    /// A program account as the stand holds it now.
    pub fn state<T: anchor_lang::AccountDeserialize>(&self, address: Pubkey) -> T {
        let (_, account) = self
            .env
            .accounts
            .iter()
            .find(|(k, _)| *k == key(address))
            .unwrap_or_else(|| panic!("{address} in the stand"));
        T::try_deserialize(&mut &account.data[..]).expect("decodes as the expected account")
    }
}

/// Appends accounts to an already built instruction — the source's tail of `remaining_accounts`.
pub fn with_accounts(mut ix: svm::Instruction, extra: &[AccountMeta]) -> svm::Instruction {
    ix.accounts.extend(extra.iter().map(|m| svm::AccountMeta {
        pubkey: key(m.pubkey),
        is_signer: m.is_signer,
        is_writable: m.is_writable,
    }));
    ix
}
