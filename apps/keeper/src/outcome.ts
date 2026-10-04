/**
 * Telling a refusal the keeper expects from one it should be loud about.
 *
 * The keeper works next to other actors: the treasurer's Redeem button settles the epoch too,
 * the owner may redeem a rung or switch the policy off between our read and our send, and the
 * operator may open a later date. Each of those makes the program refuse our transaction — and
 * each means there is nothing left to do, not that something is broken. Anything else is.
 */

import { SendTransactionError } from '@solana/web3.js'

/** Refusals that mean "someone else got there first" or "this rung waits for its owner". */
const EXPECTED = new Set([
  // settle_epoch
  'EpochAlreadySettled',
  'EpochNotMatured',
  // roll_rung
  'RungNotActive',
  'RollPolicyDisabled',
  'ZeroAmount',
  'RungBelowMinimum',
  'EpochAlreadyMatured',
  'RollTargetNotLatest',
  // A deposit landed between our read of `rung_count` and the roll: the new rung's address is
  // stale. The next tick reads the count again.
  'ConstraintSeeds',
])

/** The Anchor error name from the program's logs (`… Error Code: RungNotActive. …`). */
export function programErrorOf(logs: readonly string[]): string | null {
  for (const line of logs) {
    const match = /Error Code: (\w+)\./.exec(line)
    if (match?.[1]) return match[1]
  }

  return null
}

export type Refusal = { readonly expected: boolean; readonly reason: string }

/** Why a send failed, and whether the keeper should treat it as a skip or a failure. */
export function refusalOf(error: unknown): Refusal {
  const logs = error instanceof SendTransactionError ? (error.logs ?? []) : []
  const code = programErrorOf(logs)
  if (code) return { expected: EXPECTED.has(code), reason: code }

  return { expected: false, reason: error instanceof Error ? error.message : String(error) }
}
