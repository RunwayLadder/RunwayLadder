/**
 * Input for the inflow projection (FR-008).
 *
 * `projectCashflow()` does the monthly math; here there is only the translation of two
 * sources (the ladder from the network, the M0 prototype) into one shape. Both translations
 * sit side by side on purpose: a discrepancy between what the prototype chart shows and
 * what it shows on live data is only noticeable when they are in one file.
 */

import {
  type FloatingPosition,
  fee,
  promise,
  type RungInflow,
  splitLadder,
} from '@runway-ladder/math'
import type { LadderView } from '@runway-ladder/sdk'
import { arrivalOf, type SettlementPreviews } from '@/lib/arrival'
import { prototypeMarket, publishedEpochs, treasury } from '@/lib/treasuryMock'

const SECONDS_PER_DAY = 86_400

/**
 * The ladder's open rungs as inflows — what is still coming to the treasury.
 *
 * A closed rung is not: a redeemed one has already arrived, and a rolled one lives on as a newer
 * rung of the same ladder under its own promise, so charting it as well would count the same
 * money twice.
 *
 * A matured rung that is not redeemed yet is due now, not on a past date: the window starts at
 * `nowSeconds`, and a past date would push it out of the chart — together with the deficit
 * FR-011a requires to be visible **before** the treasurer receives it. `settled` is whatever
 * decides its amount: the settled epoch, or the program's own answer for settling it now.
 */
export function toInflows(
  view: LadderView,
  previews: SettlementPreviews,
  nowSeconds: number,
): RungInflow[] {
  return view.rungs.flatMap((entry) => {
    const arrival = arrivalOf(entry, previews)
    if (!arrival) return []

    return [
      {
        maturityTs: Math.max(Number(entry.epoch.maturityTs), nowSeconds),
        promised: arrival.promised,
        settled: arrival.kind === 'promise' ? null : arrival.amount,
      },
    ]
  })
}

/**
 * The prototype ladder in machine form: the same 1,000,000 layout the table
 * shows, computed with the same math as the form. No second set of numbers
 * for the chart — that is exactly how they drift apart.
 */
export function prototypeInflows(nowSeconds: number): RungInflow[] {
  const parts = splitLadder(1_000_000_000_000n, { kind: 'even', rungs: publishedEpochs.length })

  return publishedEpochs.map((epoch, index) => {
    const part = parts[index] ?? 0n
    const split = fee(part, prototypeMarket.feeBps)
    const seconds = epoch.termDays * SECONDS_PER_DAY

    return {
      maturityTs: nowSeconds + seconds,
      promised: promise(split.working, epoch.rateBps, seconds),
      settled: null,
    }
  })
}

/**
 * The prototype's floating part: what did not go into the ladder, at the mock rate.
 * On the network there is nowhere to take it from — the treasury wallet balance is a
 * different state, and the dashboard cannot read it, so in live mode it is zero.
 */
export const PROTOTYPE_FLOATING: FloatingPosition = {
  amount: 400_000_000_000n,
  rateBps: Number(treasury.floatingRate.replace('%', '')) * 100,
}

export const NO_FLOATING: FloatingPosition = { amount: 0n, rateBps: 0 }
