import { describe, expect, it } from 'vitest'
import { formatAmount } from '../src/lib/amount'
import {
  blendedNetRatePercent,
  buildPlan,
  evenWeightsBps,
  type MarketParams,
  maxRungs,
  type PlanInput,
  type PublishedEpoch,
  pickMaturities,
} from '../src/lib/plan'

const market: MarketParams = {
  symbol: 'USDC',
  decimals: 6,
  feeBps: 25,
  minRungAmount: 10_000_000_000n,
}

/** The same calendar as in the prototype: 30/60/90/180 days with the operator rates. */
const operator = { operator: '9fRe…Lq2b', ratesSetAt: 999_000_000n }

const calendar: PublishedEpoch[] = [
  { termDays: 30, rateBps: 480, maturityTs: 1_000_000_000n, ...operator },
  { termDays: 60, rateBps: 520, maturityTs: 1_002_592_000n, ...operator },
  { termDays: 90, rateBps: 560, maturityTs: 1_005_184_000n, ...operator },
  { termDays: 180, rateBps: 620, maturityTs: 1_012_960_000n, ...operator },
]

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  amount: '1000000',
  horizonDays: 180,
  rungCount: 4,
  distribution: 'even',
  weights: [],
  ...over,
})

const planOf = (over: Partial<PlanInput> = {}) => {
  const result = buildPlan(input(over), market, calendar)
  if (!result.ok) throw new Error(result.problems.map((p) => p.message).join(' | '))

  return result.plan
}

const problems = (over: Partial<PlanInput> = {}) => {
  const result = buildPlan(input(over), market, calendar)
  if (result.ok) throw new Error('expected a refusal, but the plan was built')

  return result.problems
}

describe('M0 reference ladder', () => {
  /**
   * The numbers are taken from the prototype accepted in M0, and the computed plan must
   * give exactly them. This is not a "layout test": a discrepancy here would mean the screen
   * shows something other than what `ladder_deposit` will create.
   */
  it('gives the same numbers the prototype showed', () => {
    const plan = planOf()
    const shown = plan.rungs.map((rung) => ({
      term: rung.epoch.termDays,
      deposited: formatAmount(rung.deposited, 6),
      fee: formatAmount(rung.fee, 6),
      working: formatAmount(rung.working, 6),
      guaranteed: formatAmount(rung.guaranteed, 6),
    }))

    expect(shown).toEqual([
      {
        term: 30,
        deposited: '250,000.00',
        fee: '625.00',
        working: '249,375.00',
        guaranteed: '250,358.83',
      },
      {
        term: 60,
        deposited: '250,000.00',
        fee: '625.00',
        working: '249,375.00',
        guaranteed: '251,506.64',
      },
      {
        term: 90,
        deposited: '250,000.00',
        fee: '625.00',
        working: '249,375.00',
        guaranteed: '252,818.42',
      },
      {
        term: 180,
        deposited: '250,000.00',
        fee: '625.00',
        working: '249,375.00',
        guaranteed: '256,999.72',
      },
    ])

    expect(formatAmount(plan.totals.guaranteed, 6)).toBe('1,011,683.63')
    expect(formatAmount(plan.totals.netGain, 6)).toBe('11,683.63')
    expect(blendedNetRatePercent(plan).toFixed(2)).toBe('4.74')
  })

  it('the sum of rungs equals the deposited amount', () => {
    for (const amount of ['1000000', '999999.999999', '123456.78']) {
      const plan = planOf({ amount })
      const sum = plan.rungs.reduce((total, rung) => total + rung.deposited, 0n)

      expect(sum).toBe(plan.amount)
    }
  })
})

describe('deposit limits', () => {
  it('the ceiling is 11 rungs, and it sits in the form', () => {
    const many: PublishedEpoch[] = Array.from({ length: 20 }, (_, index) => ({
      termDays: index + 1,
      rateBps: 500,
      maturityTs: BigInt(1_000_000_000 + index),
      ...operator,
    }))

    expect(maxRungs(many, 365)).toBe(11)
    expect(
      problems({ rungCount: 12 })
        .map((p) => p.message)
        .join(),
    ).toContain('11')
  })

  it('more rungs than published dates is a refusal with a number', () => {
    const message = problems({ rungCount: 6 })
      .map((p) => p.message)
      .join()

    expect(message).toContain('Only 4 maturities')
  })

  it('the horizon cuts off distant dates', () => {
    expect(maxRungs(calendar, 90)).toBe(3)
    expect(maxRungs(calendar, 29)).toBe(0)
  })

  /** FR-006: the minimum is named in the explanation, and no funds move. */
  it('an amount below the per-rung minimum is rejected with the minimum named', () => {
    const message = problems({ amount: '30000' })
      .map((p) => p.message)
      .join()

    expect(message).toContain('10,000.00 USDC')
    expect(message).toContain('40,000.00 USDC')
    expect(message).toContain('No funds have been moved')
  })

  it('the minimum is checked on the smallest rung, not the average', () => {
    const result = buildPlan(
      input({ distribution: 'weighted', weights: ['98', '1', '0.5', '0.5'] }),
      market,
      calendar,
    )

    expect(result.ok).toBe(false)
  })
})

describe('rung dates', () => {
  it('the last rung always reaches the horizon', () => {
    for (const rungCount of [1, 2, 3, 4]) {
      const picked = pickMaturities(calendar, rungCount)

      expect(picked.at(-1)?.termDays).toBe(180)
      expect(picked).toHaveLength(rungCount)
    }
  })

  it('dates are taken evenly by index', () => {
    expect(pickMaturities(calendar, 3).map((entry) => entry.termDays)).toEqual([30, 90, 180])
    expect(pickMaturities(calendar, 2).map((entry) => entry.termDays)).toEqual([30, 180])
  })

  it('a rung carries the date of a published epoch, not an invented one', () => {
    const plan = planOf({ rungCount: 2 })

    expect(plan.rungs.map((rung) => rung.epoch.maturityTs)).toEqual([
      1_000_000_000n,
      1_012_960_000n,
    ])
  })
})

describe('weights', () => {
  it('equal weights hand out the remainder the same way splitLadder does', () => {
    expect(evenWeightsBps(3)).toEqual([3334, 3333, 3333])
    expect(evenWeightsBps(4)).toEqual([2500, 2500, 2500, 2500])
    expect(evenWeightsBps(7).reduce((sum, bps) => sum + bps, 0)).toBe(10_000)
  })

  it('weights that do not add up to 100% are named with the sum they give', () => {
    const message = problems({ distribution: 'weighted', weights: ['25', '25', '25', '20'] })
      .map((p) => p.message)
      .join()

    expect(message).toContain('95.00%')
  })

  it('a zero weight means removing the rung, not a rung without funds', () => {
    const message = problems({ distribution: 'weighted', weights: ['50', '50', '0', '0'] })
      .map((p) => p.message)
      .join()

    expect(message).toContain('Remove the rung')
  })

  it('fractional percentage weights are accepted to the hundredth', () => {
    const plan = planOf({
      rungCount: 3,
      horizonDays: 90,
      distribution: 'weighted',
      weights: ['33.33', '33.33', '33.34'],
    })

    expect(plan.rungs.map((rung) => rung.deposited)).toEqual([
      333_300_000_000n,
      333_300_000_000n,
      333_400_000_000n,
    ])
  })
})

describe('amount', () => {
  it('zero and not-a-number give different explanations', () => {
    expect(problems({ amount: '0' })[0]?.message).toContain('greater than zero')
    expect(problems({ amount: 'abc' })[0]?.message).toContain('decimal places')
  })
})
