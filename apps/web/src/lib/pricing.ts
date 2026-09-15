/**
 * Where the form takes prices from: the network or the prototype.
 *
 * The fee, the minimum rung size and the mint's decimals are market
 * parameters; the rate, the operator and the moment it was set are epoch parameters. Mixing
 * what was read with what was invented is not allowed: half-real numbers on screen are
 * worse than an honestly labelled prototype, because they look the same.
 */

import type { Epoch } from '@runway-ladder/sdk'
import type { MarketParams, PublishedEpoch } from '@/lib/plan'

export const SECONDS_PER_DAY = 86_400n

const shortAddress = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`

/**
 * Epoch from the network → a row of the form's calendar.
 *
 * The term is counted from "now" rather than stored in the account: what lies onchain is
 * the maturity date, and that is the truth. The term is how the date looks today,
 * and tomorrow it is different.
 */
export function toPublishedEpoch(epoch: Epoch, nowSeconds: bigint): PublishedEpoch {
  const seconds = epoch.maturityTs - nowSeconds

  return {
    termDays: Number(seconds / SECONDS_PER_DAY),
    rateBps: epoch.rateBps,
    maturityTs: epoch.maturityTs,
    operator: shortAddress(epoch.createdBy.toBase58()),
    ratesSetAt: epoch.createdAt,
  }
}

/**
 * Epochs that have not matured yet. A matured epoch is neither an error nor garbage: it
 * simply cannot be entered, and `ladder_deposit` would reject such a rung
 * (`EpochAlreadyMatured`). The form must not offer what the network will refuse.
 */
export function upcoming(epochs: readonly Epoch[], nowSeconds: bigint): PublishedEpoch[] {
  return epochs
    .filter((epoch) => epoch.maturityTs - nowSeconds >= SECONDS_PER_DAY)
    .map((epoch) => toPublishedEpoch(epoch, nowSeconds))
}

export type Pricing =
  | {
      readonly kind: 'chain' | 'prototype'
      readonly market: MarketParams
      readonly calendar: readonly PublishedEpoch[]
    }
  | { readonly kind: 'unavailable'; readonly reason: string }
