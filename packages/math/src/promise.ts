import { BPS_DENOMINATOR, SECONDS_PER_YEAR } from './constants.js'
import { assertAmount, assertCount } from './guards.js'

/**
 * The rung's promise: how much the treasury receives on the maturity date for `working`
 * placed at `rateBps` per annum for `seconds`.
 *
 * Rounding down is deliberate: the protocol never promises more than the exact value.
 * Rounding up would create money that does not exist, precisely where the product
 * promises certainty.
 */
export function promise(working: bigint, rateBps: number, seconds: number): bigint {
  assertAmount('working', working)
  assertCount('rateBps', rateBps)
  assertCount('seconds', seconds)

  const yield_ =
    (working * BigInt(rateBps) * BigInt(seconds)) / (BPS_DENOMINATOR * SECONDS_PER_YEAR)

  return working + yield_
}
