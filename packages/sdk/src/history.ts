/**
 * The redemption history (FR-015): when, how much, and where the funds went.
 *
 * A row starts from the **account**, not from the event. A rung whose status is no longer
 * `Active` was closed — the amount, the deficit and, for a roll, the new rung are written
 * there and cannot be lost. The event adds what the account does not keep: the moment and
 * the token account the funds went to. Logs can be truncated or no longer served by the node,
 * and that must cost the row its date, never the row itself.
 *
 * The transaction is found from the rung, not from the ladder. A rung is touched by exactly
 * two transactions — the one that issued it and the one that closed it — so two signatures
 * cover it, without paging through every deposit the ladder ever received.
 */

import type { Connection, PublicKey } from '@solana/web3.js'
import { programEvents, type RungClosure, rungClosures } from './events.js'

export type HistoryReader = Pick<Connection, 'getSignaturesForAddress' | 'getTransaction'>

export type ClosureLookup =
  | { readonly kind: 'found'; readonly closure: RungClosure; readonly signature: string }
  | { readonly kind: 'missing'; readonly reason: string }

/** Issuance and closure: a rung has no third transaction. */
const RUNG_TRANSACTIONS = 2

export async function fetchRungClosure(
  connection: HistoryReader,
  rung: PublicKey,
  programId: PublicKey,
): Promise<ClosureLookup> {
  const signatures = await connection.getSignaturesForAddress(
    rung,
    { limit: RUNG_TRANSACTIONS },
    'confirmed',
  )

  let unserved = false
  let truncated = false
  for (const { signature, err } of signatures) {
    // A failed transaction changed nothing — including the status this row is built from.
    if (err) continue

    const transaction = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    const logs = transaction?.meta?.logMessages
    if (!logs) {
      unserved = true
      continue
    }

    const parsed = programEvents(logs, programId)
    truncated ||= parsed.truncated
    const closure = rungClosures(parsed.events).find((event) => event.rung.equals(rung))
    if (closure) return { kind: 'found', closure, signature }
  }

  if (truncated) return { kind: 'missing', reason: 'the node truncated the transaction logs' }
  if (unserved) return { kind: 'missing', reason: 'the node did not return the transaction' }

  return { kind: 'missing', reason: 'the node holds no closing transaction for this rung' }
}
