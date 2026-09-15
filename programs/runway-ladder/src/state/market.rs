use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::LadderError;
use crate::math::BPS_DENOMINATOR;

/// Which base yield source serves the market and with what parameters.
/// The behaviour lives behind the adapter boundary in `source/`, and the ladder core does not know it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum YieldSource {
    /// The rate is given as a parameter: reproducible runs and devnet, where third-party
    /// protocols do not exist at all.
    Deterministic { rate_bps: u16 },
}

impl YieldSource {
    /// Part of the market seeds: one asset served by different sources is
    /// different markets, not one market with a switch, otherwise changing the source
    /// would silently redefine the terms of already issued rungs.
    ///
    /// The **kind** of source goes into the seeds, not its parameters: a market with a different
    /// base rate is the same market. Otherwise every rate change would spawn
    /// a separate vault, while the funds stayed in the previous one.
    pub fn seed(&self) -> [u8; 1] {
        match self {
            YieldSource::Deterministic { .. } => [0],
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    /// The operator: creates epochs and sets their rate. A conscious point of trust — see
    /// `docs/SPEC.md`, FR-010a: who set the rate and when is visible to the treasurer.
    pub authority: Pubkey,
    pub asset_mint: Pubkey,
    /// The vault for treasury deposits.
    pub vault: Pubkey,
    /// The protocol buffer: filled by fees and standing as the second step of the
    /// waterfall when the yield falls short (FR-011, FR-023).
    pub buffer_vault: Pubkey,
    pub source: YieldSource,
    pub fee_bps: u16,
    /// The minimum rung size in the asset's smallest units (FR-006).
    ///
    /// Lives on the market, not in the program and not in a deposit parameter: a constant
    /// in base units means nothing without the mint's decimals (FR-001),
    /// and a minimum the treasurer sets themselves protects against nothing. A meaningful
    /// rung is one whose yield is not eaten by the network fee for redemption,
    /// and the one who knows that is the market operator.
    pub min_rung_amount: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(source: YieldSource)]
pub struct InitMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The market's asset is a parameter, not a constant: no logic relies on
    /// a specific mint or number of decimals (FR-001).
    pub asset_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", asset_mint.key().as_ref(), &source.seed()],
        bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = authority,
        token::mint = asset_mint,
        token::authority = market,
        seeds = [b"vault", market.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        token::mint = asset_mint,
        token::authority = market,
        seeds = [b"buffer", market.key().as_ref()],
        bump,
    )]
    pub buffer_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn init_market(
    ctx: Context<InitMarket>,
    source: YieldSource,
    fee_bps: u16,
    min_rung_amount: u64,
) -> Result<()> {
    require!(u128::from(fee_bps) <= BPS_DENOMINATOR, LadderError::InvalidFeeBps);

    let market = &mut ctx.accounts.market;
    market.authority = ctx.accounts.authority.key();
    market.asset_mint = ctx.accounts.asset_mint.key();
    market.vault = ctx.accounts.vault.key();
    market.buffer_vault = ctx.accounts.buffer_vault.key();
    market.source = source;
    market.fee_bps = fee_bps;
    market.min_rung_amount = min_rung_amount;
    market.bump = ctx.bumps.market;

    Ok(())
}
