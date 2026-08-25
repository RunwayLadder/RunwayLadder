import { assertAmount, assertCount } from './guards.js'
import { promise } from './promise.js'

/**
 * Inflow projection (FR-008).
 *
 * **Why this module has no twin in `programs/treasury-runway`.** The rule of
 * duplicated math applies to numbers the program pays: the deposit layout,
 * the promise, the waterfall. A projection is presentation, not payment: the chain never draws
 * a chart and has no instruction that depends on one. Duplicating it
 * in Rust would mean keeping a second implementation that nothing inside the
 * program can verify. Shared vectors are redundant here too — there is nothing to compare against.
 *
 * The numbers the projection is made of are nevertheless duplicated: `promise()` gives both
 * the rung's promise and the floating-part estimate (see `accrue` below).
 */

/** One rung as the projection sees it. */
export type RungInflow = {
  /** Absolute maturity time in seconds — the same `maturity_ts` as in `Epoch`. */
  readonly maturityTs: number
  /** Promised at issuance. Immutable after it. */
  readonly promised: bigint
  /**
   * What was actually paid out if the epoch has been settled, otherwise `null`.
   *
   * FR-011a: the projection shows the actual amount instead of the promised one **before**
   * the treasurer receives it. Hence not an optional field but an explicit `null` — the caller
   * must say the epoch is not settled yet, not forget about it.
   */
  readonly settled: bigint | null
}

/** The part of the treasury left at the floating rate. */
export type FloatingPosition = {
  readonly amount: bigint
  readonly rateBps: number
}

export type CashflowRequest = {
  /** Start of the projection. The first month is the UTC calendar month containing this time. */
  readonly fromTs: number
  /** How many calendar months to show. FR-008: horizon up to 12. */
  readonly months: number
  readonly rungs: readonly RungInflow[]
  readonly floating: FloatingPosition
}

export type CashflowMonth = {
  /** `YYYY-MM` in UTC — unambiguous and sorts as a string. */
  readonly month: string
  readonly startTs: number
  /** Exclusive: a maturity exactly on the boundary belongs to the next month. */
  readonly endTs: number
  /**
   * What will really arrive: the actual amount where the epoch is settled, the promised one
   * where it is not yet. This is the figure the treasurer puts into the budget.
   */
  readonly guaranteed: bigint
  /**
   * What was promised at issuance. `guaranteed < promised` means a deficit arrives
   * in this month — exactly what FR-011a requires to be shown in advance.
   */
  readonly promised: bigint
  /** Estimated income of the floating part for this month. Not a promise. */
  readonly floating: bigint
}

export type CashflowForecast = {
  readonly months: CashflowMonth[]
  /**
   * Rungs that did not fall into the window — earlier than `fromTs` or later than the
   * horizon. Without this field the charted total would silently drift from the ladder,
   * while SC-005 requires a drift of 0.
   */
  readonly outsideHorizon: { readonly guaranteed: bigint; readonly promised: bigint }
}

/** FR-008 names the horizon limit; the projection does not go beyond 12 months. */
const MAX_MONTHS = 12

export function projectCashflow(request: CashflowRequest): CashflowForecast {
  const { fromTs, months, rungs, floating } = request

  assertCount('fromTs', fromTs)
  assertCount('months', months)
  assertAmount('floating.amount', floating.amount)
  assertCount('floating.rateBps', floating.rateBps)

  if (months < 1 || months > MAX_MONTHS) {
    throw new RangeError(`projection horizon is 1 to ${MAX_MONTHS} months, got ${months}`)
  }

  const bounds = monthBounds(fromTs, months)
  const buckets = bounds.map(({ month, startTs, endTs }) => ({
    month,
    startTs,
    endTs,
    guaranteed: 0n,
    promised: 0n,
    // The first month is counted from `fromTs`, not from the 1st: nobody credits the
    // treasury for the part of the month that has already passed.
    floating: accrue(floating.amount, floating.rateBps, endTs - Math.max(startTs, fromTs)),
  }))

  // The window starts at `fromTs`, not at the 1st of the month: a rung
  // redeemed on the 3rd, when the projection is built on the 20th, is already paid and does
  // not enter the projection. It goes into `outsideHorizon`, so the total stays reconcilable.
  const windowEnd = bounds[bounds.length - 1]?.endTs ?? fromTs
  let outsideGuaranteed = 0n
  let outsidePromised = 0n

  for (const rung of rungs) {
    assertCount('maturityTs', rung.maturityTs)
    assertAmount('promised', rung.promised)
    if (rung.settled !== null) assertAmount('settled', rung.settled)

    const guaranteed = rung.settled ?? rung.promised
    const inWindow = rung.maturityTs >= fromTs && rung.maturityTs < windowEnd
    const bucket = inWindow ? buckets[monthIndex(bounds, rung.maturityTs)] : undefined

    if (bucket === undefined) {
      outsideGuaranteed += guaranteed
      outsidePromised += rung.promised
      continue
    }

    bucket.guaranteed += guaranteed
    bucket.promised += rung.promised
  }

  return {
    months: buckets,
    outsideHorizon: { guaranteed: outsideGuaranteed, promised: outsidePromised },
  }
}

/**
 * Income over `seconds` — exactly the same expression as in the rung's promise, only
 * without the principal. Not a separate formula: the floating-part estimate and the fixed
 * promise must be computed with one arithmetic, otherwise the chart compares incomparables.
 */
function accrue(amount: bigint, rateBps: number, seconds: number): bigint {
  return promise(amount, rateBps, seconds) - amount
}

type MonthBound = { month: string; startTs: number; endTs: number }

/** UTC calendar months, starting with the one containing `fromTs`. */
function monthBounds(fromTs: number, months: number): MonthBound[] {
  const start = new Date(fromTs * 1000)
  const year = start.getUTCFullYear()
  const month = start.getUTCMonth()

  return Array.from({ length: months }, (_, offset) => {
    const startMs = Date.UTC(year, month + offset, 1)
    const endMs = Date.UTC(year, month + offset + 1, 1)

    return {
      month: `${new Date(startMs).getUTCFullYear()}-${String(new Date(startMs).getUTCMonth() + 1).padStart(2, '0')}`,
      startTs: startMs / 1000,
      endTs: endMs / 1000,
    }
  })
}

function monthIndex(bounds: MonthBound[], ts: number): number {
  return bounds.findIndex((bound) => ts >= bound.startTs && ts < bound.endTs)
}
