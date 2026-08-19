import { describe, expect, it } from 'vitest'
import { splitLadder } from '../src/ladder.js'
import { vectors } from './vectors.js'

const sum = (parts: bigint[]): bigint => parts.reduce((acc, part) => acc + part, 0n)

describe('splitLadder — even', () => {
  it.each(vectors.split.even_cases)('$name', (c) => {
    const parts = splitLadder(BigInt(c.total), { kind: 'even', rungs: c.rungs })
    expect(parts).toEqual(c.parts.map(BigInt))
  })

  it('hands out the whole amount with no remainder and no invented unit', () => {
    for (const total of [0n, 1n, 3n, 999n, 1_000_000_000n, 10n ** 15n]) {
      for (const rungs of [1, 2, 3, 4, 6, 12]) {
        expect(sum(splitLadder(total, { kind: 'even', rungs }))).toBe(total)
      }
    }
  })

  it('never lets two rungs differ by more than one unit', () => {
    for (const total of [1n, 3n, 999n, 1_000_000_007n]) {
      for (const rungs of [2, 3, 4, 6, 7]) {
        const parts = splitLadder(total, { kind: 'even', rungs })
        const spread =
          parts.reduce((a, b) => (a > b ? a : b)) - parts.reduce((a, b) => (a < b ? a : b))
        expect(spread).toBeLessThanOrEqual(1n)
      }
    }
  })

  it('gives the remainder to the first rungs, not the last', () => {
    expect(splitLadder(1000n, { kind: 'even', rungs: 3 })).toEqual([334n, 333n, 333n])
  })

  it('rejects a ladder without rungs', () => {
    expect(() => splitLadder(1000n, { kind: 'even', rungs: 0 })).toThrow()
  })

  it('rejects a fractional or negative rung count', () => {
    expect(() => splitLadder(1000n, { kind: 'even', rungs: 2.5 })).toThrow()
    expect(() => splitLadder(1000n, { kind: 'even', rungs: -1 })).toThrow()
  })
})

describe('splitLadder — weighted', () => {
  it.each(vectors.split.weighted_cases)('$name', (c) => {
    const parts = splitLadder(BigInt(c.total), { kind: 'weighted', weightsBps: c.weights_bps })
    expect(parts).toEqual(c.parts.map(BigInt))
  })

  it('hands out the whole amount with no remainder and no invented unit', () => {
    const shapes = [
      [10_000],
      [5_000, 5_000],
      [3_333, 3_333, 3_334],
      [4_000, 3_000, 2_000, 1_000],
      [1, 9_999],
    ]
    for (const total of [0n, 1n, 7n, 999n, 1_000_000_000n, 10n ** 15n]) {
      for (const weightsBps of shapes) {
        expect(sum(splitLadder(total, { kind: 'weighted', weightsBps }))).toBe(total)
      }
    }
  })

  it('equal weights give the same as the even mode when there are 4 rungs', () => {
    for (const total of [0n, 999n, 1_000_000_000_001n]) {
      expect(
        splitLadder(total, { kind: 'weighted', weightsBps: [2_500, 2_500, 2_500, 2_500] }),
      ).toEqual(splitLadder(total, { kind: 'even', rungs: 4 }))
    }
  })

  it('rejects weights that do not add up to 10000 bps', () => {
    expect(() => splitLadder(1000n, { kind: 'weighted', weightsBps: [5_000, 4_000] })).toThrow()
    expect(() => splitLadder(1000n, { kind: 'weighted', weightsBps: [6_000, 5_000] })).toThrow()
  })

  it('rejects a zero weight: a rung without funds must not exist', () => {
    expect(() => splitLadder(1000n, { kind: 'weighted', weightsBps: [10_000, 0] })).toThrow()
  })

  it('rejects a ladder without weights', () => {
    expect(() => splitLadder(1000n, { kind: 'weighted', weightsBps: [] })).toThrow()
  })

  it('rejects a fractional or negative weight', () => {
    expect(() => splitLadder(1000n, { kind: 'weighted', weightsBps: [5_000.5, 4_999.5] })).toThrow()
    expect(() => splitLadder(1000n, { kind: 'weighted', weightsBps: [-1, 10_001] })).toThrow()
  })
})

describe('splitLadder — common', () => {
  it('rejects a negative amount', () => {
    expect(() => splitLadder(-1n, { kind: 'even', rungs: 4 })).toThrow()
    expect(() => splitLadder(-1n, { kind: 'weighted', weightsBps: [10_000] })).toThrow()
  })

  it('on an amount smaller than the rung count honestly returns zeros', () => {
    // This is not an arithmetic error but the reason for FR-006: the minimum is checked before
    // the deposit, otherwise a rung with a zero promise would go to the chain.
    expect(splitLadder(3n, { kind: 'even', rungs: 4 })).toEqual([1n, 1n, 1n, 0n])
  })
})
