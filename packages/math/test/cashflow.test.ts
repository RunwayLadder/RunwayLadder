import { describe, expect, it } from 'vitest'
import {
  type CashflowRequest,
  type FloatingPosition,
  projectCashflow,
  type RungInflow,
} from '../src/cashflow.js'

/** 2026-08-20T12:00:00Z — the moment the treasurer builds the projection. */
const FROM = 1_787_227_200

/** The M0 ladder: $1M across four rungs of 30/60/90/180 days. */
const RUNGS: RungInflow[] = [
  { maturityTs: 1_789_819_200, promised: 250_358_835_616n, settled: null }, // 2026-09-19
  { maturityTs: 1_792_411_200, promised: 251_506_643_835n, settled: null }, // 2026-10-19
  { maturityTs: 1_795_003_200, promised: 252_818_424_657n, settled: null }, // 2026-11-18
  { maturityTs: 1_802_779_200, promised: 256_999_726_027n, settled: null }, // 2027-02-16
]

const NO_FLOATING: FloatingPosition = { amount: 0n, rateBps: 0 }

const request = (over: Partial<CashflowRequest> = {}): CashflowRequest => ({
  fromTs: FROM,
  months: 12,
  rungs: RUNGS,
  floating: NO_FLOATING,
  ...over,
})

const monthOf = (forecast: ReturnType<typeof projectCashflow>, label: string) => {
  const found = forecast.months.find((m) => m.month === label)
  if (!found) throw new Error(`month ${label} is not in the projection`)
  return found
}

const total = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n)

describe('projectCashflow — window', () => {
  it('gives exactly as many calendar months as asked, starting with the current one', () => {
    const forecast = projectCashflow(request())
    expect(forecast.months).toHaveLength(12)
    expect(forecast.months[0]?.month).toBe('2026-08')
    expect(forecast.months[11]?.month).toBe('2027-07')
  })

  it('places rungs in the months of their maturity', () => {
    const forecast = projectCashflow(request())
    expect(monthOf(forecast, '2026-09').guaranteed).toBe(250_358_835_616n)
    expect(monthOf(forecast, '2026-10').guaranteed).toBe(251_506_643_835n)
    expect(monthOf(forecast, '2026-11').guaranteed).toBe(252_818_424_657n)
    expect(monthOf(forecast, '2027-02').guaranteed).toBe(256_999_726_027n)
  })

  it('leaves months without maturities empty — a gap in the ladder is visible, not smoothed over', () => {
    const forecast = projectCashflow(request())
    for (const label of ['2026-08', '2026-12', '2027-01', '2027-03', '2027-07']) {
      expect(monthOf(forecast, label).guaranteed).toBe(0n)
    }
  })

  it('assigns a maturity exactly on the month boundary to the next month', () => {
    // 2026-10-01T00:00:00Z — the end of the September bucket is exclusive.
    const boundary = 1_790_812_800
    const forecast = projectCashflow(
      request({ rungs: [{ maturityTs: boundary, promised: 1_000n, settled: null }] }),
    )
    expect(monthOf(forecast, '2026-09').guaranteed).toBe(0n)
    expect(monthOf(forecast, '2026-10').guaranteed).toBe(1_000n)
  })
})

describe('projectCashflow — nothing is lost (SC-005)', () => {
  it('the sum over months plus what is outside the window equals the whole ladder', () => {
    for (const months of [1, 2, 3, 6, 12]) {
      const forecast = projectCashflow(request({ months }))
      const inWindow = total(forecast.months.map((m) => m.guaranteed))
      expect(inWindow + forecast.outsideHorizon.guaranteed).toBe(
        total(RUNGS.map((r) => r.promised)),
      )
    }
  })

  it('a rung redeemed before the projection starts goes outside the window, not into the first month', () => {
    // 2026-08-06, i.e. in the same calendar month but already behind.
    const alreadyPaid = 1_786_017_600
    const forecast = projectCashflow(
      request({ rungs: [{ maturityTs: alreadyPaid, promised: 7_000n, settled: null }] }),
    )
    expect(monthOf(forecast, '2026-08').guaranteed).toBe(0n)
    expect(forecast.outsideHorizon.guaranteed).toBe(7_000n)
  })

  it('a rung beyond the horizon goes outside the window', () => {
    const forecast = projectCashflow(request({ months: 3 }))
    expect(forecast.outsideHorizon.guaranteed).toBe(252_818_424_657n + 256_999_726_027n)
  })
})

describe('projectCashflow — the deficit is shown in advance (FR-011a)', () => {
  it('takes the actual amount instead of the promised one as soon as the epoch is settled', () => {
    const forecast = projectCashflow(
      request({
        rungs: [
          { maturityTs: 1_792_411_200, promised: 251_506_643_835n, settled: 250_047_905_300n },
        ],
      }),
    )
    const october = monthOf(forecast, '2026-10')
    expect(october.guaranteed).toBe(250_047_905_300n)
    expect(october.promised).toBe(251_506_643_835n)
    expect(october.promised - october.guaranteed).toBe(1_458_738_535n)
  })

  it('while the epoch is not settled, promised and expected coincide', () => {
    const forecast = projectCashflow(request())
    for (const month of forecast.months) {
      expect(month.guaranteed).toBe(month.promised)
    }
  })

  it('a complete shortfall shows zero, not the promise', () => {
    // `settled: 0n` is not "no data". Confusing the two would show the treasurer money
    // that will never come.
    const forecast = projectCashflow(
      request({ rungs: [{ maturityTs: 1_792_411_200, promised: 251_506_643_835n, settled: 0n }] }),
    )
    expect(monthOf(forecast, '2026-10').guaranteed).toBe(0n)
    expect(monthOf(forecast, '2026-10').promised).toBe(251_506_643_835n)
  })
})

describe('projectCashflow — floating part', () => {
  const floating: FloatingPosition = { amount: 400_000_000_000n, rateBps: 480 }

  it('counts the first month from the moment of projection, not from the 1st', () => {
    const forecast = projectCashflow(request({ floating }))
    // 2026-08-20T12:00 → 2026-09-01T00:00 = 993 600 s, not the whole of August.
    expect(monthOf(forecast, '2026-08').floating).toBe(604_931_506n)
  })

  it('distinguishes 30- and 31-day months rather than dividing the year by 12', () => {
    const forecast = projectCashflow(request({ floating }))
    expect(monthOf(forecast, '2026-09').floating).toBe(1_578_082_191n)
    expect(monthOf(forecast, '2026-10').floating).toBe(1_630_684_931n)
    expect(monthOf(forecast, '2026-09').floating).not.toBe(monthOf(forecast, '2026-10').floating)
  })

  it('without a floating position gives zeros rather than dropping months', () => {
    const forecast = projectCashflow(request())
    expect(forecast.months).toHaveLength(12)
    expect(total(forecast.months.map((m) => m.floating))).toBe(0n)
  })

  it('does not mix the floating estimate with the guaranteed', () => {
    const forecast = projectCashflow(request({ floating }))
    expect(monthOf(forecast, '2026-08').guaranteed).toBe(0n)
    expect(monthOf(forecast, '2026-08').floating).toBeGreaterThan(0n)
  })
})

describe('projectCashflow — limits', () => {
  it('rejects a horizon outside 1..12 months', () => {
    expect(() => projectCashflow(request({ months: 0 }))).toThrow()
    expect(() => projectCashflow(request({ months: 13 }))).toThrow()
  })

  it('rejects fractional or negative time', () => {
    expect(() => projectCashflow(request({ fromTs: -1 }))).toThrow()
    expect(() => projectCashflow(request({ fromTs: FROM + 0.5 }))).toThrow()
  })

  it('rejects negative amounts', () => {
    expect(() => projectCashflow(request({ floating: { amount: -1n, rateBps: 480 } }))).toThrow()
    expect(() =>
      projectCashflow(request({ rungs: [{ maturityTs: FROM, promised: -1n, settled: null }] })),
    ).toThrow()
    expect(() =>
      projectCashflow(request({ rungs: [{ maturityTs: FROM, promised: 10n, settled: -1n }] })),
    ).toThrow()
  })

  it('an empty ladder gives an empty chart, not an error', () => {
    const forecast = projectCashflow(request({ rungs: [] }))
    expect(forecast.months).toHaveLength(12)
    expect(total(forecast.months.map((m) => m.guaranteed))).toBe(0n)
    expect(forecast.outsideHorizon.guaranteed).toBe(0n)
  })
})
