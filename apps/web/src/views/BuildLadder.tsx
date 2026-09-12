import { MAX_RUNGS_PER_DEPOSIT } from '@treasury-runway/sdk'
import { type ReactNode, useMemo, useState } from 'react'
import { DepositButton } from '@/components/DepositButton'
import { Amount, Panel } from '@/components/Primitives'
import { RateDisclosure } from '@/components/RateDisclosure'
import { RungTable } from '@/components/RungTable'
import { formatAmount, formatAmountShown, formatBps } from '@/lib/amount'
import { liveNetwork } from '@/lib/network'
import {
  blendedNetRatePercent,
  buildPlan,
  evenWeightsBps,
  maxRungs,
  type Plan,
  type PlanResult,
  type PlanRung,
  type ProblemField,
} from '@/lib/plan'
import type { Pricing } from '@/lib/pricing'
import type { RungRecord } from '@/lib/rungRecord'
import { rollPolicyCopy, treasury } from '@/lib/treasuryMock'
import { usePricing } from '@/lib/usePricing'

/** A stable `id` instead of an index: the key and `htmlFor` must not depend on position. */
type Weight = { id: string; value: string }

const HORIZONS = [30, 90, 180, 365] as const

const isoDate = (maturityTs: bigint): string =>
  new Date(Number(maturityTs) * 1000).toISOString().slice(0, 10)

const weightsFor = (rungCount: number): Weight[] =>
  evenWeightsBps(rungCount).map((bps, index) => ({
    id: `weight-rung-${index + 1}`,
    value: (bps / 100).toFixed(2),
  }))

/**
 * A table row from a computed rung. The format is the same as in the M0 prototype,
 * because the table is still shared by the preview and the dashboard; T031 replaces it
 * with a view made from `LadderView`.
 */
const isoStamp = (seconds: bigint): string =>
  `${new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`

const toRow = (rung: PlanRung, decimals: number, source: string): RungRecord => ({
  index: rung.index,
  id: `plan-rung-${rung.index}`,
  term: `${rung.epoch.termDays} d`,
  termDays: rung.epoch.termDays,
  maturity: isoDate(rung.epoch.maturityTs),
  fixedRate: formatBps(rung.epoch.rateBps),
  deposited: formatAmountShown(rung.deposited, decimals),
  fee: formatAmountShown(rung.fee, decimals),
  working: formatAmountShown(rung.working, decimals),
  guaranteed: formatAmountShown(rung.guaranteed, decimals),
  status: 'Active',
  countdown: `${rung.epoch.termDays} days to maturity`,
  operator: rung.epoch.operator,
  ratesSetAt: isoStamp(rung.epoch.ratesSetAt),
  yieldSource: source,
})

const FieldRow = ({
  label,
  helper,
  children,
}: {
  label: string
  helper?: string
  children: ReactNode
}) => (
  <div className="border-b border-border px-4 py-3.5 last:border-b-0">
    <span className="label-caps block">{label}</span>
    <div className="mt-2">{children}</div>
    {helper && <p className="mt-1.5 text-xs text-muted-foreground">{helper}</p>}
  </div>
)

const SegmentedControl = <T extends string | number>({
  options,
  value,
  onChange,
  format,
}: {
  options: readonly T[]
  value: T
  onChange: (next: T) => void
  format?: (option: T) => string
}) => (
  <div className="inline-flex overflow-hidden rounded-sm border border-border">
    {options.map((option) => (
      <button
        key={String(option)}
        type="button"
        onClick={() => onChange(option)}
        aria-pressed={option === value}
        className={`num px-3 py-1.5 text-sm ${
          option === value
            ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
            : 'bg-transparent text-muted-foreground hover:text-foreground'
        }`}
      >
        {format ? format(option) : String(option)}
      </button>
    ))}
  </div>
)

const SummaryRow = ({
  label,
  value,
  unit,
}: {
  label: string
  value: string
  unit?: string | null
}) => (
  <div className="flex items-baseline justify-between gap-6 border-b border-border py-2 last:border-b-0">
    <span className="text-sm text-muted-foreground">{label}</span>
    <Amount value={value} unit={unit ?? null} className="text-sm" />
  </div>
)

/**
 * An unpriced configuration shows a dash, not an estimate: a figure here is a promise,
 * and an approximate promise is worse than none.
 */
const SummaryRows = ({
  plan,
  decimals,
  symbol,
}: {
  plan: Plan | null
  decimals: number
  symbol: string
}) => {
  const money = (value: bigint) => (plan ? formatAmount(value, decimals) : '—')
  const unit = plan ? symbol : null
  const totals = plan?.totals

  return (
    <div className="px-4 py-2">
      <SummaryRow label="Total fee" value={money(totals?.fee ?? 0n)} unit={unit} />
      <SummaryRow label="Working capital" value={money(totals?.working ?? 0n)} unit={unit} />
      <SummaryRow
        label="Guaranteed at maturity"
        value={money(totals?.guaranteed ?? 0n)}
        unit={unit}
      />
      <SummaryRow label="Net gain" value={money(totals?.netGain ?? 0n)} unit={unit} />
      <SummaryRow
        label="Blended net rate"
        value={plan ? `${blendedNetRatePercent(plan).toFixed(2)}%` : '—'}
        unit={null}
      />
    </div>
  )
}

const WeightsGrid = ({
  weights,
  onChange,
  problems,
}: {
  weights: readonly Weight[]
  onChange: (id: string, value: string) => void
  problems: readonly string[]
}) => (
  <>
    <div className="mt-3 grid grid-cols-4 gap-2">
      {weights.map(({ id, value }, index) => (
        <div key={id}>
          <label className="label-caps block" htmlFor={id}>
            Rung {index + 1}
          </label>
          <div className="mt-1 flex items-center gap-1">
            <input
              id={id}
              className="field"
              inputMode="decimal"
              value={value}
              onChange={(event) => onChange(id, event.target.value)}
            />
            <span className="text-xs text-muted-foreground">%</span>
          </div>
        </div>
      ))}
    </div>
    {problems.length > 0 && (
      <p className="mt-2 text-xs" style={{ color: 'hsl(var(--caution))' }}>
        {problems.join(' ')}
      </p>
    )}
  </>
)

const Problems = ({ messages }: { messages: readonly string[] }) => (
  <div
    className="mb-3 space-y-1 rounded-sm border px-3 py-2 text-sm"
    style={{ borderColor: 'hsl(var(--caution))', color: 'hsl(var(--caution))' }}
    role="alert"
  >
    {messages.map((message) => (
      <p key={message}>{message}</p>
    ))}
  </div>
)

const SummaryPanel = ({
  plan,
  decimals,
  symbol,
  problems,
  rollPolicy,
  pricedFromChain,
  onConfirm,
}: {
  plan: Plan | null
  decimals: number
  symbol: string
  problems: readonly string[]
  rollPolicy: boolean
  pricedFromChain: boolean
  onConfirm: () => void
}) => (
  <Panel title="Summary" subtitle="What goes to work, before you sign.">
    <SummaryRows plan={plan} decimals={decimals} symbol={symbol} />

    <div className="border-t border-border px-4 py-4">
      {problems.length > 0 && <Problems messages={problems} />}

      <DepositButton
        plan={plan}
        rollPolicy={rollPolicy}
        pricedFromChain={pricedFromChain}
        onDone={onConfirm}
      />
    </div>
  </Panel>
)

/**
 * The right column: what exactly will be signed. A separate component not for beauty —
 * the complexity boundary keeps the screen readable as a single thought.
 */
const PreviewColumn = ({
  pricing,
  result,
  plan,
  decimals,
  symbol,
  distribution,
  rollPolicy,
  onConfirm,
}: {
  pricing: Pricing
  result: PlanResult | null
  plan: Plan | null
  decimals: number
  symbol: string
  distribution: 'even' | 'weighted'
  rollPolicy: boolean
  onConfirm: () => void
}) => {
  const priced = pricing.kind === 'unavailable' ? null : pricing
  const amountProblems =
    !result || result.ok ? [] : result.problems.filter((problem) => problem.field === 'amount')

  /** One reason: either there are no prices at all, or the configuration does not pass. */
  const unpriced =
    pricing.kind === 'unavailable'
      ? [pricing.reason]
      : (result?.ok ? [] : (result?.problems ?? [])).map((problem) => problem.message)

  return (
    <div className="space-y-4">
      <Panel
        title="Preview"
        subtitle={
          priced
            ? `${distribution === 'even' ? 'Even split' : 'Custom weights'} · fee ${formatBps(priced.market.feeBps)} (${priced.market.feeBps} bps) · roll policy ${rollPolicy ? 'on' : 'off'} · ${pricing.kind === 'chain' ? 'read from chain' : 'prototype prices'}`
            : 'No prices to build a preview from.'
        }
      >
        {plan ? (
          <RungTable
            rungs={plan.rungs.map((rung) => toRow(rung, decimals, priced?.market.source ?? ''))}
            totals={{
              deposited: formatAmountShown(plan.totals.deposited, decimals),
              fee: formatAmountShown(plan.totals.fee, decimals),
              working: formatAmountShown(plan.totals.working, decimals),
              guaranteed: formatAmountShown(plan.totals.guaranteed, decimals),
            }}
          />
        ) : (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            <p>No schedule is priced for this configuration.</p>
            <ul className="mt-2 space-y-1">
              {unpriced.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
            <p className="mt-2">
              Nothing is estimated here — an unpriced ladder shows nothing rather than a guess.
            </p>
          </div>
        )}
      </Panel>

      <SummaryPanel
        plan={plan}
        decimals={decimals}
        symbol={symbol}
        problems={amountProblems.map((problem) => problem.message)}
        rollPolicy={rollPolicy}
        pricedFromChain={pricing.kind === 'chain'}
        onConfirm={onConfirm}
      />
    </div>
  )
}

export const BuildLadder = ({ onConfirm }: { onConfirm: () => void }) => {
  const pricing = usePricing()
  const priced = pricing.kind === 'unavailable' ? null : pricing

  const [amount, setAmount] = useState('1000000')
  const [horizon, setHorizon] = useState<number>(180)
  const [rungCount, setRungCount] = useState<number>(4)
  const [distribution, setDistribution] = useState<'even' | 'weighted'>('even')
  const [weights, setWeights] = useState<Weight[]>(() => weightsFor(4))
  const [rollPolicy, setRollPolicy] = useState(false)

  const calendar = priced?.calendar ?? []

  const rungOptions = useMemo(
    () => Array.from({ length: maxRungs(calendar, horizon) }, (_, index) => index + 1),
    [calendar, horizon],
  )

  const result = useMemo(
    () =>
      priced
        ? buildPlan(
            {
              amount,
              horizonDays: horizon,
              rungCount,
              distribution,
              weights: weights.map((entry) => entry.value),
            },
            priced.market,
            priced.calendar,
          )
        : null,
    [priced, amount, horizon, rungCount, distribution, weights],
  )

  const plan = result?.ok ? result.plan : null
  const decimals = priced?.market.decimals ?? 0
  const symbol = priced?.market.symbol ?? treasury.asset

  const problemsIn = (field: ProblemField) =>
    !result || result.ok ? [] : result.problems.filter((problem) => problem.field === field)

  const changeWeight = (id: string, value: string) =>
    setWeights((current) => current.map((entry) => (entry.id === id ? { ...entry, value } : entry)))

  const chooseRungCount = (next: number) => {
    setRungCount(next)
    setWeights(weightsFor(next))
  }

  const chooseHorizon = (next: number) => {
    setHorizon(next)
    // The horizon can pull published dates out from under already selected rungs —
    // then the count follows by itself instead of staying unreachable.
    const allowed = maxRungs(calendar, next)
    if (rungCount > allowed) chooseRungCount(allowed)
  }

  const rungsHelper = priced
    ? `Each rung must hold at least ${formatAmount(priced.market.minRungAmount, decimals)} ${symbol}. Up to ${MAX_RUNGS_PER_DEPOSIT} rungs fit in one signature; ${rungOptions.length} maturities are published within ${horizon} days.`
    : 'Rungs cannot be chosen until the market is read.'

  const rungProblems = problemsIn('rungs').map((problem) => problem.message)

  /**
   * There will be no mock balance next to a real signature. This screen cannot read the
   * real one yet, and saying so is more honest than substituting a treasury
   * number that does not exist.
   */
  const amountHelper = liveNetwork
    ? 'Funds come from your associated token account for this market. Its balance is not read here — a deposit larger than it will be refused by the network.'
    : `Available ${treasury.totalBalance} ${treasury.asset}`

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(340px,420px)_1fr]">
      <div className="space-y-4">
        <Panel
          title="Build ladder"
          subtitle={`${treasury.name} · ${symbol} on ${treasury.network}`}
        >
          <FieldRow label="Amount" helper={amountHelper}>
            <div className="flex items-center gap-2">
              <input
                className="field"
                inputMode="decimal"
                value={amount}
                aria-label="Amount in USDC"
                onChange={(event) => setAmount(event.target.value)}
              />
              <span className="text-sm text-muted-foreground">{symbol}</span>
            </div>
          </FieldRow>

          <FieldRow label="Horizon">
            <SegmentedControl
              options={HORIZONS}
              value={horizon}
              onChange={chooseHorizon}
              format={(option) => `${option} d`}
            />
          </FieldRow>

          <FieldRow label="Rungs" helper={rungsHelper}>
            <SegmentedControl options={rungOptions} value={rungCount} onChange={chooseRungCount} />
            {rungProblems.length > 0 && (
              <p className="mt-2 text-xs" style={{ color: 'hsl(var(--caution))' }}>
                {rungProblems.join(' ')}
              </p>
            )}
          </FieldRow>

          <FieldRow label="Distribution">
            <SegmentedControl
              options={['even', 'weighted'] as const}
              value={distribution}
              onChange={setDistribution}
              format={(option) => (option === 'even' ? 'Even' : 'Custom weights')}
            />
            {distribution === 'weighted' && (
              <WeightsGrid
                weights={weights}
                onChange={changeWeight}
                problems={problemsIn('weights').map((problem) => problem.message)}
              />
            )}
          </FieldRow>

          <FieldRow
            label="Roll policy"
            helper={rollPolicy ? rollPolicyCopy.on : rollPolicyCopy.off}
          >
            <button
              type="button"
              role="switch"
              aria-checked={rollPolicy}
              onClick={() => setRollPolicy((current) => !current)}
              className="inline-flex items-center gap-3"
            >
              <span
                className="relative inline-flex h-5 w-9 items-center rounded-full border border-border transition-colors"
                style={{
                  backgroundColor: rollPolicy ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                }}
              >
                <span
                  className="absolute h-3.5 w-3.5 rounded-full bg-foreground transition-transform"
                  style={{
                    transform: rollPolicy ? 'translateX(19px)' : 'translateX(3px)',
                  }}
                />
              </span>
              <span className="text-sm">{rollPolicy ? 'On' : 'Off'}</span>
            </button>
          </FieldRow>
        </Panel>

        <RateDisclosure
          rungs={plan?.rungs ?? []}
          source={pricing.kind === 'chain' ? 'chain' : 'prototype'}
        />
      </div>

      <PreviewColumn
        pricing={pricing}
        result={result}
        plan={plan}
        decimals={decimals}
        symbol={symbol}
        distribution={distribution}
        rollPolicy={rollPolicy}
        onConfirm={onConfirm}
      />
    </div>
  )
}
