import { BPS_DENOMINATOR } from './constants.js'
import { assertAmount, assertCount } from './guards.js'

export type FeeSplit = {
  /** What the protocol keeps — it also fills the buffer, the second step of the waterfall. */
  fee: bigint
  /** What actually goes to work and what the promise is computed on. */
  working: bigint
}

/**
 * Division rounds down — the protocol never takes more than the exact value. Together with
 * `working = amount - fee` this gives the invariant the test checks: the sum of the parts
 * equals the input amount at any rate, i.e. rounding neither creates
 * nor loses anything.
 */
export function fee(amount: bigint, feeBps: number): FeeSplit {
  assertAmount('amount', amount)
  assertCount('feeBps', feeBps)
  if (BigInt(feeBps) > BPS_DENOMINATOR) {
    throw new RangeError(`feeBps cannot exceed ${BPS_DENOMINATOR}, got ${feeBps}`)
  }

  const taken = (amount * BigInt(feeBps)) / BPS_DENOMINATOR

  return { fee: taken, working: amount - taken }
}
