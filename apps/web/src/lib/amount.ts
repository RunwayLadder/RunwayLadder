/**
 * Amounts between the input field and the mint's base units.
 *
 * Floating-point numbers never appear here: everything the treasurer typed
 * goes into a `bigint` of base units and comes back as a string. `Number` on
 * a million USDC with six decimals is still exact, on ten million it no longer is —
 * and the error would not be a crash but a wrong amount.
 */

/** Digits only, at most one dot. Comma and space are thousands separators. */
const AMOUNT = /^\d*(\.\d*)?$/

/**
 * String from the field → base units, or `null` if it is not an amount.
 *
 * Extra fractional digits are a rejection, not a truncation: "0.0000005 USDC"
 * would silently become zero, and a silent zero in a deposit amount is worse than
 * an empty preview.
 */
export function parseAmount(input: string, decimals: number): bigint | null {
  const cleaned = input.replace(/[\s,_]/g, '')
  if (cleaned === '' || cleaned === '.' || !AMOUNT.test(cleaned)) return null

  const [whole = '', fraction = ''] = cleaned.split('.')
  if (fraction.length > decimals) return null

  return BigInt(`${whole || '0'}${fraction.padEnd(decimals, '0')}`)
}

const GROUP = /\B(?=(\d{3})+(?!\d))/g

/**
 * Base units → a string for the screen.
 *
 * The fractional part is **truncated, not rounded**. Rounding up would add
 * hundredths to the promise that the chain will never pay: `250358.835616`
 * shows as `250,358.83`, which is the same number the M0 prototype showed.
 *
 * A non-zero amount is never shown as `0.00` — it shows as `< 0.01` instead.
 * A zero on screen where there is money is a lie, even when it is about
 * millionths of a cent.
 */
export function formatAmount(value: bigint, decimals: number, digits = 2): string {
  if (value < 0n) return `-${formatAmount(-value, decimals, digits)}`
  if (digits > decimals) throw new RangeError('more digits on screen than the mint has')

  const hidden = 10n ** BigInt(decimals - digits)
  const shown = value / hidden

  if (shown === 0n && value > 0n) {
    return `< ${formatAmount(1n * hidden, decimals, digits)}`
  }

  const scale = 10n ** BigInt(digits)
  const whole = (shown / scale).toString().replace(GROUP, ',')
  if (digits === 0) return whole

  return `${whole}.${(shown % scale).toString().padStart(digits, '0')}`
}

/** Rate in bps → a percentage for the screen: 480 → `4.80%`. */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`
}

/**
 * The same number, marked as shorter on screen than it really is.
 *
 * Without it the column of rows does not add up to the total: 500,000 across three rungs
 * gives three `166,666.66` and a total of `500,000.00`, as if two cents were missing. They
 * are there — hidden by truncation to hundredths. The ellipsis says so directly, instead
 * of leaving the treasurer with a table that does not add up.
 */
export function formatAmountShown(value: bigint, decimals: number, digits = 2): string {
  const text = formatAmount(value, decimals, digits)
  if (text.startsWith('<')) return text

  return value % 10n ** BigInt(decimals - digits) === 0n ? text : `${text}…`
}
