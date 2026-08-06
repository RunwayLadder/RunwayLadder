use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use mollusk_svm::result::Check;
use mollusk_svm::Mollusk;
use solana_account::Account;

use treasury_runway::state::{Market, YieldSource};

/// Anchor 0.32 and mollusk 0.15 are built on different majors of the solana crates
/// (`solana-instruction` 2.x vs 3.x), so their `Pubkey`s are two different types
/// with identical content. All conversion lives here so the boundary is in one place
/// rather than spread across the tests.
mod svm {
    pub use solana_instruction::{AccountMeta, Instruction};
    pub use solana_pubkey::Pubkey;
}

fn key(k: Pubkey) -> svm::Pubkey {
    svm::Pubkey::new_from_array(k.to_bytes())
}

fn instruction(ix: Instruction) -> svm::Instruction {
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

/// Anchor error code: `#[error_code]` offsets the variants by 6000.
fn anchor_error(code: treasury_runway::errors::LadderError) -> u32 {
    6000 + code as u32
}

const DECIMALS: u8 = 6;
/// Deliberately above rent-exempt with margin: the test checks market logic, not rent.
const FUNDED: u64 = 10_000_000_000;

struct Fixture {
    mollusk: Mollusk,
    authority: Pubkey,
    asset_mint: Pubkey,
    market: Pubkey,
    vault: Pubkey,
    buffer_vault: Pubkey,
    accounts: Vec<(svm::Pubkey, Account)>,
}

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

fn setup(source: YieldSource) -> Fixture {
    let mut mollusk = Mollusk::new(&key(treasury_runway::ID), "treasury_runway");
    mollusk_svm_programs_token::token::add_program(&mut mollusk);

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

    Fixture { mollusk, authority, asset_mint, market, vault, buffer_vault, accounts }
}

fn init_market_ix(f: &Fixture, source: YieldSource, fee_bps: u16) -> svm::Instruction {
    instruction(Instruction {
        program_id: treasury_runway::ID,
        accounts: treasury_runway::accounts::InitMarket {
            authority: f.authority,
            asset_mint: f.asset_mint,
            market: f.market,
            vault: f.vault,
            buffer_vault: f.buffer_vault,
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: treasury_runway::instruction::InitMarket { source, fee_bps }.data(),
    })
}

#[test]
fn creates_a_market_with_its_own_vault_and_buffer() {
    let f = setup(YieldSource::Deterministic);
    let ix = init_market_ix(&f, YieldSource::Deterministic, 25);

    let result = f.mollusk.process_and_validate_instruction(&ix, &f.accounts, &[Check::success()]);

    let raw = &result.get_account(&key(f.market)).expect("market").data;
    let market = Market::try_deserialize(&mut &raw[..]).expect("decodes as Market");

    assert_eq!(market.authority, f.authority);
    assert_eq!(market.asset_mint, f.asset_mint);
    assert_eq!(market.fee_bps, 25);
    assert_eq!(market.source, YieldSource::Deterministic);
    assert_eq!(market.vault, f.vault);
    assert_eq!(market.buffer_vault, f.buffer_vault);

    // The vault and the buffer are different accounts, and that is not cosmetic: the buffer
    // is the second step of the waterfall, so mixing it with treasury deposits would mean
    // covering a shortfall with their own funds.
    assert_ne!(market.vault, market.buffer_vault);

    for (name, pubkey) in [("vault", f.vault), ("buffer", f.buffer_vault)] {
        let account = result.get_account(&key(pubkey)).unwrap_or_else(|| panic!("{name}"));
        let token = spl_token::state::Account::unpack(&account.data)
            .unwrap_or_else(|_| panic!("{name} is not a token account"));

        assert_eq!(token.mint, f.asset_mint, "{name}: mint");
        assert_eq!(token.owner, f.market, "{name}: controlled by the market, not the operator");
        assert_eq!(token.amount, 0, "{name}");
    }
}

#[test]
fn rejects_a_fee_above_the_whole_amount() {
    let f = setup(YieldSource::Deterministic);
    let ix = init_market_ix(&f, YieldSource::Deterministic, 10_001);

    f.mollusk.process_and_validate_instruction(
        &ix,
        &f.accounts,
        &[Check::err(solana_program_error::ProgramError::Custom(anchor_error(
            treasury_runway::errors::LadderError::InvalidFeeBps,
        )))],
    );
}
