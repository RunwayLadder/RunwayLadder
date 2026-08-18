import type { TooltipProps } from 'recharts'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { INFLOW_CAPTION, type InflowMonth, inflowSchedule } from '@/lib/treasuryMock'

const axisStyle = {
  fontSize: 11,
  fill: 'hsl(var(--muted-foreground))',
  fontFamily: 'var(--font-mono)',
}

const compact = (value: number): string => {
  if (value === 0) return '0'
  return `${Math.round(value / 1000)}k`
}

const ChartTooltip = ({ active, payload }: TooltipProps<number, string>) => {
  const entry = payload?.[0]
  if (!active || !entry) return null
  const row = entry.payload as InflowMonth
  return (
    <div
      className="panel px-3 py-2 text-xs"
      style={{ backgroundColor: 'hsl(var(--surface-raised))' }}
    >
      <div className="mb-1.5 font-medium">{row.month}</div>
      <div className="flex items-center justify-between gap-6">
        <span className="text-muted-foreground">Guaranteed</span>
        <span className="num">{row.guaranteedLabel} USDC</span>
      </div>
      <div className="flex items-center justify-between gap-6">
        <span className="text-muted-foreground">Floating estimate</span>
        <span className="num">{row.floatingLabel} USDC</span>
      </div>
    </div>
  )
}

export const InflowChart = () => (
  <div className="px-4 py-4">
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
          <rect
            width="16"
            height="10"
            fill="url(#inflow-hatch)"
            stroke="hsl(var(--series-floating))"
          />
        </svg>
        Floating estimate — not a promise
      </span>
    </div>

    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={inflowSchedule}
          margin={{ top: 4, right: 8, left: 8, bottom: 0 }}
          barCategoryGap="28%"
        >
          <defs>
            <pattern
              id="inflow-hatch"
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" fill="hsl(var(--series-floating) / 0.18)" />
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="6"
                stroke="hsl(var(--series-floating))"
                strokeWidth="2"
              />
            </pattern>
          </defs>
          <CartesianGrid vertical={false} stroke="hsl(var(--grid-line))" />
          <XAxis
            dataKey="month"
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
          <Tooltip cursor={{ fill: 'hsl(var(--muted) / 0.5)' }} content={<ChartTooltip />} />
          <Bar dataKey="guaranteed" stackId="inflow" fill="hsl(var(--series-guaranteed))" />
          <Bar
            dataKey="floating"
            stackId="inflow"
            fill="url(#inflow-hatch)"
            stroke="hsl(var(--series-floating))"
            strokeWidth={1}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>

    <p className="mt-3 text-xs text-muted-foreground">{INFLOW_CAPTION}</p>
  </div>
)
