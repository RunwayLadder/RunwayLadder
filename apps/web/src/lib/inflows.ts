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
} from '@treasury-runway/math'
import type { LadderView } from '@treasury-runway/sdk'
import { prototypeMarket, publishedEpochs, treasury } from '@/lib/treasuryMock'

const SECONDS_PER_DAY = 86_400

/**
 * The ladder's rungs as inflows.
 *
 * `settled` is what was actually paid out, and `null` is what says "epoch not settled yet".
 * A redeemed rung enters the projection with its real amount, not the promised one:
 * FR-011a requires the deficit to be visible before the treasurer receives it.
 */
export function toInflows(view: LadderView): RungInflow[] {
  return view.rungs.map(({ rung, epoch }) => ({
    maturityTs: Number(epoch.maturityTs),
    promised: rung.promised,
    settled: settledOf(rung.status),
  }))
}

function settledOf(status: LadderView['rungs'][number]['rung']['status']): bigint | null {
  switch (status.kind) {
    case 'active':
      return null
    case 'redeemed':
    case 'exited':
      return status.amount
    case 'redeemedWithDeficit':
      return status.amount
  }
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
