//! The trail by which an operation can be reconciled with the onchain transaction (FR-021).
//!
//! Events describe an **action**, accounts describe **state**. So there are no fields here
//! that merely duplicate `Rung` or `Ladder` at the moment of reading: the dashboard reads the
//! accounts anyway, and what it needs from an event is what the current state no longer shows —
//! what exactly this transaction did and how much money passed through it.
//!
//! Events are log-based (`emit!`), not CPI (`emit_cpi!`). `emit_cpi!` would require two
//! extra accounts in **every** instruction and would pay compute for every
//! event — while the deposit emits as many as there are rungs, and it is precisely its
//! one-signature ceiling (FR-005) that the product sells. The price of the choice: RPC
//! truncates logs on very large transactions, so history reconciliation rests on the pair
//! "event + account", not on the event alone.

use anchor_lang::prelude::*;

use crate::state::RollPolicy;

#[event]
pub struct LadderOpened {
    pub ladder: Pubkey,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub seed: u64,
    pub roll_policy: RollPolicy,
    pub created_at: i64,
}

/// One rung at the moment of issuance. `promised` here is the same number that landed in
/// the account and will never change: the event fixes the promise in time rather than
/// relaying current state.
#[event]
pub struct RungIssued {
    pub ladder: Pubkey,
    pub rung: Pubkey,
    pub epoch: Pubkey,
    pub maturity_ts: i64,
    pub rate_bps: u16,
    pub deposited: u64,
    pub promised: u64,
    pub fee_paid: u64,
}

/// The deposit summary. Rungs have events of their own, but the amount the treasurer
/// signed and the amount the protocol kept belong to none of them individually —
/// without this event they would have to be gathered by addition (FR-022).
#[event]
pub struct LadderFunded {
    pub ladder: Pubkey,
    pub owner: Pubkey,
    /// How much was debited from the treasury wallet — exactly what it confirmed.
    pub amount: u64,
    /// How much of that went to work.
    pub working_total: u64,
    /// How much was kept in the protocol buffer.
    pub withheld: u64,
    pub rungs: u32,
}
