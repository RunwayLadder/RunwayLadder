//! How many rungs really fit in one signature.
//!
//! FR-005 promises the deposit as a single user action, and that promise has a limit that is
//! better known as a number than learned from the treasurer. There are two limits, and the
//! smaller one holds: transaction size (1232 bytes per packet) and the compute budget.
//!
//! The numbers here are a lock, not a guideline. Every new account in `LadderDeposit` costs
//! 32 bytes in the message plus an index byte per rung, so an extra account
//! silently cuts the ceiling — and then this test turns red instead of the dashboard.
//!
//! The ceiling applies to a legacy transaction. Address lookup tables (ALT) would raise it,
//! but they are separate work and M1 has none.

use anchor_lang::prelude::Pubkey;
use mollusk_svm::result::{Check, InstructionResult};

use treasury_runway::math::Distribution;
use treasury_runway::state::{RollPolicy, YieldSource};

mod common;
use common::{key, Env, NOW};

const DAY: i64 = 86_400;
/// The maximum transaction size on the network.
const PACKET_BYTES: usize = 1232;
/// How much compute an instruction gets without an explicit request.
const DEFAULT_CU: u64 = 200_000;
/// The compute ceiling for the whole transaction.
const MAX_CU: u64 = 1_400_000;
/// One signature: 64 bytes plus a count byte.
const SIGNATURE_BYTES: usize = 65;

/// The ceiling this test pins. If it changed, the deposit's account set has
/// changed, and a person should find out about it, not a treasurer on devnet.
const CEILING: usize = 11;

fn compute_budget_program() -> Pubkey {
    "ComputeBudget111111111111111111111111111111".parse().expect("compute budget program id")
}

/// `SetComputeUnitLimit` and `SetComputeUnitPrice` — what the treasurer will actually
/// send: the deposit no longer fits in the default 200k by the fifth rung,
/// and without a priority fee the transaction risks not making it into a busy block.
fn budget_instructions() -> Vec<common::svm::Instruction> {
    let program = key(compute_budget_program());

    let mut limit = vec![2u8];
    limit.extend_from_slice(&1_400_000u32.to_le_bytes());

    let mut price = vec![3u8];
    price.extend_from_slice(&1_000u64.to_le_bytes());

    vec![
        common::svm::Instruction { program_id: program, accounts: vec![], data: limit },
        common::svm::Instruction { program_id: program, accounts: vec![], data: price },
    ]
}

/// A stand with `rungs` epochs and an open ladder, ready for the deposit.
fn ladder_of(rungs: usize) -> (Env, Pubkey, Vec<i64>, common::svm::Instruction) {
    let owner = Pubkey::new_unique();
    let maturities: Vec<i64> = (1..=rungs).map(|i| NOW + (i as i64) * 30 * DAY).collect();

    let mut env = Env::new(YieldSource::Deterministic { rate_bps: 600 });
    env.fund(owner);

    let ladder = env.ladder(owner, 0);
    env.expect_created(ladder);
    for maturity in &maturities {
        let epoch = env.epoch(*maturity);
        env.expect_created(epoch);
        env.expect_created(env.rung(ladder, epoch));
    }

    let amount = 1_000_000_000_000;
    let source = env.fund_tokens(owner, amount);
    let deposit = env.ladder_deposit(
        owner,
        0,
        source,
        amount,
        Distribution::Even { rungs: rungs as u8 },
        &maturities,
    );

    (env, owner, maturities, deposit)
}

/// The size of the signed deposit transaction — computed by `solana-message`,
/// not by our arithmetic: checking a formula of our own instead of the network limit
/// would be checking the wrong thing.
fn transaction_bytes(rungs: usize, with_budget: bool) -> usize {
    let (_, owner, _, deposit) = ladder_of(rungs);

    let mut instructions = if with_budget { budget_instructions() } else { Vec::new() };
    instructions.push(deposit);

    let message = solana_message::Message::new(&instructions, Some(&key(owner)));

    message.serialize().len() + SIGNATURE_BYTES
}

fn run_deposit(rungs: usize) -> InstructionResult {
    let (env, owner, maturities, deposit) = ladder_of(rungs);

    let success: &[Check] = &[Check::success()];
    let mut chain = vec![env.init_market(25)];
    for maturity in &maturities {
        chain.push(env.create_epoch(env.authority, *maturity, 800));
    }
    chain.push(env.open_ladder(owner, 0, RollPolicy::None));
    chain.push(deposit);

    let steps: Vec<(&common::svm::Instruction, &[Check])> =
        chain.iter().map(|ix| (ix, success)).collect();

    env.mollusk.process_and_validate_instruction_chain(&steps, &env.accounts)
}

#[test]
fn eleven_rungs_is_the_ceiling_for_one_signature() {
    assert!(
        transaction_bytes(CEILING, true) <= PACKET_BYTES,
        "{CEILING} rungs must fit: {} bytes",
        transaction_bytes(CEILING, true)
    );
    assert!(
        transaction_bytes(CEILING + 1, true) > PACKET_BYTES,
        "{} rungs fit — the ceiling has risen, and that must be a conscious decision",
        CEILING + 1
    );
}

#[test]
fn the_ceiling_is_set_by_the_transaction_the_treasurer_actually_sends() {
    // Without the budget instructions one more rung would fit in the packet — but such a
    // transaction would not execute: the deposit exceeds the default 200k
    // compute units, and they can only be raised by those same instructions.
    assert!(transaction_bytes(CEILING + 1, false) <= PACKET_BYTES);
    assert!(run_deposit(CEILING).compute_units_consumed > DEFAULT_CU);
}

#[test]
fn the_ceiling_ladder_stays_within_the_compute_cap() {
    let result = run_deposit(CEILING);

    assert!(
        result.compute_units_consumed < MAX_CU,
        "a deposit of {CEILING} rungs consumed {} of {MAX_CU}",
        result.compute_units_consumed
    );
}

#[test]
fn a_rung_costs_a_bounded_amount_of_compute() {
    // The cost of a rung is linear and bounded: if it creeps up, the ceiling
    // will fall in compute rather than bytes, and the byte test will not see it.
    let one = run_deposit(1).compute_units_consumed;
    let ceiling = run_deposit(CEILING).compute_units_consumed;
    let marginal = (ceiling - one) / (CEILING as u64 - 1);

    assert!(marginal < 25_000, "a rung costs {marginal} compute units");
}
