/**
 * Projected inflows chart (FR-008).
 *
 * **Why two series rather than one bar in two parts.** The guaranteed inflow
 * is a quarter of a million, the monthly estimate of the floating part is fifteen
 * hundred. On a shared scale the second has no height at all: in the M0 prototype it
 * looked like an empty month. A shared axis here is not "inconvenient", it is untrue —
 * it reads as if there were no floating income. Two scales, labelled as different, say
 * the same thing the numbers do.
 */

import type { CashflowForecast, CashflowMonth } from '@runway-ladder/math'
import type { TooltipProps } from 'recharts'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatAmount, formatAmountShown } from '@/lib/amount'

const axisStyle = {
  fontSize: 11,
  fill: 'hsl(var(--muted-foreground))',
  fontFamily: 'var(--font-mono)',
}

type Row = {
  month: string
  label: string
  guaranteed: number
  promised: number
  floating: number
  guaranteedLabel: string
  promisedLabel: string
  floatingLabel: string
}

/** `2026-09` → `Sep 2026`. The month is labelled with a word because the axis is read, not sorted. */
const monthLabel = (month: string): string => {
  const [year = '', index = '01'] = month.split('-')
  const date = new Date(Date.UTC(Number(year), Number(index) - 1, 1))

  return `${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${year}`
}

/**
 * Bar height is a `number`, and this is the only place where an amount stops being exact.
 * A `bigint` string always sits next to it on screen: what gets converted to a float
 * is what is drawn, not what is read.
 */
const toRows = (forecast: CashflowForecast, decimals: number): Row[] =>
  forecast.months.map((month: CashflowMonth) => ({
    month: month.month,
    label: monthLabel(month.month),
    guaranteed: Number(month.guaranteed) / 10 ** decimals,
    promised: Number(month.promised) / 10 ** decimals,
    floating: Number(month.floating) / 10 ** decimals,
    guaranteedLabel: formatAmountShown(month.guaranteed, decimals),
    promisedLabel: formatAmountShown(month.promised, decimals),
    floatingLabel: formatAmountShown(month.floating, decimals),
  }))

const compact = (value: number): string => {
  if (value === 0) return '0'
  if (Math.abs(value) >= 1000) return `${Math.round(value / 1000)}k`

  return value.toFixed(0)
}

const ChartTooltip = ({
  active,
  payload,
  symbol,
}: TooltipProps<number, string> & { symbol: string }) => {
  const entry = payload?.[0]
  if (!active || !entry) return null

  const row = entry.payload as Row
  const short = row.guaranteedLabel !== row.promisedLabel

  return (
    <div
      className="panel px-3 py-2 text-xs"
      style={{ backgroundColor: 'hsl(var(--surface-raised))' }}
    >
      <div className="mb-1.5 font-medium">{row.label}</div>
      <div className="flex items-center justify-between gap-6">
        <span className="text-muted-foreground">Guaranteed</span>
        <span className="num">
          {row.guaranteedLabel} {symbol}
        </span>
      </div>
      {short && (
        <div className="flex items-center justify-between gap-6">
          <span className="text-muted-foreground">Promised at issuance</span>
          <span className="num text-[hsl(var(--caution))]">{row.promisedLabel}</span>
        </div>
      )}
      <div className="flex items-center justify-between gap-6">
        <span className="text-muted-foreground">Floating estimate</span>
        <span className="num">{row.floatingLabel}</span>
      </div>
    </div>
  )
}

const Legend = () => (
  <div className="mb-3 flex flex-wrap items-center gap-5 text-xs text-muted-foreground">
    <span className="inline-flex items-center gap-2">
      <span
        className="inline-block h-2.5 w-4"
        style={{ backgroundColor: 'hsl(var(--series-guaranteed))' }}
      />
      Guaranteed
    </span>
    <span className="inline-flex items-center gap-2">
      <svg width="16" height="10" aria-hidden="true">
        <title>Floating estimate</title>
        <rect
          width="16"
          height="10"
          fill="url(#inflow-hatch)"
          stroke="hsl(var(--series-floating))"
        />
      </svg>
      Floating estimate — not a promise, and drawn on its own scale
    </span>
  </div>
)

const Hatch = () => (
  <defs>
    <pattern
      id="inflow-hatch"
      width="6"
      height="6"
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(45)"
    >
      <rect width="6" height="6" fill="hsl(var(--series-floating) / 0.18)" />
      <line x1="0" y1="0" x2="0" y2="6" stroke="hsl(var(--series-floating))" strokeWidth="2" />
    </pattern>
  </defs>
)

export const CashflowChart = ({
  forecast,
  decimals,
  symbol,
  caption,
}: {
  forecast: CashflowForecast
  decimals: number
  symbol: string
  caption?: string
}) => {
  const rows = toRows(forecast, decimals)
  const outside = forecast.outsideHorizon.guaranteed

  return (
    <div className="px-4 py-4">
      <Legend />

      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 4, right: 8, left: 8, bottom: 0 }}
            barCategoryGap="28%"
          >
            <CartesianGrid vertical={false} stroke="hsl(var(--grid-line))" />
            <XAxis
              dataKey="label"
              tick={false}
              axisLine={{ stroke: 'hsl(var(--border))' }}
              height={8}
            />
            <YAxis
              tick={axisStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={compact}
              width={44}
            />
            <Tooltip
              cursor={{ fill: 'hsl(var(--muted) / 0.5)' }}
              content={<ChartTooltip symbol={symbol} />}
            />
            <Bar dataKey="guaranteed" fill="hsl(var(--series-guaranteed))" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-1 h-[92px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 4, right: 8, left: 8, bottom: 0 }}
            barCategoryGap="28%"
          >
            <Hatch />
            <CartesianGrid vertical={false} stroke="hsl(var(--grid-line))" />
            <XAxis
              dataKey="label"
              tick={axisStyle}
              tickLine={false}
              axisLine={{ stroke: 'hsl(var(--border))' }}
              interval={0}
              angle={-35}
              textAnchor="end"
              height={52}
            />
            <YAxis
              tick={axisStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={compact}
              width={44}
            />
            <Tooltip
              cursor={{ fill: 'hsl(var(--muted) / 0.5)' }}
              content={<ChartTooltip symbol={symbol} />}
            />
            <Bar
              dataKey="floating"
              fill="url(#inflow-hatch)"
              stroke="hsl(var(--series-floating))"
              strokeWidth={1}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {caption && <p className="mt-3 text-xs text-muted-foreground">{caption}</p>}

      {outside > 0n && (
        <p className="mt-1 text-xs text-muted-foreground">
          Another <span className="num">{formatAmount(outside, decimals)}</span> {symbol} matures
          outside this window — the chart shows twelve months, the ladder can be longer.
        </p>
      )}
    </div>
  )
}
