/**
 * Both implementations of the ladder math — this one and `programs/treasury-runway/src/math.rs` —
 * hold these same numbers. They are duplicated in `fixtures/vectors.json`, and a test checks
 * the copies against each other: a discrepancy in a constant is a discrepancy in the amount
 * the treasurer will see and the program will pay.
 */
export const BPS_DENOMINATOR = 10_000n

/** 365 days. Leap years are not counted: epochs are set in seconds, not years. */
export const SECONDS_PER_YEAR = 31_536_000n
