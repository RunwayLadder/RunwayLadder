//! The shared stand for instruction tests.
//!
//! Every integration test is a separate crate, so some helpers are unused in any given
//! file. That is not dead code but a consequence of the compilation model.
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountSerialize, InstructionData, Space, ToAccountMetas};
use anchor_spl::token::spl_token;
use mollusk_svm::Mollusk;
use solana_account::Account;

use treasury_runway::math::Distribution;
use treasury_runway::state::{RollPolicy, YieldSource};

/// Anchor 0.32 and mollusk 0.15 are built on different majors of the solana crates
/// (`solana-instruction` 2.x vs 3.x), so their `Pubkey`s are two different types
/// with identical content. All conversion lives here so the boundary is in one place
/// rather than spread across the tests.
pub mod svm {
    pub use solana_instruction::{AccountMeta, Instruction};
    pub use solana_program_error::ProgramError;
    pub use solana_pubkey::Pubkey;
}

pub fn key(k: Pubkey) -> svm::Pubkey {
    svm::Pubkey::new_from_array(k.to_bytes())
}

pub fn to_svm(ix: Instruction) -> svm::Instruction {
    svm::Instruction {
        program_id: key(ix.program_id),
        accounts: ix
            .accounts
            .into_iter()
            .map(|m| svm::AccountMeta {
                pubkey: key(m.pubkey),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data: ix.data,
    }
}

/// `#[error_code]` offsets the variants by 6000.
pub fn anchor_error(code: treasury_runway::errors::LadderError) -> svm::ProgramError {
    svm::ProgramError::Custom(6000 + code as u32)
}

/// Anchor's built-in errors (account constraints) live in their own range and have
/// no offset. They are worth checking alongside our own: "a stranger cannot
/// create a ladder at someone else's address" is held precisely by the seeds constraint.
pub fn constraint_error(code: anchor_lang::error::ErrorCode) -> svm::ProgramError {
    svm::ProgramError::Custom(code as u32)
}

/// Removes the signature from one account of an already built instruction. The builders below
/// set the flags per the `#[derive(Accounts)]` schema, so "what if it did not sign" cannot
/// be expressed otherwise.
pub fn without_signature(mut ix: svm::Instruction, who: Pubkey) -> svm::Instruction {
    let who = key(who);
    for meta in &mut ix.accounts {
        if meta.pubkey == who {
            meta.is_signer = false;
        }
    }
    ix
}

pub const DECIMALS: u8 = 6;
/// Deliberately above rent-exempt with margin: the tests check logic, not rent.
pub const FUNDED: u64 = 10_000_000_000;
/// An arbitrary but fixed point in time — runs must be reproducible.
pub const NOW: i64 = 1_800_000_000;

/// A mint with six decimals — like USDC. The logic does not rely on it (FR-001),
/// but the stand should resemble what will be on the network.
fn mint_account(authority: &Pubkey) -> Account {
    let mut data = vec![0u8; spl_token::state::Mint::LEN];
    spl_token::state::Mint {
        mint_authority: Some(*authority).into(),
        supply: 0,
        decimals: DECIMALS,
        is_initialized: true,
        freeze_authority: None.into(),
    }
    .pack_into_slice(&mut data);

    Account { lamports: FUNDED, data, owner: key(spl_token::ID), executable: false, rent_epoch: 0 }
}

/// An SPL account with a given balance. Assembled by hand from the same version of
/// `spl_token` as in the program: the mollusk helpers are built on another one, and their
/// state types do not match `anchor_spl`.
fn token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; spl_token::state::Account::LEN];
    spl_token::state::Account {
        mint: *mint,
        owner: *owner,
        amount,
        delegate: None.into(),
        state: spl_token::state::AccountState::Initialized,
        is_native: None.into(),
        delegated_amount: 0,
        close_authority: None.into(),
    }
    .pack_into_slice(&mut data);

    Account { lamports: FUNDED, data, owner: key(spl_token::ID), executable: false, rent_epoch: 0 }
}

pub struct Env {
    pub mollusk: Mollusk,
    pub authority: Pubkey,
    pub asset_mint: Pubkey,
    pub market: Pubkey,
    pub vault: Pubkey,
    pub buffer_vault: Pubkey,
    pub source: YieldSource,
    /// The market's minimum rung size (FR-006). Tests that do not care about it
    /// leave zero and never think about it.
    pub min_rung_amount: u64,
    pub accounts: Vec<(svm::Pubkey, Account)>,
}

impl Env {
    pub fn new(source: YieldSource) -> Self {
        let mut mollusk = Mollusk::new(&key(treasury_runway::ID), "treasury_runway");
        mollusk_svm_programs_token::token::add_program(&mut mollusk);
        mollusk.sysvars.clock.unix_timestamp = NOW;

        let authority = Pubkey::new_unique();
        let asset_mint = Pubkey::new_unique();

        let (market, _) = Pubkey::find_program_address(
            &[b"market", asset_mint.as_ref(), &source.seed()],
            &treasury_runway::ID,
        );
        let (vault, _) =
            Pubkey::find_program_address(&[b"vault", market.as_ref()], &treasury_runway::ID);
        let (buffer_vault, _) =
            Pubkey::find_program_address(&[b"buffer", market.as_ref()], &treasury_runway::ID);

        let system = mollusk_svm::program::keyed_account_for_system_program();
        let accounts = vec![
            (key(authority), Account::new(FUNDED, 0, &system.0)),
            (key(asset_mint), mint_account(&authority)),
            (key(market), Account::default()),
            (key(vault), Account::default()),
            (key(buffer_vault), Account::default()),
            mollusk_svm_programs_token::token::keyed_account(),
            system,
        ];

        Env {
            mollusk,
            authority,
            asset_mint,
            market,
            vault,
            buffer_vault,
            source,
            min_rung_amount: 0,
            accounts,
        }
    }

    /// Funds a third-party account — the ladder owner or a foreign signer.
    /// Deliberately makes the system program its owner: the `payer` in `init` pays
    /// through a system transfer, and a multisig safe on devnet works the same way.
    pub fn fund(&mut self, pubkey: Pubkey) {
        let system = mollusk_svm::program::keyed_account_for_system_program();
        self.accounts.push((key(pubkey), Account::new(FUNDED, 0, &system.0)));
    }

    pub fn epoch(&self, maturity_ts: i64) -> Pubkey {
        Pubkey::find_program_address(
            &[b"epoch", self.market.as_ref(), &maturity_ts.to_le_bytes()],
            &treasury_runway::ID,
        )
        .0
    }

    /// Adds an account the instruction is expected to create. Its silent absence
    /// looks in mollusk like a program error rather than a stand error.
    pub fn expect_created(&mut self, pubkey: Pubkey) {
        self.accounts.push((key(pubkey), Account::default()));
    }

    pub fn init_market(&self, fee_bps: u16) -> svm::Instruction {
        to_svm(Instruction {
            program_id: treasury_runway::ID,
            accounts: treasury_runway::accounts::InitMarket {
                authority: self.authority,
                asset_mint: self.asset_mint,
                market: self.market,
                vault: self.vault,
                buffer_vault: self.buffer_vault,
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: treasury_runway::instruction::InitMarket {
                source: self.source,
                fee_bps,
                min_rung_amount: self.min_rung_amount,
            }
            .data(),
        })
    }

    pub fn create_epoch(
        &self,
        signer: Pubkey,
        maturity_ts: i64,
        rate_bps: u16,
    ) -> svm::Instruction {
        to_svm(Instruction {
            program_id: treasury_runway::ID,
            accounts: treasury_runway::accounts::CreateEpoch {
                authority: signer,
                market: self.market,
                epoch: self.epoch(maturity_ts),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: treasury_runway::instruction::CreateEpoch { maturity_ts, rate_bps }.data(),
        })
    }

    pub fn ladder(&self, owner: Pubkey, seed: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[b"ladder", owner.as_ref(), &seed.to_le_bytes()],
            &treasury_runway::ID,
        )
        .0
    }

    pub fn open_ladder(&self, owner: Pubkey, seed: u64, policy: RollPolicy) -> svm::Instruction {
        self.open_ladder_at(owner, self.ladder(owner, seed), seed, policy)
    }

    /// The ladder address is given separately from the signer: otherwise "a stranger signs
    /// the creation of a ladder at the owner's address" cannot even be assembled.
    pub fn open_ladder_at(
        &self,
        signer: Pubkey,
        ladder: Pubkey,
        seed: u64,
        policy: RollPolicy,
    ) -> svm::Instruction {
        to_svm(Instruction {
            program_id: treasury_runway::ID,
            accounts: treasury_runway::accounts::OpenLadder {
                owner: signer,
                market: self.market,
                ladder,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: treasury_runway::instruction::OpenLadder { seed, roll_policy: policy }.data(),
        })
    }

    pub fn rung(&self, ladder: Pubkey, epoch: Pubkey) -> Pubkey {
        Pubkey::find_program_address(
            &[b"rung", ladder.as_ref(), epoch.as_ref()],
            &treasury_runway::ID,
        )
        .0
    }

    /// Puts a ready-made epoch into the stand — one `create_epoch` can no longer create.
    /// The only way to get an epoch with a date in the past without turning the clock
    /// between instructions: on chain there is one clock for everything.
    pub fn seed_epoch(&mut self, maturity_ts: i64, rate_bps: u16) -> Pubkey {
        let address = self.epoch(maturity_ts);
        let (_, bump) = Pubkey::find_program_address(
            &[b"epoch", self.market.as_ref(), &maturity_ts.to_le_bytes()],
            &treasury_runway::ID,
        );

        let epoch = treasury_runway::state::Epoch {
            market: self.market,
            maturity_ts,
            rate_bps,
            created_by: self.authority,
            created_at: NOW,
            total_deposited: 0,
            total_promised: 0,
            bump,
        };

        let mut data = vec![0u8; 8 + treasury_runway::state::Epoch::INIT_SPACE];
        epoch.try_serialize(&mut &mut data[..]).expect("serializes as Epoch");

        self.accounts.push((
            key(address),
            Account {
                lamports: FUNDED,
                data,
                owner: key(treasury_runway::ID),
                executable: false,
                rent_epoch: 0,
            },
        ));

        address
    }

    /// A treasury wallet with an asset balance.
    pub fn fund_tokens(&mut self, owner: Pubkey, amount: u64) -> Pubkey {
        let token = Pubkey::new_unique();
        self.accounts.push((key(token), token_account(&self.asset_mint, &owner, amount)));
        token
    }

    pub fn token_balance(
        &self,
        result: &mollusk_svm::result::InstructionResult,
        token: Pubkey,
    ) -> u64 {
        let raw = &result.get_account(&key(token)).expect("token account").data;
        spl_token::state::Account::unpack(raw).expect("SPL token account").amount
    }

    /// Rungs travel in `remaining_accounts` as "epoch, rung" pairs, and every
    /// pair is exactly what the treasurer saw in the deposit preview.
    pub fn ladder_deposit(
        &self,
        owner: Pubkey,
        seed: u64,
        source_token: Pubkey,
        amount: u64,
        distribution: Distribution,
        maturities: &[i64],
    ) -> svm::Instruction {
        self.ladder_deposit_as(owner, owner, seed, source_token, amount, distribution, maturities)
    }

    /// The signer and the ladder owner are given separately: otherwise "a stranger puts
    /// funds into someone else's ladder" cannot even be assembled.
    #[allow(clippy::too_many_arguments)]
    pub fn ladder_deposit_as(
        &self,
        signer: Pubkey,
        ladder_owner: Pubkey,
        seed: u64,
        source_token: Pubkey,
        amount: u64,
        distribution: Distribution,
        maturities: &[i64],
    ) -> svm::Instruction {
        let ladder = self.ladder(ladder_owner, seed);

        let mut metas = treasury_runway::accounts::LadderDeposit {
            owner: signer,
            market: self.market,
            ladder,
            vault: self.vault,
            source: source_token,
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None);

        for maturity in maturities {
            let epoch = self.epoch(*maturity);
            metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(epoch, false));
            metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
                self.rung(ladder, epoch),
                false,
            ));
        }

        to_svm(Instruction {
            program_id: treasury_runway::ID,
            accounts: metas,
            data: treasury_runway::instruction::LadderDeposit { amount, distribution }.data(),
        })
    }
}
