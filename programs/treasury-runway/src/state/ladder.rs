use anchor_lang::prelude::*;

use crate::state::Market;

/// What happens to the rung's funds once it is redeemed.
///
/// The names come from `docs/PLAN.md` ("Flow: what happens on deposit"), where the policy
/// is referred to as `policy=Roll` and `policy=None`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RollPolicy {
    /// The funds stay with the treasurer: redemption takes them out of the ladder (FR-012).
    None,
    /// The funds go into a new rung at the end of the horizon, and anyone may do it
    /// (FR-013). That is exactly why the destination of the funds is not a crank parameter.
    Roll,
}

/// A ladder: a set of rungs of one owner on one market.
///
/// Ownership here is a `Pubkey` and nothing more. No field and no check
/// assumes a single private key stands behind this key: a multisig safe
/// takes the same path as an ordinary wallet (FR-020a).
#[account]
#[derive(InitSpace)]
pub struct Ladder {
    /// The only one who can initiate ladder operations (FR-020). A foreign wallet
    /// reads the same accounts but has no path to change them.
    pub owner: Pubkey,
    pub market: Pubkey,
    /// Distinguishes the ladders of one owner: a treasury keeps several —
    /// for example, for different budget lines.
    pub seed: u64,
    /// How many rungs the ladder has issued over its lifetime. A counter, not a plan:
    /// rolling (FR-013) adds rungs after the deposit, so any number declared
    /// up front would drift from reality on the very first crank.
    pub rung_count: u32,
    pub roll_policy: RollPolicy,
    pub created_at: i64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct OpenLadder<'info> {
    /// `Signer` checks exactly one thing — that the account signed the instruction. It does not
    /// require the account to be owned by the system program, which is precisely why a multisig
    /// safe signing through CPI is not a special case here (FR-020a).
    #[account(mut)]
    pub owner: Signer<'info>,

    pub market: Account<'info, Market>,

    /// The owner is part of the seeds, so the address space is divided between owners:
    /// a foreign signer cannot create a ladder at someone else's address — not because
    /// a check catches it, but because the address is not derived from their key.
    #[account(
        init,
        payer = owner,
        space = 8 + Ladder::INIT_SPACE,
        seeds = [b"ladder", owner.key().as_ref(), &seed.to_le_bytes()],
        bump,
    )]
    pub ladder: Account<'info, Ladder>,

    pub system_program: Program<'info, System>,
}

pub fn open_ladder(ctx: Context<OpenLadder>, seed: u64, roll_policy: RollPolicy) -> Result<()> {
    let ladder = &mut ctx.accounts.ladder;
    ladder.owner = ctx.accounts.owner.key();
    ladder.market = ctx.accounts.market.key();
    ladder.seed = seed;
    ladder.rung_count = 0;
    ladder.roll_policy = roll_policy;
    ladder.created_at = Clock::get()?.unix_timestamp;
    ladder.bump = ctx.bumps.ladder;

    Ok(())
}
