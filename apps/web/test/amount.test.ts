import { describe, expect, it } from 'vitest'
import { formatAmount, formatAmountShown, formatBps, parseAmount } from '../src/lib/amount'

const USDC = 6

describe('parseAmount', () => {
  it('converts to the mint base units', () => {
    expect(parseAmount('1000000', USDC)).toBe(1_000_000_000_000n)
    expect(parseAmount('1,000,000', USDC)).toBe(1_000_000_000_000n)
    expect(parseAmount('0.5', USDC)).toBe(500_000n)
    expect(parseAmount('.5', USDC)).toBe(500_000n)
  })

  it('refuses instead of truncating extra digits', () => {
    expect(parseAmount('0.0000005', USDC)).toBeNull()
    expect(parseAmount('1.5', 0)).toBeNull()
  })

  it('not an amount is null, not zero', () => {
    for (const input of ['', ' ', '.', 'abc', '1.2.3', '-5', '1e6']) {
      expect(parseAmount(input, USDC)).toBeNull()
    }
  })
})

describe('formatAmount', () => {
  it('truncates the fractional part rather than rounding up', () => {
    // 250358.835616 — the promise of the first rung of the M0 reference ladder.
    expect(formatAmount(250_358_835_616n, USDC)).toBe('250,358.83')
  })

  it('groups thousands', () => {
    expect(formatAmount(1_000_000_000_000n, USDC)).toBe('1,000,000.00')
    expect(formatAmount(0n, USDC)).toBe('0.00')
  })

  it('a non-zero amount is never shown as zero', () => {
    expect(formatAmount(1n, USDC)).toBe('< 0.01')
    expect(formatAmount(9_999n, USDC)).toBe('< 0.01')
    expect(formatAmount(10_000n, USDC)).toBe('0.01')
  })

  it('does not invent digits the mint does not have', () => {
    expect(() => formatAmount(1n, 0)).toThrow(RangeError)
  })
})

describe('formatBps', () => {
  it('bps to percent', () => {
    expect(formatBps(480)).toBe('4.80%')
    expect(formatBps(25)).toBe('0.25%')
  })
})

describe('formatAmountShown', () => {
  it('marks numbers the screen does not show in full', () => {
    expect(formatAmountShown(250_358_835_616n, USDC)).toBe('250,358.83…')
    expect(formatAmountShown(250_000_000_000n, USDC)).toBe('250,000.00')
  })

  it('does not double the mark where "less than" is already said', () => {
    expect(formatAmountShown(1n, USDC)).toBe('< 0.01')
  })

  /** Table rows must add up to the total — that is what the mark is for. */
  it('truncated rows are visible where their sum does not match the total', () => {
    // This is how `splitLadder` divides 500,000 USDC by three: the remainder goes to the first rungs.
    const parts = [166_666_666_667n, 166_666_666_667n, 166_666_666_666n]
    const shown = parts.map((part) => formatAmountShown(part, USDC))

    expect(shown.every((text) => text.endsWith('…'))).toBe(true)
    expect(
      formatAmountShown(
        parts.reduce((sum, part) => sum + part, 0n),
        USDC,
      ),
    ).toBe('500,000.00')
  })
})
