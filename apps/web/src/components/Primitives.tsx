import type { ReactNode } from 'react'
import type { StatusLabel } from '@/lib/rungRecord'

/** Pre-formatted amount. Never recomputed — the string is rendered verbatim. */
export const Amount = ({
  value,
  unit = 'USDC',
  className = '',
  strike = false,
}: {
  value: string
  unit?: string | null
  className?: string
  strike?: boolean
}) => (
  <span className={`num whitespace-nowrap ${strike ? 'line-through opacity-60' : ''} ${className}`}>
    {value}
    {unit ? <span className="ml-1 text-[0.85em] text-muted-foreground">{unit}</span> : null}
  </span>
)

export const Panel = ({
  title,
  subtitle,
  right,
  children,
  className = '',
}: {
  title?: string
  subtitle?: string
  right?: ReactNode
  children: ReactNode
  className?: string
}) => (
  <section className={`panel ${className}`}>
    {(title || right) && (
      <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div>
          {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {right}
      </header>
    )}
    {children}
  </section>
)

export const StatTile = ({
  label,
  value,
  unit = 'USDC',
  meta,
}: {
  label: string
  value: string
  unit?: string | null
  meta?: string
}) => (
  <div className="panel px-4 py-3" style={{ backgroundColor: 'hsl(var(--surface-raised))' }}>
    <div className="label-caps">{label}</div>
    <div className="mt-1.5 text-lg">
      <Amount value={value} unit={unit} />
    </div>
    {meta && <div className="mt-1 text-xs text-muted-foreground">{meta}</div>}
  </div>
)

const statusStyle: Record<StatusLabel, string> = {
  Active: 'border-border text-foreground',
  Redeemed: 'border-border text-muted-foreground',
  'Redeemed with deficit': 'border-[hsl(var(--caution))] text-[hsl(var(--caution))]',
  Exited: 'border-border text-muted-foreground',
}

export const StatusBadge = ({ status }: { status: StatusLabel }) => (
  <span
    className={`inline-flex items-center whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-[0.6875rem] font-medium tracking-wide ${statusStyle[status]}`}
  >
    {status}
  </span>
)

export const KeyValue = ({
  label,
  children,
  helper,
}: {
  label: string
  children: ReactNode
  helper?: string
}) => (
  <div className="border-b border-border py-2.5 last:border-b-0">
    <div className="label-caps">{label}</div>
    <div className="mt-1 text-sm">{children}</div>
    {helper && <p className="mt-1 text-xs text-muted-foreground">{helper}</p>}
  </div>
)
