import { BPS_DENOMINATOR } from './constants.js'
import { assertAmount, assertCount } from './guards.js'

/**
 * How the treasurer divides the amount between rungs.
 *
 * The even split is a separate variant, not sugar over the weights
 * `[10000 / n, ...]`: for `n` that does not divide 10000 (3, 6, 7) such integer weights do
 * not exist at all, and a round-trip through bps would give a split that is called
 * even but is not.
 */
export type Distribution =
  | { readonly kind: 'even'; readonly rungs: number }
  | { readonly kind: 'weighted'; readonly weightsBps: readonly number[] }

/**
 * Splitting the ladder amount across rungs.
 *
 * The invariant the test checks: `sum(parts) === total` for any input.
 * The division remainder is neither dropped nor duplicated — the ladder has no right
 * to promise an amount other than the one it accepted.
 *
 * The remainder is handed out one unit at a time, starting from the first rung. The choice
 * is arbitrary, but it must be the same in `programs/treasury-runway` and here,
 * which is why it is fixed in `fixtures/vectors.json` rather than in a comment of one of
 * the implementations. The difference between rungs never exceeds one unit.
 *
 * There is deliberately no minimum rung size here: it is a market parameter, not a
 * property of the arithmetic. FR-006 checks it at the boundary, before funds are debited
 * (`ladder_deposit`), and that is where the active minimum is known. For a tiny amount this
 * function honestly returns zeros — and precisely for that reason the minimum check must
 * come before it, not rely on it.
 */
export function splitLadder(total: bigint, distribution: Distribution): bigint[] {
  assertAmount('total', total)

  const parts =
    distribution.kind === 'even'
      ? splitEven(total, distribution.rungs)
      : splitWeighted(total, distribution.weightsBps)

  return spreadRemainder(parts, total)
}

function splitEven(total: bigint, rungs: number): bigint[] {
  assertCount('rungs', rungs)
  if (rungs < 1) {
    throw new RangeError(`a ladder cannot have fewer than one rung, got ${rungs}`)
  }

  const base = total / BigInt(rungs)

  return Array.from({ length: rungs }, () => base)
}

function splitWeighted(total: bigint, weightsBps: readonly number[]): bigint[] {
  if (weightsBps.length === 0) {
    throw new RangeError('a ladder cannot have fewer than one rung, no weights given')
  }

  let sum = 0n
  for (const [index, weight] of weightsBps.entries()) {
    assertCount(`weightsBps[${index}]`, weight)
    if (weight === 0) {
      throw new RangeError(
        `weight of rung ${index + 1} is zero: a rung without funds must not exist, ` +
          'remove it from the ladder instead of giving it a zero weight',
      )
    }
    sum += BigInt(weight)
  }

  // Weights must add up to the whole — normalisation would add a second rounding where
  // the first one already costs units. A mismatch here is a caller error, not a reason
  // to guess the intent.
  if (sum !== BPS_DENOMINATOR) {
    throw new RangeError(`weights must add up to ${BPS_DENOMINATOR} bps, got ${sum}`)
  }

  return weightsBps.map((weight) => (total * BigInt(weight)) / BPS_DENOMINATOR)
}

/**
 * Each division rounds down and loses less than one unit, so the remainder is always smaller
 * than the number of rungs and is handed out exactly one unit each.
 */
function spreadRemainder(parts: bigint[], total: bigint): bigint[] {
  let remainder = total
  for (const part of parts) remainder -= part

  return parts.map((part, index) => (BigInt(index) < remainder ? part + 1n : part))
}
