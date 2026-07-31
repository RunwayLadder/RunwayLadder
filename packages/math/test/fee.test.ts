import { describe, expect, it } from 'vitest'
import { fee } from '../src/fee.js'
import { vectors } from './vectors.js'

describe('fee', () => {
  it.each(vectors.fee.cases)('$name', (c) => {
    const result = fee(BigInt(c.amount), c.fee_bps)
    expect(result.fee).toBe(BigInt(c.fee))
    expect(result.working).toBe(BigInt(c.working))
  })

  it('splits the amount without creating or losing a unit', () => {
    for (const amount of [0n, 1n, 999n, 1_000_000_000n, 10n ** 15n]) {
      for (const bps of [0, 1, 25, 9_999, 10_000]) {
        const result = fee(amount, bps)
        expect(result.fee + result.working).toBe(amount)
      }
    }
  })

  it('never takes more than the amount', () => {
    const result = fee(1_000n, 10_000)
    expect(result.fee).toBe(1_000n)
    expect(result.working).toBe(0n)
  })

  it('rejects a fee above the whole amount', () => {
    expect(() => fee(1_000n, 10_001)).toThrow()
  })

  it('rejects a negative or fractional rate', () => {
    expect(() => fee(1_000n, -1)).toThrow()
    expect(() => fee(1_000n, 0.5)).toThrow()
  })

  it('rejects a negative amount', () => {
    expect(() => fee(-1n, 25)).toThrow()
  })
})
