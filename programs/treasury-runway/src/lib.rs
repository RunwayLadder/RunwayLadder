use anchor_lang::prelude::*;

pub mod errors;
pub mod math;
pub mod state;

use state::*;

declare_id!("HShAvvN6icFTUAs2hiKTHr7nGomyrcKz66wPB6CNhewe");

#[program]
pub mod treasury_runway {
    use super::*;

    pub fn init_market(ctx: Context<InitMarket>, source: YieldSource, fee_bps: u16) -> Result<()> {
        state::init_market(ctx, source, fee_bps)
    }
}
