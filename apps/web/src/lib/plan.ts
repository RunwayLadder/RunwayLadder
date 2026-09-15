/**
 * The deposit plan: what the treasurer typed into the form, validated and computed before
 * signing.
 *
 * Every refusal here duplicates an onchain check on purpose — the program would say the
 * same, but after signing. The numbers come from `packages/math`, the same module the
 * Rust mirror is made from: the preview has no right to show an amount different from
 * the one `ladder_deposit` will create.
 */

import { type Distribution, fee, promise, splitLadder } from '@runway-ladder/math'
import { MAX_RUNGS_PER_DEPOSIT } from '@runway-ladder/sdk'
import { formatAmount, parseAmount } from '@/lib/amount'

export const SECONDS_PER_DAY = 86_400

/** Market parameters that constrain the deposit. Onchain they live in `Market`. */
export type MarketParams = {
  /** Asset symbol for explanations. The logic does not rely on it (FR-001). */
  readonly symbol: string
  /** The base yield source in words (FR-009b) — the same for all rungs. */
  readonly source: string
  readonly decimals: number
  readonly feeBps: number
  readonly minRungAmount: bigint
}

/**
 * An epoch whose rate the operator has already published. The ladder is built **from
 * published dates**, not arbitrary ones: `maturityTs` is part of the epoch seeds, and
 * a date invented by the client would point at an account that does not exist.
 */
export type PublishedEpoch = {
  readonly termDays: number
  readonly rateBps: number
  readonly maturityTs: bigint
  /** Who set the rate. FR-010a: trust in the operator must not be implicit. */
  readonly operator: string
  /** When it was set, in Unix seconds. */
  readonly ratesSetAt: bigint
}

export type PlanInput = {
  readonly amount: string
  readonly horizonDays: number
  readonly rungCount: number
  readonly distribution: 'even' | 'weighted'
  /** Percentages as strings, as typed. Length must match `rungCount`. */
  readonly weights: readonly string[]
}

export type PlanRung = {
  readonly index: number
  /** The whole epoch, not numbers pulled out of it: the rate disclosure (FR-010a)
   *  needs the operator and the moment just as the table needs the amount. */
  readonly epoch: PublishedEpoch
  readonly deposited: bigint
  readonly fee: bigint
  readonly working: bigint
  readonly guaranteed: bigint
}

export type Plan = {
  readonly amount: bigint
  readonly distribution: Distribution
  readonly rungs: readonly PlanRung[]
  readonly totals: {
    readonly deposited: bigint
    readonly fee: bigint
    readonly working: bigint
    readonly guaranteed: bigint
    readonly netGain: bigint
  }
}

export type ProblemField = 'amount' | 'rungs' | 'weights'

export type Problem = { readonly field: ProblemField; readonly message: string }

export type PlanResult =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly problems: readonly Problem[] }

/** Published epochs that fall within the horizon, ascending by term. */
export function maturitiesWithin(
  calendar: readonly PublishedEpoch[],
  horizonDays: number,
): PublishedEpoch[] {
  return calendar
    .filter((entry) => entry.termDays <= horizonDays)
    .sort((a, b) => a.termDays - b.termDays)
}

/**
 * How many rungs can be taken at all. Two limits, both real: how many dates
 * the operator published and how many rungs fit in one signature —
 * **11**, measured by the `deposit_limits.rs` test. The smaller one sits in the form so
 * the treasurer sees the limit before signing, not as a network refusal.
 */
export function maxRungs(calendar: readonly PublishedEpoch[], horizonDays: number): number {
  return Math.min(MAX_RUNGS_PER_DEPOSIT, maturitiesWithin(calendar, horizonDays).length)
}

/**
 * Which dates are taken for `n` rungs: evenly by index among the published
 * ones, with the last one always being the end of the horizon. A ladder that does
 * not reach the declared horizon would be called a 180-day ladder
 * while having 90.
 */
export function pickMaturities(
  available: readonly PublishedEpoch[],
  rungCount: number,
): PublishedEpoch[] {
  if (rungCount >= available.length) return [...available]
  if (rungCount === 1) {
    const last = available.at(-1)
    return last ? [last] : []
  }

  const step = (available.length - 1) / (rungCount - 1)

  return Array.from({ length: rungCount }, (_, index) => {
    const entry = available[Math.round(index * step)]
    if (!entry) throw new RangeError('date outside the list of published epochs')

    return entry
  })
}

/** Percentage string → bps. `25` → 2500, `12.5` → 1250. More than two decimals — no. */
function parseWeightBps(input: string): number | null {
  const cleaned = input
    .trim()
    .replace(/[\s,_]/g, '')
    .replace('%', '')
  if (!/^\d*(\.\d{0,2})?$/.test(cleaned) || cleaned === '' || cleaned === '.') return null

  const [whole = '', fraction = ''] = cleaned.split('.')

  return Number(`${whole || '0'}${fraction.padEnd(2, '0')}`)
}

function distributionOf(
  input: PlanInput,
  problems: Problem[],
): { kind: 'even'; rungs: number } | { kind: 'weighted'; weightsBps: number[] } | null {
  if (input.distribution === 'even') {
    return { kind: 'even', rungs: input.rungCount }
  }

  if (input.weights.length !== input.rungCount) {
    problems.push({
      field: 'weights',
      message: `Enter one weight per rung — ${input.rungCount} expected.`,
    })
    return null
  }

  const weightsBps: number[] = []
  for (const [index, raw] of input.weights.entries()) {
    const bps = parseWeightBps(raw)
    if (bps === null) {
      problems.push({ field: 'weights', message: `Rung ${index + 1}: weight is not a percentage.` })
      return null
    }
    if (bps === 0) {
      problems.push({
        field: 'weights',
        message: `Rung ${index + 1} has zero weight. Remove the rung instead — a rung with no funds should not exist.`,
      })
      return null
    }
    weightsBps.push(bps)
  }

  const sum = weightsBps.reduce((total, bps) => total + bps, 0)
  if (sum !== 10_000) {
    problems.push({
      field: 'weights',
      message: `Weights must add up to 100% — they add up to ${(sum / 100).toFixed(2)}%.`,
    })
    return null
  }

  return { kind: 'weighted', weightsBps }
}

/**
 * The order of checks is the order in which the treasurer reads them. First the amount, then
 * the rung count, then the weights, and only then the minimum: saying "less than the
 * minimum per rung" about an amount that is not even a number answers the wrong question.
 */
export function buildPlan(
  input: PlanInput,
  market: MarketParams,
  calendar: readonly PublishedEpoch[],
): PlanResult {
  const problems: Problem[] = []

  const amount = parseAmount(input.amount, market.decimals)
  if (amount === null) {
    problems.push({
      field: 'amount',
      message: `Enter an amount with at most ${market.decimals} decimal places.`,
    })
  } else if (amount === 0n) {
    problems.push({ field: 'amount', message: 'Enter an amount greater than zero.' })
  }

  const available = maturitiesWithin(calendar, input.horizonDays)
  if (input.rungCount < 1) {
    problems.push({ field: 'rungs', message: 'A ladder needs at least one rung.' })
  }
  if (input.rungCount > MAX_RUNGS_PER_DEPOSIT) {
    problems.push({
      field: 'rungs',
      message: `${input.rungCount} rungs do not fit in one signature — the measured limit is ${MAX_RUNGS_PER_DEPOSIT}.`,
    })
  }
  if (input.rungCount > available.length) {
    problems.push({
      field: 'rungs',
      message: `Only ${available.length} maturities are published within ${input.horizonDays} days.`,
    })
  }

  const distribution = distributionOf(input, problems)

  if (amount === null || amount === 0n || distribution === null || problems.length > 0) {
    return { ok: false, problems }
  }

  const parts = splitLadder(amount, distribution)
  const smallest = parts.reduce((min, part) => (part < min ? part : min), parts[0] ?? 0n)
  if (smallest < market.minRungAmount) {
    return {
      ok: false,
      problems: [
        {
          field: 'amount',
          message: minimumMessage(input.rungCount, market, distribution.kind === 'weighted'),
        },
      ],
    }
  }

  const maturities = pickMaturities(available, input.rungCount)
  const rungs = parts.map((deposited, index) => {
    const epoch = maturities[index]
    if (!epoch) throw new RangeError('rung without a published maturity date')

    const split = fee(deposited, market.feeBps)

    return {
      index: index + 1,
      epoch,
      deposited,
      fee: split.fee,
      working: split.working,
      guaranteed: promise(split.working, epoch.rateBps, epoch.termDays * SECONDS_PER_DAY),
    }
  })

  const totals = rungs.reduce(
    (sum, rung) => ({
      deposited: sum.deposited + rung.deposited,
      fee: sum.fee + rung.fee,
      working: sum.working + rung.working,
      guaranteed: sum.guaranteed + rung.guaranteed,
    }),
    { deposited: 0n, fee: 0n, working: 0n, guaranteed: 0n },
  )

  return {
    ok: true,
    plan: {
      amount,
      distribution,
      rungs,
      totals: { ...totals, netGain: totals.guaranteed - totals.deposited },
    },
  }
}

/**
 * FR-006 requires the minimum to be named in the explanation. With an even split the
 * total at which the deposit would pass is visible too; with weights it is not, because it
 * depends on the smallest weight, and guessing it on the treasurer's behalf is not worth it.
 */
function minimumMessage(rungCount: number, market: MarketParams, weighted: boolean): string {
  const min = formatMinimum(market)
  if (weighted) {
    return `Each rung must hold at least ${min} — the smallest weight falls below it. No funds have been moved.`
  }

  return `Each rung must hold at least ${min}. ${rungCount} rungs need at least ${formatMinimum(market, BigInt(rungCount))} in total. No funds have been moved.`
}

function formatMinimum(market: MarketParams, times = 1n): string {
  return `${formatAmount(market.minRungAmount * times, market.decimals)} ${market.symbol}`
}

/**
 * The blended net rate is a statistic for the screen, not money: the ladder's yield
 * annualised over the average term, weighted by rung amounts. It is computed
 * from the same exact `bigint`s, but already as a `number`: nobody gets paid
 * this number, and showing it to the precision of a mint unit would be
 * pretending to measure where there is only an estimate.
 */
export function blendedNetRatePercent(plan: Plan): number {
  const deposited = Number(plan.totals.deposited)
  if (deposited === 0) return 0

  const weightedDays =
    plan.rungs.reduce((sum, rung) => sum + Number(rung.deposited) * rung.epoch.termDays, 0) /
    deposited

  return (Number(plan.totals.netGain) / deposited) * (365 / weightedDays) * 100
}

/**
 * Equal weights in bps for `n` rungs. The remainder is handed to the first rungs one
 * unit each — exactly as `splitLadder()` hands it out, otherwise "even" in the
 * form and "even" in the deposit would mean different things.
 */
export function evenWeightsBps(rungCount: number): number[] {
  const base = Math.floor(10_000 / rungCount)
  const remainder = 10_000 - base * rungCount

  return Array.from({ length: rungCount }, (_, index) => base + (index < remainder ? 1 : 0))
}
