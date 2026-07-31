/**
 * This is not "validation just in case": a fractional or negative value would not crash but
 * quietly yield a wrong amount — and the whole product sells exactly the fact that the amount can be trusted.
 */
export function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`)
  }
}

export function assertAmount(name: string, value: bigint): void {
  if (value < 0n) {
    throw new RangeError(`${name} must be non-negative, got ${value}`)
  }
}
