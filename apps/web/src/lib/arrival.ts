/**
 * What an open rung will actually pay the treasury (FR-011a).
 *
 * One answer for the chart, the table, the tiles and the Redeem button. They used to read the
 * amount from the rung's own status, which only changes when the rung is redeemed — so a deficit
 * the epoch had already settled with stayed invisible until the money arrived short.
 */

import { payout } from '@runway-ladder/math'
import type { RungView, SettledStatus } from '@runway-ladder/sdk'

/** What settling one matured epoch would decide now, or why that is not known. */
export type SettlementPreview =
  | { readonly kind: 'previewed'; readonly status: SettledStatus }
  | { readonly kind: 'failed'; readonly reason: string }

/** Keyed by the epoch address. Only matured, unsettled epochs are ever in it. */
export type SettlementPreviews = ReadonlyMap<string, SettlementPreview>

export const NO_PREVIEWS: SettlementPreviews = new Map()

/**
 * - `promise` — nothing decides the amount yet: the rung has not matured, or its settlement
 *   could not be previewed (`reason` says why).
 * - `settled` — the epoch is settled, the rung is not redeemed: the amount is final.
 * - `ifSettledNow` — the epoch is matured but unsettled: what the program would settle it for
 *   in the chain's current state. Not final — a top-up of the reserve before settlement raises it.
 */
export type Arrival =
  | { readonly kind: 'promise'; readonly promised: bigint; readonly reason?: string }
  | { readonly kind: 'settled'; readonly amount: bigint; readonly promised: bigint }
  | { readonly kind: 'ifSettledNow'; readonly amount: bigint; readonly promised: bigint }

/**
 * The arrival of an open rung; `null` for a closed one — its status already carries what it
 * settled for, and that money is no longer coming.
 */
export function arrivalOf(entry: RungView, previews: SettlementPreviews): Arrival | null {
  const { rung, epoch } = entry
  if (rung.status.kind !== 'active') return null

  const promised = rung.promised
  // The same `payout()` the program applies to every rung of the epoch: one ratio for all.
  const share = (status: SettledStatus) =>
    payout(promised, { paid: status.paid, promised: epoch.totalPromised })

  if (epoch.status.kind !== 'active') {
    return { kind: 'settled', amount: share(epoch.status), promised }
  }

  const preview = previews.get(rung.epoch.toBase58())
  if (preview?.kind === 'previewed') {
    return { kind: 'ifSettledNow', amount: share(preview.status), promised }
  }

  return preview
    ? { kind: 'promise', promised, reason: preview.reason }
    : { kind: 'promise', promised }
}

/** The amount the treasury should expect: the promise until something decides otherwise. */
export const expectedOf = (arrival: Arrival): bigint =>
  arrival.kind === 'promise' ? arrival.promised : arrival.amount

/** Below the promise — the case FR-011a forbids to keep quiet about. */
export const isShort = (arrival: Arrival): boolean => expectedOf(arrival) < arrival.promised

/**
 * The matured, unsettled epochs of the open rungs — the ones worth a simulation. A settled epoch
 * already says its amount, and an epoch before maturity cannot be settled at all.
 */
export function epochsToPreview(
  rungs: readonly RungView[],
  nowSeconds: bigint,
): { readonly key: string; readonly maturityTs: bigint }[] {
  const due = new Map<string, bigint>()
  for (const { rung, epoch } of rungs) {
    if (
      rung.status.kind === 'active' &&
      epoch.status.kind === 'active' &&
      epoch.maturityTs <= nowSeconds
    ) {
      due.set(rung.epoch.toBase58(), epoch.maturityTs)
    }
  }

  return [...due].map(([key, maturityTs]) => ({ key, maturityTs }))
}
