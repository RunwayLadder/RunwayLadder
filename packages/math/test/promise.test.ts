import { describe, expect, it } from 'vitest'
import { BPS_DENOMINATOR, SECONDS_PER_YEAR } from '../src/constants.js'
import { promise } from '../src/promise.js'
import { vectors } from './vectors.js'

describe('promise', () => {
  it.each(vectors.promise.cases)('$name', (c) => {
    expect(promise(BigInt(c.working), c.rate_bps, c.seconds)).toBe(BigInt(c.promised))
  })

  it('shares its constants with the fixture', () => {
    expect(vectors.constants.bps_denominator).toBe(Number(BPS_DENOMINATOR))
    expect(vectors.constants.seconds_per_year).toBe(Number(SECONDS_PER_YEAR))
  })

  it('never promises less than the principal', () => {
    for (const rateBps of [0, 1, 500, 10_000]) {
      for (const seconds of [0, 1, 86_400, 31_536_000]) {
        expect(promise(1_000_000_000n, rateBps, seconds)).toBeGreaterThanOrEqual(1_000_000_000n)
      }
    }
  })

  it('grows with time and with rate', () => {
    const base = promise(1_000_000_000n, 800, 86_400 * 90)
    expect(promise(1_000_000_000n, 800, 86_400 * 180)).toBeGreaterThan(base)
    expect(promise(1_000_000_000n, 1_600, 86_400 * 90)).toBeGreaterThan(base)
  })

  it('rejects a rate outside the representable range', () => {
    expect(() => promise(1n, -1, 1)).toThrow()
    expect(() => promise(1n, 1.5, 1)).toThrow()
  })

  it('rejects negative or fractional time', () => {
    expect(() => promise(1n, 100, -1)).toThrow()
    expect(() => promise(1n, 100, 1.5)).toThrow()
  })

  it('rejects a negative principal', () => {
    expect(() => promise(-1n, 100, 1)).toThrow()
  })
})
