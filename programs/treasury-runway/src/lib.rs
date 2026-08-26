use anchor_lang::prelude::*;

pub mod errors;
pub mod math;
pub mod source;
pub mod state;

use state::*;

declare_id!("HShAvvN6icFTUAs2hiKTHr7nGomyrcKz66wPB6CNhewe");

#[program]
pub mod treasury_runway {
    use super::*;

    pub fn init_market(ctx: Context<InitMarket>, source: YieldSource, fee_bps: u16) -> Result<()> {
        state::init_market(ctx, source, fee_bps)
    }

    pub fn create_epoch(ctx: Context<CreateEpoch>, maturity_ts: i64, rate_bps: u16) -> Result<()> {
        state::create_epoch(ctx, maturity_ts, rate_bps)
    }

    pub fn open_ladder(ctx: Context<OpenLadder>, seed: u64, roll_policy: RollPolicy) -> Result<()> {
        state::open_ladder(ctx, seed, roll_policy)
    }
}
