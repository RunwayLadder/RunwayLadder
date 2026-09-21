import { describe, expect, it } from 'vitest'
import { BPS_DENOMINATOR, SECONDS_PER_YEAR } from '../src/constants.js'
import { promise } from '../src/promise.js'
import { type EpochMaturity, payout, type Settlement, waterfall } from '../src/waterfall.js'
import { vectors } from './vectors.js'

describe('waterfall', () => {
  it.each(vectors.waterfall.cases)('$name', (c) => {
    const s = waterfall({
      promised: BigInt(c.promised),
      realized: BigInt(c.realized),
      yieldPool: BigInt(c.yield_pool),
      buffer: BigInt(c.buffer),
    })

    expect(s.paid).toBe(BigInt(c.paid))
    expect(s.fromYieldPool).toBe(BigInt(c.from_yield_pool))
    expect(s.fromBuffer).toBe(BigInt(c.from_buffer))
    expect(s.status === 'settled' ? s.surplus : 0n).toBe(BigInt(c.surplus))
    expect(s.status === 'settledWithDeficit' ? s.deficit : 0n).toBe(BigInt(c.deficit))
  })

  it('rejects a negative amount in any position', () => {
    const ok: EpochMaturity = { promised: 1n, realized: 1n, yieldPool: 1n, buffer: 1n }
    for (const key of Object.keys(ok) as (keyof EpochMaturity)[]) {
      expect(() => waterfall({ ...ok, [key]: -1n })).toThrow(RangeError)
    }
  })
})

describe('payout', () => {
  it.each(vectors.waterfall.payout.cases)('$name', (c) => {
    expect(payout(BigInt(c.rung_promised), settlementOf(BigInt(c.paid), BigInt(c.promised)))).toBe(
      BigInt(c.payout),
    )
  })

  it('rejects a rung promised more than its whole epoch', () => {
    expect(() => payout(11n, settlementOf(10n, 10n))).toThrow(RangeError)
  })

  it('rejects a negative promise', () => {
    expect(() => payout(-1n, settlementOf(10n, 10n))).toThrow(RangeError)
  })

  it('pays an empty epoch nothing without dividing by zero', () => {
    expect(payout(0n, settlementOf(0n, 0n))).toBe(0n)
  })
})

/**
 * SC-004: on ≥ 200 simulated base-rate trajectories, including a halving, the principal
 * is paid at par in 100% of cases or the deficit is explicitly marked — zero silent
 * underpayment.
 *
 * The trajectories are drawn from a seeded generator: the run is reproducible, and the
 * counts below guard against a generator that quietly stopped producing one of the
 * branches — a property over an empty branch proves nothing.
 */
describe('SC-004: the waterfall over simulated trajectories', () => {
  const TRAJECTORIES = 400
  const runs = Array.from({ length: TRAJECTORIES }, (_, i) => simulate(i + 1))

  it('exercises every branch of the order', () => {
    const settled = runs.filter((r) => r.settlement.status === 'settled')
    const deficit = runs.filter((r) => r.settlement.status === 'settledWithDeficit')
    const bySource = settled.filter((r) => r.settlement.fromYieldPool === 0n)
    const byYieldPool = settled.filter(
      (r) => r.settlement.fromYieldPool > 0n && r.settlement.fromBuffer === 0n,
    )
    const byBuffer = settled.filter((r) => r.settlement.fromBuffer > 0n)
    const halved = runs.filter((r) => r.halved)

    expect(runs).toHaveLength(TRAJECTORIES)
    expect(halved.length).toBeGreaterThanOrEqual(TRAJECTORIES / 4)
    for (const branch of [bySource, byYieldPool, byBuffer, deficit]) {
      expect(branch.length).toBeGreaterThanOrEqual(20)
    }
    expect(halved.some((r) => r.settlement.status === 'settledWithDeficit')).toBe(true)
    expect(halved.some((r) => r.settlement.status === 'settled')).toBe(true)
  })

  it('never creates money and never draws more than a pool holds', () => {
    for (const { epoch, settlement: s } of runs) {
      expect(s.paid).toBeLessThanOrEqual(s.promised)
      expect(s.fromYieldPool).toBeLessThanOrEqual(epoch.yieldPool)
      expect(s.fromBuffer).toBeLessThanOrEqual(epoch.buffer)

      const surplus = s.status === 'settled' ? s.surplus : 0n
      expect(epoch.realized + s.fromYieldPool + s.fromBuffer).toBe(s.paid + surplus)
    }
  })

  it('drains the pools in order: yield pool, then buffer, then the haircut', () => {
    for (const { epoch, settlement: s } of runs) {
      if (s.fromBuffer > 0n) expect(s.fromYieldPool).toBe(epoch.yieldPool)
      if (s.status === 'settledWithDeficit') {
        expect(s.fromYieldPool).toBe(epoch.yieldPool)
        expect(s.fromBuffer).toBe(epoch.buffer)
        expect(s.deficit).toBe(s.promised - s.paid)
        expect(s.deficit).toBeGreaterThan(0n)
      }
      if (s.status === 'settled') {
        expect(s.paid).toBe(s.promised)
        if (s.surplus > 0n) {
          expect(s.fromYieldPool).toBe(0n)
          expect(s.fromBuffer).toBe(0n)
        }
      }
    }
  })

  it('pays every rung at par or marks the deficit — never silently less', () => {
    for (const { rungs, settlement: s } of runs) {
      const paid = rungs.map((promised) => payout(promised, s))
      const total = paid.reduce((sum, p) => sum + p, 0n)

      expect(total).toBeLessThanOrEqual(s.paid)
      // Rounding leaves less than one unit per rung as dust — never more.
      expect(total).toBeGreaterThan(s.paid - BigInt(rungs.length))

      for (const [i, promised] of rungs.entries()) {
        const amount = paid[i] as bigint
        if (s.status === 'settled') expect(amount).toBe(promised)
        else expect(amount).toBeLessThan(promised)
      }
    }
  })
})

function settlementOf(paid: bigint, promised: bigint): Settlement {
  return paid === promised
    ? { status: 'settled', promised, paid, surplus: 0n, fromYieldPool: 0n, fromBuffer: 0n }
    : {
        status: 'settledWithDeficit',
        promised,
        paid,
        deficit: promised - paid,
        fromYieldPool: 0n,
        fromBuffer: 0n,
      }
}

type Run = {
  epoch: EpochMaturity
  rungs: bigint[]
  settlement: Settlement
  halved: boolean
}

const DAY = 86_400

/**
 * One epoch under one base-rate trajectory. The promise is fixed at issuance from the
 * epoch's rate; the source then accrues along a random walk of the base rate, and in a
 * quarter of the runs the rate halves partway through — the case SC-004 names.
 */
function simulate(seed: number): Run {
  const rand = mulberry32(seed)
  const rungCount = 1 + rand.int(8)
  const rateBps = 100 + rand.int(1_400)
  const seconds = DAY * (30 + rand.int(335))

  const workings = Array.from({ length: rungCount }, () =>
    rand.amount(1_000_000n, 1_000_000_000_000n),
  )
  const rungs = workings.map((w) => promise(w, rateBps, seconds))
  const working = workings.reduce((sum, w) => sum + w, 0n)
  const promised = rungs.reduce((sum, p) => sum + p, 0n)

  // The base rate walks in steps of ±15 %, starting around the promised rate.
  const steps = 4 + rand.int(20)
  const halved = rand.next() < 0.25
  const halveAt = rand.int(steps)
  let rate = rateBps * (0.7 + rand.next() * 0.6)
  let accrued = 0n
  for (let k = 0; k < steps; k += 1) {
    rate *= 0.85 + rand.next() * 0.3
    if (halved && k === halveAt) rate /= 2
    const stepSeconds = BigInt(Math.floor(seconds / steps))
    accrued +=
      (working * BigInt(Math.floor(rate)) * stepSeconds) / (BPS_DENOMINATOR * SECONDS_PER_YEAR)
  }

  // A rare source that returns less principal than it took: the waterfall must not
  // depend on the principal being intact.
  const lost = rand.next() < 0.05 ? working / BigInt(2 + rand.int(20)) : 0n
  const realized = working + accrued - lost

  const expectedIncome = promised - working > 0n ? promised - working : 1n
  const yieldPool = rand.next() < 0.3 ? 0n : rand.amount(0n, expectedIncome * 2n)
  const buffer = rand.next() < 0.3 ? 0n : rand.amount(0n, working / 100n)

  const epoch: EpochMaturity = { promised, realized, yieldPool, buffer }
  return { epoch, rungs, settlement: waterfall(epoch), halved }
}

/** A small seeded PRNG — the trajectories must be the same on every run. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
  return {
    next,
    /** An integer in `[0, n)`. */
    int: (n: number): number => Math.floor(next() * n),
    /** A bigint in `[lo, hi]`, uniform enough for a simulation. */
    amount: (lo: bigint, hi: bigint): bigint => {
      const span = hi - lo + 1n
      const hi32 = BigInt(Math.floor(next() * 4_294_967_296))
      const lo32 = BigInt(Math.floor(next() * 4_294_967_296))
      return lo + (((hi32 << 32n) | lo32) % span)
    },
  }
}
