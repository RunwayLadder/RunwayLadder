/**
 * What the roll policy switch will sign — and whether it may sign at all.
 *
 * Pure for the same reason as `lib/deposit.ts`: the wallet and the network live in
 * `lib/useRollPolicy.ts`, while the composition of the instruction is decided here and
 * covered by a test without a wallet.
 */

import { buildSetRollPolicy, type LadderView, type RollPolicy } from '@runway-ladder/sdk'
import type { PublicKey, TransactionInstruction } from '@solana/web3.js'

export type RollPolicyAction =
  | {
      readonly kind: 'ready'
      readonly next: RollPolicy
      readonly instruction: TransactionInstruction
    }
  | { readonly kind: 'blocked'; readonly reason: string }

/** The switch has two positions, so the next policy is always the other one. */
export const nextRollPolicy = (current: RollPolicy): RollPolicy =>
  current === 'roll' ? 'none' : 'roll'

/**
 * The instruction that flips the policy the ladder holds **on the network** — not the one
 * the screen last showed. The ladder address is taken from the read view, not re-derived:
 * the account that was read is the one being changed.
 *
 * A wallet that is not the owner is refused here rather than by the program: the network
 * would refuse it too (`NotLadderOwner`), but only after the treasurer paid for the attempt.
 */
export function rollPolicyAction({
  owner,
  view,
  programId,
}: {
  owner: PublicKey | null
  view: LadderView
  programId: PublicKey
}): RollPolicyAction {
  if (!owner) return { kind: 'blocked', reason: 'Connect the owner wallet to change the policy.' }
  if (!owner.equals(view.ladder.owner)) {
    return { kind: 'blocked', reason: 'Only the ladder owner can change the policy.' }
  }

  const next = nextRollPolicy(view.ladder.rollPolicy)

  return {
    kind: 'ready',
    next,
    instruction: buildSetRollPolicy({
      owner,
      ladder: view.address,
      rollPolicy: next,
      programId,
    }),
  }
}
