use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::solana_program::sysvar;
use anchor_spl::token::{accessor, spl_token, Token, TokenAccount};

use crate::errors::LadderError;
use crate::state::Market;

/// Kamino's lending program (klend) on mainnet.
pub const KLEND: Pubkey = pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

/// Anchor discriminators of the two klend instructions the adapter calls — `sha256("global:" +
/// name)[..8]`, checked against that formula by the test below rather than trusted as copied.
const DEPOSIT_RESERVE_LIQUIDITY: [u8; 8] = [169, 201, 30, 126, 6, 205, 102, 68];
const REDEEM_RESERVE_COLLATERAL: [u8; 8] = [234, 117, 181, 125, 185, 142, 220, 29];

/// Field offsets inside klend's `Reserve` (discriminator included), release 1.25.0 — the same
/// table `scripts/kamino-dump.ts` reads the snapshot with.
const RESERVE_LIQUIDITY_MINT: usize = 128;
const RESERVE_COLLATERAL_MINT: usize = 2560;

/// The market's kToken account: `["collateral", market]`, a token account the market owns.
pub fn collateral_address(market: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"collateral", market.as_ref()], &crate::ID)
}

/// The Kamino adapter: the reserve route of klend, `deposit_reserve_liquidity` and
/// `redeem_reserve_collateral`.
///
/// **The reserve route, not an obligation** (T045). Both instructions refresh the reserve
/// without a price, so neither the Scope oracle nor farms are involved, and neither restricts
/// being called through CPI. An obligation is needed only to borrow against the deposit or to
/// collect farm rewards — the ladder does neither.
///
/// **What the ladder counts is kTokens, never the requested amount.** klend takes only what
/// whole kTokens cover, so a deposit leaves up to a unit of the asset behind in the vault; that
/// dust belongs to no epoch and stays there with the treasury side, like every other rounding
/// remainder. What an epoch gets back is measured at redemption, on the vault itself.
///
/// **Income accrues until settlement, not until maturity.** klend has no notion of the epoch's
/// date: a crank that comes three days late redeems three days' more interest. The promise does
/// not move with it, so the extra lands in the buffer as surplus (FR-011b) — the rungs are paid
/// the same whenever the crank comes, unless the epoch was short, in which case late helps them.
///
/// **A settlement can wait on Kamino's liquidity.** If the reserve is fully borrowed, klend
/// refuses the redemption and `settle_epoch` fails as a whole; nothing moves, and the same
/// permissionless crank succeeds once borrowers repay. That is the real risk of lending, and it
/// shows up as a late settlement rather than a smaller one.
///
/// The accounts, in this order, after whatever the instruction itself puts in
/// `remaining_accounts`:
///
/// | # | account | |
/// |---|---|---|
/// | 0 | klend | `KLEND` |
/// | 1 | lending market | checked by klend against the reserve |
/// | 2 | lending market authority | PDA `["lma", lending market]` of klend, checked by klend |
/// | 3 | reserve, writable | the one pinned in `YieldSource::Kamino` |
/// | 4 | reserve liquidity mint | the market's asset |
/// | 5 | reserve liquidity supply, writable | checked by klend against the reserve |
/// | 6 | reserve collateral mint, writable | checked by klend against the reserve |
/// | 7 | market collateral, writable | `["collateral", market]` |
/// | 8 | instructions sysvar | |
pub struct Kamino<'a, 'info> {
    klend: &'a AccountInfo<'info>,
    lending_market: &'a AccountInfo<'info>,
    lending_market_authority: &'a AccountInfo<'info>,
    reserve: &'a AccountInfo<'info>,
    liquidity_mint: &'a AccountInfo<'info>,
    liquidity_supply: &'a AccountInfo<'info>,
    collateral_mint: &'a AccountInfo<'info>,
    collateral: &'a AccountInfo<'info>,
    instructions: &'a AccountInfo<'info>,
}

impl<'a, 'info> Kamino<'a, 'info> {
    /// Checks what the program itself answers for. The rest — that the lending market, its
    /// authority, the supply and the kToken mint belong to this reserve — klend checks on every
    /// call, and a second copy of those checks here would only drift from klend's own.
    pub fn from_accounts(
        market: &Account<'info, Market>,
        reserve: &Pubkey,
        accounts: &'a [AccountInfo<'info>],
    ) -> Result<Self> {
        let [klend, lending_market, lending_market_authority, reserve_info, liquidity_mint, liquidity_supply, collateral_mint, collateral, instructions] =
            accounts
        else {
            return err!(LadderError::SourceAccountsMismatch);
        };

        require_keys_eq!(klend.key(), KLEND, LadderError::SourceAccountsMismatch);
        require_keys_eq!(reserve_info.key(), *reserve, LadderError::SourceAccountsMismatch);
        require_keys_eq!(liquidity_mint.key(), market.asset_mint, LadderError::SourceAccountsMismatch);
        require_keys_eq!(
            collateral.key(),
            collateral_address(&market.key()).0,
            LadderError::SourceAccountsMismatch
        );
        require_keys_eq!(instructions.key(), sysvar::instructions::ID, LadderError::SourceAccountsMismatch);

        Ok(Kamino {
            klend,
            lending_market,
            lending_market_authority,
            reserve: reserve_info,
            liquidity_mint,
            liquidity_supply,
            collateral_mint,
            collateral,
            instructions,
        })
    }

    /// Moves `amount` from the vault into the reserve and returns the kTokens minted for it.
    pub fn deposit(
        &self,
        market: &Account<'info, Market>,
        vault: &Account<'info, TokenAccount>,
        token_program: &Program<'info, Token>,
        amount: u64,
    ) -> Result<u64> {
        let before = accessor::amount(self.collateral)?;

        let accounts = vec![
            AccountMeta::new_readonly(market.key(), true),
            AccountMeta::new(self.reserve.key(), false),
            AccountMeta::new_readonly(self.lending_market.key(), false),
            AccountMeta::new_readonly(self.lending_market_authority.key(), false),
            AccountMeta::new_readonly(self.liquidity_mint.key(), false),
            AccountMeta::new(self.liquidity_supply.key(), false),
            AccountMeta::new(self.collateral_mint.key(), false),
            AccountMeta::new(vault.key(), false),
            AccountMeta::new(self.collateral.key(), false),
            AccountMeta::new_readonly(token_program.key(), false),
            AccountMeta::new_readonly(token_program.key(), false),
            AccountMeta::new_readonly(self.instructions.key(), false),
        ];
        self.call(market, vault, token_program, accounts, DEPOSIT_RESERVE_LIQUIDITY, amount)?;

        let minted = accessor::amount(self.collateral)?
            .checked_sub(before)
            .ok_or(LadderError::MathOverflow)?;
        // klend refuses a deposit worth no kTokens itself; this only keeps the core from ever
        // recording principal the source holds nothing for.
        require!(minted > 0, LadderError::ZeroAmount);
        Ok(minted)
    }

    /// Redeems `shares` kTokens into the vault and returns what arrived there.
    pub fn redeem(
        &self,
        market: &Account<'info, Market>,
        vault: &Account<'info, TokenAccount>,
        token_program: &Program<'info, Token>,
        shares: u64,
    ) -> Result<u64> {
        // An epoch nobody entered holds nothing in the reserve, and klend refuses a zero
        // redemption.
        if shares == 0 {
            return Ok(0);
        }

        let before = accessor::amount(&vault.to_account_info())?;

        let accounts = vec![
            AccountMeta::new_readonly(market.key(), true),
            AccountMeta::new_readonly(self.lending_market.key(), false),
            AccountMeta::new(self.reserve.key(), false),
            AccountMeta::new_readonly(self.lending_market_authority.key(), false),
            AccountMeta::new_readonly(self.liquidity_mint.key(), false),
            AccountMeta::new(self.collateral_mint.key(), false),
            AccountMeta::new(self.liquidity_supply.key(), false),
            AccountMeta::new(self.collateral.key(), false),
            AccountMeta::new(vault.key(), false),
            AccountMeta::new_readonly(token_program.key(), false),
            AccountMeta::new_readonly(token_program.key(), false),
            AccountMeta::new_readonly(self.instructions.key(), false),
        ];
        self.call(market, vault, token_program, accounts, REDEEM_RESERVE_COLLATERAL, shares)?;

        accessor::amount(&vault.to_account_info())?
            .checked_sub(before)
            .ok_or_else(|| LadderError::MathOverflow.into())
    }

    /// One klend instruction with a single `u64` argument, signed by the market PDA.
    fn call(
        &self,
        market: &Account<'info, Market>,
        vault: &Account<'info, TokenAccount>,
        token_program: &Program<'info, Token>,
        accounts: Vec<AccountMeta>,
        discriminator: [u8; 8],
        arg: u64,
    ) -> Result<()> {
        let mut data = discriminator.to_vec();
        data.extend_from_slice(&arg.to_le_bytes());
        let ix = Instruction { program_id: KLEND, accounts, data };

        let infos = [
            market.to_account_info(),
            self.reserve.clone(),
            self.lending_market.clone(),
            self.lending_market_authority.clone(),
            self.liquidity_mint.clone(),
            self.liquidity_supply.clone(),
            self.collateral_mint.clone(),
            vault.to_account_info(),
            self.collateral.clone(),
            token_program.to_account_info(),
            self.instructions.clone(),
            self.klend.clone(),
        ];
        market.sign(|signer| invoke_signed(&ix, &infos, signer))?;
        Ok(())
    }
}

/// Creates the market's kToken account, from `init_market`. Accounts: the reserve, its kToken
/// mint, and `["collateral", market]` to create.
///
/// The reserve is read here, once, rather than trusted: a market whose asset is not the
/// reserve's, or whose collateral account holds some other mint, would be created fine and
/// then fail on its first deposit — after the operator had already opened epochs on it.
pub fn init<'info>(
    market: &Account<'info, Market>,
    reserve: &Pubkey,
    payer: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let [reserve_info, collateral_mint, collateral] = accounts else {
        return err!(LadderError::SourceAccountsMismatch);
    };

    require_keys_eq!(reserve_info.key(), *reserve, LadderError::SourceAccountsMismatch);
    require_keys_eq!(*reserve_info.owner, KLEND, LadderError::SourceAccountsMismatch);
    {
        let data = reserve_info.try_borrow_data()?;
        let key_at = |offset: usize| {
            data.get(offset..offset + 32).map(|bytes| Pubkey::try_from(bytes).expect("32 bytes"))
        };
        require!(
            key_at(RESERVE_LIQUIDITY_MINT) == Some(market.asset_mint),
            LadderError::SourceAccountsMismatch
        );
        require!(
            key_at(RESERVE_COLLATERAL_MINT) == Some(collateral_mint.key()),
            LadderError::SourceAccountsMismatch
        );
    }

    let market_key = market.key();
    let (address, bump) = collateral_address(&market_key);
    require_keys_eq!(collateral.key(), address, LadderError::SourceAccountsMismatch);

    let space = spl_token::state::Account::LEN;
    anchor_lang::system_program::create_account(
        CpiContext::new_with_signer(
            system_program.clone(),
            anchor_lang::system_program::CreateAccount { from: payer.clone(), to: collateral.clone() },
            &[&[b"collateral", market_key.as_ref(), &[bump]]],
        ),
        Rent::get()?.minimum_balance(space),
        space as u64,
        token_program.key,
    )?;

    anchor_spl::token::initialize_account3(CpiContext::new(
        token_program.clone(),
        anchor_spl::token::InitializeAccount3 {
            account: collateral.clone(),
            mint: collateral_mint.clone(),
            authority: market.to_account_info(),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn discriminators_are_klends_instruction_names() {
        for (name, expected) in [
            ("deposit_reserve_liquidity", DEPOSIT_RESERVE_LIQUIDITY),
            ("redeem_reserve_collateral", REDEEM_RESERVE_COLLATERAL),
        ] {
            assert_eq!(Sha256::digest(format!("global:{name}").as_bytes())[..8], expected, "{name}");
        }
    }
}
