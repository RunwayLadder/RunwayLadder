//! The shared stand for instruction tests.
//!
//! Every integration test is a separate crate, so some helpers are unused in any given
//! file. That is not dead code but a consequence of the compilation model.
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas};
use anchor_spl::token::spl_token;
use mollusk_svm::Mollusk;
use solana_account::Account;

use runway_ladder::math::Distribution;
use runway_ladder::state::{EpochStatus, RollPolicy, RungStatus, YieldSource};

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
pub fn anchor_error(code: runway_ladder::errors::LadderError) -> svm::ProgramError {
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

/// An account owned by the program, holding already serialized state.
fn program_account(data: Vec<u8>) -> Account {
    Account { lamports: FUNDED, data, owner: key(runway_ladder::ID), executable: false, rent_epoch: 0 }
}

/// What an epoch has accumulated by the time it matures. A named struct rather than three
/// `u64` arguments: `total_deposited` and `total_promised` are both amounts of the same asset
/// and swapping them at a call site would compile and quietly settle a different epoch.
pub struct Deposits {
    pub total_deposited: u64,
    pub total_promised: u64,
    pub deposit_seconds: u128,
    pub status: EpochStatus,
    /// What the epoch's rungs have already taken out of the vault.
    pub redeemed: u64,
}

impl Default for Deposits {
    fn default() -> Self {
        Deposits {
            total_deposited: 0,
            total_promised: 0,
            deposit_seconds: 0,
            status: EpochStatus::Active,
            redeemed: 0,
        }
    }
}

impl Deposits {
    /// One deposit held for `seconds`, promised at `rate_bps` — the shape `ladder_deposit`
    /// would have produced, computed with the program's own `promise` so the stand cannot
    /// disagree with it.
    pub fn single(working: u64, rate_bps: u16, seconds: i64) -> Self {
        Deposits {
            total_deposited: working,
            total_promised: runway_ladder::math::promise(working, rate_bps, seconds).unwrap(),
            deposit_seconds: u128::from(working) * u128::try_from(seconds).unwrap(),
            ..Deposits::default()
        }
    }
}

/// What the market's three token accounts hold. Named rather than three `u64` arguments for
/// the same reason as `Deposits`: all three are amounts of one asset, and a swapped pair would
/// compile and quietly settle against the wrong money.
#[derive(Clone, Copy, Default)]
pub struct Balances {
    pub vault: u64,
    pub buffer: u64,
    pub reserve: u64,
}

pub struct Env {
    pub mollusk: Mollusk,
    pub authority: Pubkey,
    pub asset_mint: Pubkey,
    pub market: Pubkey,
    pub vault: Pubkey,
    pub buffer_vault: Pubkey,
    pub source_reserve: Pubkey,
    pub source: YieldSource,
    /// The market's minimum rung size (FR-006). Tests that do not care about it
    /// leave zero and never think about it.
    pub min_rung_amount: u64,
    pub accounts: Vec<(svm::Pubkey, Account)>,
}

/// A fixed asset mint for tests that measure compute. `Pubkey::new_unique` hands out keys in
/// the order threads reach it, so under the parallel runner a stand's addresses change from run
/// to run — and with them the bump searches the program does at run time, about 1.5k compute
/// units per extra try. A measurement over such keys is a coin toss.
pub const PINNED_MINT: Pubkey = Pubkey::new_from_array([7; 32]);

/// A fixed ladder owner, for the same reason: the ladder address, and every rung address
/// derived from it, follows from the owner.
pub const PINNED_OWNER: Pubkey = Pubkey::new_from_array([9; 32]);

impl Env {
    pub fn new(source: YieldSource) -> Self {
        Self::with_mint(source, Pubkey::new_unique())
    }

    /// The same stand over a mint the test names — see `PINNED_MINT`.
    pub fn with_mint(source: YieldSource, asset_mint: Pubkey) -> Self {
        let mut mollusk = Mollusk::new(&key(runway_ladder::ID), "runway_ladder");
        mollusk_svm_programs_token::token::add_program(&mut mollusk);
        mollusk.sysvars.clock.unix_timestamp = NOW;

        let authority = Pubkey::new_unique();

        let (market, _) = Pubkey::find_program_address(
            &[b"market", asset_mint.as_ref(), &source.seed()],
            &runway_ladder::ID,
        );
        let (vault, _) =
            Pubkey::find_program_address(&[b"vault", market.as_ref()], &runway_ladder::ID);
        let (buffer_vault, _) =
            Pubkey::find_program_address(&[b"buffer", market.as_ref()], &runway_ladder::ID);
        let (source_reserve, _) =
            Pubkey::find_program_address(&[b"reserve", market.as_ref()], &runway_ladder::ID);

        let system = mollusk_svm::program::keyed_account_for_system_program();
        let accounts = vec![
            (key(authority), Account::new(FUNDED, 0, &system.0)),
            (key(asset_mint), mint_account(&authority)),
            (key(market), Account::default()),
            (key(vault), Account::default()),
            (key(buffer_vault), Account::default()),
            (key(source_reserve), Account::default()),
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
            source_reserve,
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
            &runway_ladder::ID,
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
            program_id: runway_ladder::ID,
            accounts: runway_ladder::accounts::InitMarket {
                authority: self.authority,
                asset_mint: self.asset_mint,
                market: self.market,
                vault: self.vault,
                buffer_vault: self.buffer_vault,
                source_reserve: self.source_reserve,
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: runway_ladder::instruction::InitMarket {
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
            program_id: runway_ladder::ID,
            accounts: runway_ladder::accounts::CreateEpoch {
                authority: signer,
                market: self.market,
                epoch: self.epoch(maturity_ts),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: runway_ladder::instruction::CreateEpoch { maturity_ts, rate_bps }.data(),
        })
    }

    pub fn ladder(&self, owner: Pubkey, seed: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[b"ladder", owner.as_ref(), &seed.to_le_bytes()],
            &runway_ladder::ID,
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
            program_id: runway_ladder::ID,
            accounts: runway_ladder::accounts::OpenLadder {
                owner: signer,
                market: self.market,
                ladder,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: runway_ladder::instruction::OpenLadder { seed, roll_policy: policy }.data(),
        })
    }

    pub fn rung(&self, ladder: Pubkey, index: u32) -> Pubkey {
        Pubkey::find_program_address(
            &[b"rung", ladder.as_ref(), &index.to_le_bytes()],
            &runway_ladder::ID,
        )
        .0
    }

    /// The ladder's `rung_count` as the stand holds it: the number its next rung takes. A ladder
    /// the stand does not hold yet — one a chain opens — has issued nothing.
    pub fn rung_count(&self, ladder: Pubkey) -> u32 {
        self.accounts
            .iter()
            .find(|(k, _)| *k == key(ladder))
            .filter(|(_, account)| !account.data.is_empty())
            .map(|(_, account)| {
                runway_ladder::state::Ladder::try_deserialize(&mut &account.data[..])
                    .expect("decodes as Ladder")
                    .rung_count
            })
            .unwrap_or(0)
    }

    /// Puts a ready-made epoch into the stand — one `create_epoch` can no longer create.
    /// The only way to get an epoch with a date in the past without turning the clock
    /// between instructions: on chain there is one clock for everything.
    pub fn seed_epoch(&mut self, maturity_ts: i64, rate_bps: u16) -> Pubkey {
        self.seed_settled_epoch(maturity_ts, rate_bps, Deposits::default())
    }

    /// The same, with the accumulators filled. A matured epoch cannot be produced by running
    /// `ladder_deposit`, because the deposit refuses an epoch whose date has passed — so the
    /// state a settlement reads has to be placed into the stand directly.
    pub fn seed_settled_epoch(
        &mut self,
        maturity_ts: i64,
        rate_bps: u16,
        deposits: Deposits,
    ) -> Pubkey {
        let address = self.epoch(maturity_ts);
        let (_, bump) = Pubkey::find_program_address(
            &[b"epoch", self.market.as_ref(), &maturity_ts.to_le_bytes()],
            &runway_ladder::ID,
        );

        let epoch = runway_ladder::state::Epoch {
            market: self.market,
            maturity_ts,
            rate_bps,
            created_by: self.authority,
            created_at: NOW,
            total_deposited: deposits.total_deposited,
            total_promised: deposits.total_promised,
            deposit_seconds: deposits.deposit_seconds,
            redeemed: deposits.redeemed,
            status: deposits.status,
            bump,
        };

        let mut data = vec![0u8; 8 + runway_ladder::state::Epoch::INIT_SPACE];
        epoch.try_serialize(&mut &mut data[..]).expect("serializes as Epoch");

        // `create_epoch` keeps the market's furthest maturity; an epoch placed by hand must too,
        // or the roll target would depend on how the stand was built. A market the stand does
        // not hold yet has nothing to update.
        if let Some(slot) = self
            .accounts
            .iter_mut()
            .find(|(k, account)| *k == key(self.market) && !account.data.is_empty())
        {
            let mut market = runway_ladder::state::Market::try_deserialize(&mut &slot.1.data[..])
                .expect("decodes as Market");
            market.latest_maturity = market.latest_maturity.max(maturity_ts);
            market.try_serialize(&mut &mut slot.1.data[..]).expect("serializes as Market");
        }

        self.accounts.push((
            key(address),
            Account {
                lamports: FUNDED,
                data,
                owner: key(runway_ladder::ID),
                executable: false,
                rent_epoch: 0,
            },
        ));

        address
    }

    /// Puts a ready-made market and its three funded token accounts into the stand.
    ///
    /// Settlement tests cannot reach this state by running `init_market`: that instruction
    /// creates all three empty, and mollusk hands the chain one set of accounts, so there is
    /// no point between the two instructions at which tokens could be added to the buffer.
    pub fn seed_market(&mut self, fee_bps: u16, balances: Balances) {
        let (_, bump) = Pubkey::find_program_address(
            &[b"market", self.asset_mint.as_ref(), &self.source.seed()],
            &runway_ladder::ID,
        );

        let market = runway_ladder::state::Market {
            authority: self.authority,
            asset_mint: self.asset_mint,
            vault: self.vault,
            buffer_vault: self.buffer_vault,
            source: self.source,
            fee_bps,
            min_rung_amount: self.min_rung_amount,
            // Epochs seeded after the market move it forward — see `seed_settled_epoch`.
            latest_maturity: 0,
            bump,
        };

        let mut data = vec![0u8; 8 + runway_ladder::state::Market::INIT_SPACE];
        market.try_serialize(&mut &mut data[..]).expect("serializes as Market");
        self.put(
            self.market,
            Account {
                lamports: FUNDED,
                data,
                owner: key(runway_ladder::ID),
                executable: false,
                rent_epoch: 0,
            },
        );

        self.seed_vaults(balances);
    }

    /// Adds the account, or replaces the placeholder `Env::new` left at that address.
    fn put(&mut self, address: Pubkey, account: Account) {
        match self.accounts.iter_mut().find(|(k, _)| *k == key(address)) {
            Some(slot) => slot.1 = account,
            None => self.accounts.push((key(address), account)),
        }
    }

    /// Replaces the market's token accounts with real SPL accounts holding a balance.
    /// `init_market` creates them empty, and a settlement needs a buffer and a reserve that
    /// already have something in them.
    pub fn seed_vaults(&mut self, balances: Balances) {
        let Balances { vault, buffer, reserve } = balances;
        for (address, amount) in
            [(self.vault, vault), (self.buffer_vault, buffer), (self.source_reserve, reserve)]
        {
            self.put(address, token_account(&self.asset_mint, &self.market, amount));
        }
    }

    pub fn settle_epoch(&self, maturity_ts: i64) -> svm::Instruction {
        to_svm(Instruction {
            program_id: runway_ladder::ID,
            accounts: runway_ladder::accounts::SettleEpoch {
                market: self.market,
                epoch: self.epoch(maturity_ts),
                vault: self.vault,
                buffer_vault: self.buffer_vault,
                source_reserve: self.source_reserve,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: runway_ladder::instruction::SettleEpoch {}.data(),
        })
    }

    /// Puts a ready-made ladder into the stand. A redemption needs a rung in a settled epoch,
    /// and a settled epoch cannot be reached by running `ladder_deposit` (see
    /// `seed_settled_epoch`), so the ladder and its rungs are placed directly as well.
    pub fn seed_ladder(&mut self, owner: Pubkey, seed: u64, policy: RollPolicy) -> Pubkey {
        let (address, bump) = Pubkey::find_program_address(
            &[b"ladder", owner.as_ref(), &seed.to_le_bytes()],
            &runway_ladder::ID,
        );

        let ladder = runway_ladder::state::Ladder {
            owner,
            market: self.market,
            seed,
            rung_count: 0,
            roll_policy: policy,
            created_at: NOW,
            bump,
        };

        let mut data = vec![0u8; 8 + runway_ladder::state::Ladder::INIT_SPACE];
        ladder.try_serialize(&mut &mut data[..]).expect("serializes as Ladder");
        self.put(address, program_account(data));
        address
    }

    /// An active rung of `ladder` in `epoch`, promised `promised`. It takes the ladder's next
    /// number, and the seeded ladder's `rung_count` moves past it — the same bookkeeping
    /// `ladder_deposit` does, so a deposit after it lands on the right address.
    pub fn seed_rung(&mut self, ladder: Pubkey, epoch: Pubkey, promised: u64) -> Pubkey {
        let index = self.rung_count(ladder);
        let (address, bump) = Pubkey::find_program_address(
            &[b"rung", ladder.as_ref(), &index.to_le_bytes()],
            &runway_ladder::ID,
        );

        let slot = self
            .accounts
            .iter_mut()
            .find(|(k, _)| *k == key(ladder))
            .expect("the ladder is seeded before its rungs");
        let mut state = runway_ladder::state::Ladder::try_deserialize(&mut &slot.1.data[..])
            .expect("decodes as Ladder");
        state.rung_count = index + 1;
        state.try_serialize(&mut &mut slot.1.data[..]).expect("serializes as Ladder");

        let rung = runway_ladder::state::Rung {
            ladder,
            epoch,
            index,
            deposited: promised,
            promised,
            fee_paid: 0,
            status: RungStatus::Active,
            bump,
        };

        let mut data = vec![0u8; 8 + runway_ladder::state::Rung::INIT_SPACE];
        rung.try_serialize(&mut &mut data[..]).expect("serializes as Rung");
        self.put(address, program_account(data));
        address
    }

    /// The signer, the ladder and the destination are given separately: otherwise "a stranger
    /// redeems the owner's rung" and "the owner redeems into a stranger's account" cannot even
    /// be assembled.
    pub fn redeem_rung(
        &self,
        signer: Pubkey,
        ladder: Pubkey,
        epoch: Pubkey,
        index: u32,
        destination: Pubkey,
    ) -> svm::Instruction {
        to_svm(Instruction {
            program_id: runway_ladder::ID,
            accounts: runway_ladder::accounts::RedeemRung {
                owner: signer,
                market: self.market,
                ladder,
                epoch,
                rung: self.rung(ladder, index),
                vault: self.vault,
                destination,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: runway_ladder::instruction::RedeemRung {}.data(),
        })
    }

    /// The new rung takes the ladder's next number as the stand holds it — the address a keeper
    /// would derive after reading the ladder. The payer and the target are given separately:
    /// otherwise "a stranger cranks" and "the crank picks the epoch" cannot even be assembled.
    pub fn roll_rung(
        &self,
        payer: Pubkey,
        ladder: Pubkey,
        epoch: Pubkey,
        index: u32,
        target: Pubkey,
    ) -> svm::Instruction {
        to_svm(Instruction {
            program_id: runway_ladder::ID,
            accounts: runway_ladder::accounts::RollRung {
                payer,
                market: self.market,
                ladder,
                epoch,
                rung: self.rung(ladder, index),
                target,
                new_rung: self.rung(ladder, self.rung_count(ladder)),
                vault: self.vault,
                buffer_vault: self.buffer_vault,
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: runway_ladder::instruction::RollRung {}.data(),
        })
    }

    /// Reads a program account out of an instruction's result.
    pub fn decode<T: AccountDeserialize>(
        &self,
        result: &mollusk_svm::result::InstructionResult,
        address: Pubkey,
    ) -> T {
        let raw = &result.get_account(&key(address)).expect("account in the result").data;
        T::try_deserialize(&mut &raw[..]).expect("decodes as the expected account")
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
        let first = self.rung_count(ladder);

        let mut metas = runway_ladder::accounts::LadderDeposit {
            owner: signer,
            market: self.market,
            ladder,
            vault: self.vault,
            buffer_vault: self.buffer_vault,
            source: source_token,
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None);

        for (offset, maturity) in (0u32..).zip(maturities) {
            let epoch = self.epoch(*maturity);
            metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(epoch, false));
            metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
                self.rung(ladder, first + offset),
                false,
            ));
        }

        to_svm(Instruction {
            program_id: runway_ladder::ID,
            accounts: metas,
            data: runway_ladder::instruction::LadderDeposit { amount, distribution }.data(),
        })
    }
}
