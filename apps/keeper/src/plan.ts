/**
 * What a tick should do, decided from accounts alone — no network, no clock of its own.
 *
 * The time is the chain's (`Clock`), read by the caller: the program checks maturity against
 * it, and a keeper deciding by its own clock would send settlements the program refuses as
 * "not matured yet", or wait a tick for nothing. The comparisons here are the program's own
 * (`maturity_ts <= now` to settle, `> now` for a roll target).
 */

import type { EpochView, Market, RungEntry } from '@runway-ladder/sdk'

/** Matured and still active — settled once, by whoever comes first. */
export function epochsToSettle(epochs: readonly EpochView[], now: bigint): EpochView[] {
  return epochs.filter((e) => e.epoch.status.kind === 'active' && e.epoch.maturityTs <= now)
}

/**
 * The epoch every roll goes into: the market's furthest, while it is still ahead.
 *
 * `null` when the operator has not opened a later date. The keeper does not open one: it holds
 * no operator key, and the rate of a new date is the operator's word, not a crank's. The rung
 * waits — or its owner redeems it.
 */
export function rollTarget(
  market: Market,
  epochs: readonly EpochView[],
  now: bigint,
): EpochView | null {
  const target = epochs.find((e) => e.epoch.maturityTs === market.latestMaturity)

  return target && target.epoch.maturityTs > now ? target : null
}

/**
 * The ladder's rungs that are ready to roll: active, in a settled epoch.
 *
 * A rung in a matured but unsettled epoch is not among them — its payout does not exist yet.
 * The tick settles first and reads the epochs again, so this is only the case when that
 * settlement failed. In the ladder's own order: each roll takes the next number.
 */
export function rungsToRoll(
  rungs: readonly RungEntry[],
  epochs: readonly EpochView[],
): RungEntry[] {
  const settled = new Set(
    epochs.filter((e) => e.epoch.status.kind !== 'active').map((e) => e.address.toBase58()),
  )

  return rungs
    .filter((r) => r.rung.status.kind === 'active' && settled.has(r.rung.epoch.toBase58()))
    .sort((a, b) => a.rung.index - b.rung.index)
}
