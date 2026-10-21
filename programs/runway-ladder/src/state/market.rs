use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount, Transfer};

use crate::errors::LadderError;
use crate::math::BPS_DENOMINATOR;

/// Which base yield source serves the market and with what parameters.
/// The behaviour lives behind the adapter boundary in `source/`, and the ladder core does not know it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum YieldSource {
    /// The rate is given as a parameter: reproducible runs and devnet, where third-party
    /// protocols do not exist at all.
    Deterministic { rate_bps: u16 },
    /// Kamino's lending reserve for the market's asset: the principal goes into it through CPI
    /// and comes back with whatever it earned. The reserve is pinned here, at market creation,
    /// and every instruction that moves funds checks the one it is handed against it — a
    /// caller chooses no part of where the money works.
    Kamino { reserve: Pubkey },
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
            YieldSource::Kamino { .. } => [1],
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
    /// The furthest maturity among the market's epochs — the only epoch `roll_rung` puts funds
    /// into (FR-013). A running maximum kept by `create_epoch`, not the last one created: an
    /// operator creating a shorter epoch afterwards must not pull every rolling ladder in with it.
    /// Zero until the first epoch exists.
    pub latest_maturity: i64,
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

    /// Where the deterministic source's income physically comes from. Whoever runs the stand
    /// funds it with a plain token transfer; `settle_epoch` pulls from it only what the
    /// formula says the epoch earned, and only as much as is actually there.
    ///
    /// Not a field on `Market`: its address follows from the seeds, and the account belongs
    /// to the deterministic adapter rather than to the ladder core.
    #[account(
        init,
        payer = authority,
        token::mint = asset_mint,
        token::authority = market,
        seeds = [b"reserve", market.key().as_ref()],
        bump,
    )]
    pub source_reserve: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: what `source::init` asks of the market's source.
}

pub fn init_market<'info>(
    ctx: Context<'_, '_, 'info, 'info, InitMarket<'info>>,
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
    market.latest_maturity = 0;
    market.bump = ctx.bumps.market;

    // Whatever the source needs to hold for the market — for Kamino, the account its kTokens
    // land in. Created here, once, so that no later instruction takes an account a caller made.
    crate::source::init(
        &ctx.accounts.market,
        &ctx.accounts.authority.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        ctx.remaining_accounts,
    )
}

/// One transfer out of a token account the market owns, signed by the market PDA. Every movement
/// of the protocol's money between token accounts — settlement between its own accounts,
/// redemption to the treasury — goes through here.
pub fn transfer_as_market<'info>(
    market: &Account<'info, Market>,
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    market.sign(|signer| {
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            amount,
        )
    })
}

impl Market {
    /// Runs `f` with the market PDA's signer seeds. Every CPI the market signs — a transfer
    /// between its own accounts, a deposit into the source — goes through here, so the seeds
    /// exist in one place.
    pub fn sign<R>(&self, f: impl FnOnce(&[&[&[u8]]]) -> R) -> R {
        let asset_mint = self.asset_mint;
        let source_seed = self.source.seed();
        let bump = [self.bump];
        f(&[&[b"market", asset_mint.as_ref(), &source_seed, &bump]])
    }
}
