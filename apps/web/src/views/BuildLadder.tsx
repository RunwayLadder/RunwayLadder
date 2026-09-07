import { type ReactNode, useMemo, useState } from 'react'
import { Amount, Panel } from '@/components/Primitives'
import { RungTable } from '@/components/RungTable'
import { formatAmount, formatAmountShown, formatBps } from '@/lib/amount'
import {
  blendedNetRatePercent,
  buildPlan,
  evenWeightsBps,
  maxRungs,
  type Plan,
  type PlanRung,
  type ProblemField,
  type PublishedEpoch,
} from '@/lib/plan'
import {
  epoch,
  ladder,
  MINIMUM_POSITION_SIZE_LABEL,
  prototypeMarket,
  publishedEpochs,
  type Rung,
  rollPolicyCopy,
  treasury,
} from '@/lib/treasuryMock'

/** A stable `id` instead of an index: the key and `htmlFor` must not depend on position. */
type Weight = { id: string; value: string }

const HORIZONS = [30, 90, 180, 365] as const

/**
 * The prototype calendar's dates are counted from page load and do not
 * drift until it is reloaded. On the network they are set by the epoch operator, and it is
 * their dates that T030 will substitute — here they are merely plausible.
 */
const NOW_SECONDS = BigInt(Math.floor(Date.now() / 1000))

const CALENDAR: PublishedEpoch[] = publishedEpochs.map((entry) => ({
  ...entry,
  maturityTs: NOW_SECONDS + BigInt(entry.termDays * 86_400),
}))

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
const toRow = (rung: PlanRung, decimals: number): Rung => ({
  index: rung.index,
  id: `plan-rung-${rung.index}`,
  term: `${rung.termDays} d`,
  termDays: rung.termDays,
  maturity: isoDate(rung.maturityTs),
  fixedRate: formatBps(rung.rateBps),
  deposited: formatAmountShown(rung.deposited, decimals),
  fee: formatAmountShown(rung.fee, decimals),
  working: formatAmountShown(rung.working, decimals),
  guaranteed: formatAmountShown(rung.guaranteed, decimals),
  status: 'Active',
  countdown: `${rung.termDays} days to maturity`,
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
  unit = 'USDC',
}: {
  label: string
  value: string
  unit?: string | null
}) => (
  <div className="flex items-baseline justify-between gap-6 border-b border-border py-2 last:border-b-0">
    <span className="text-sm text-muted-foreground">{label}</span>
    <Amount value={value} unit={unit} className="text-sm" />
  </div>
)

/**
 * An unpriced configuration shows a dash, not an estimate: a figure here is a promise,
 * and an approximate promise is worse than none.
 */
const SummaryRows = ({ plan, decimals }: { plan: Plan | null; decimals: number }) => {
  const money = (value: bigint) => (plan ? formatAmount(value, decimals) : '—')
  const unit = plan ? 'USDC' : null
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

export const BuildLadder = ({ onConfirm }: { onConfirm: () => void }) => {
  const [amount, setAmount] = useState('1000000')
  const [horizon, setHorizon] = useState<number>(180)
  const [rungCount, setRungCount] = useState<number>(4)
  const [distribution, setDistribution] = useState<'even' | 'weighted'>('even')
  const [weights, setWeights] = useState<Weight[]>(() => weightsFor(4))
  const [rollPolicy, setRollPolicy] = useState(false)

  const rungOptions = useMemo(
    () => Array.from({ length: maxRungs(CALENDAR, horizon) }, (_, index) => index + 1),
    [horizon],
  )

  const result = useMemo(
    () =>
      buildPlan(
        {
          amount,
          horizonDays: horizon,
          rungCount,
          distribution,
          weights: weights.map((entry) => entry.value),
        },
        prototypeMarket,
        CALENDAR,
      ),
    [amount, horizon, rungCount, distribution, weights],
  )

  const plan = result.ok ? result.plan : null
  const problemsIn = (field: ProblemField) =>
    result.ok ? [] : result.problems.filter((problem) => problem.field === field)

  const chooseRungCount = (next: number) => {
    setRungCount(next)
    setWeights(weightsFor(next))
  }

  const chooseHorizon = (next: number) => {
    setHorizon(next)
    // The horizon can pull published dates out from under already selected rungs —
    // then the count follows by itself instead of staying unreachable.
    const allowed = maxRungs(CALENDAR, next)
    if (rungCount > allowed) chooseRungCount(allowed)
  }

  const amountProblems = problemsIn('amount')
  const weightProblems = problemsIn('weights')
  const rungProblems = problemsIn('rungs')

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(340px,420px)_1fr]">
      <div className="space-y-4">
        <Panel
          title="Build ladder"
          subtitle={`${treasury.name} · ${treasury.asset} on ${treasury.network}`}
        >
          <FieldRow label="Amount" helper={`Available ${treasury.totalBalance} USDC`}>
            <div className="flex items-center gap-2">
              <input
                className="field"
                inputMode="decimal"
                value={amount}
                aria-label="Amount in USDC"
                onChange={(event) => setAmount(event.target.value)}
              />
              <span className="text-sm text-muted-foreground">USDC</span>
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

          <FieldRow
            label="Rungs"
            helper={`Each rung must hold at least ${MINIMUM_POSITION_SIZE_LABEL} USDC. Up to 11 rungs fit in one signature; ${rungOptions.length} maturities are published within ${horizon} days.`}
          >
            <SegmentedControl options={rungOptions} value={rungCount} onChange={chooseRungCount} />
            {rungProblems.length > 0 && (
              <p className="mt-2 text-xs" style={{ color: 'hsl(var(--caution))' }}>
                {rungProblems.map((problem) => problem.message).join(' ')}
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
              <>
                <div className="mt-3 grid grid-cols-4 gap-2">
                  {weights.map(({ id, value: weight }, index) => (
                    <div key={id}>
                      <label className="label-caps block" htmlFor={id}>
                        Rung {index + 1}
                      </label>
                      <div className="mt-1 flex items-center gap-1">
                        <input
                          id={id}
                          className="field"
                          inputMode="decimal"
                          value={weight}
                          onChange={(event) => {
                            const next = event.target.value
                            setWeights((current) =>
                              current.map((entry) =>
                                entry.id === id ? { ...entry, value: next } : entry,
                              ),
                            )
                          }}
                        />
                        <span className="text-xs text-muted-foreground">%</span>
                      </div>
                    </div>
                  ))}
                </div>
                {weightProblems.length > 0 && (
                  <p className="mt-2 text-xs" style={{ color: 'hsl(var(--caution))' }}>
                    {weightProblems.map((problem) => problem.message).join(' ')}
                  </p>
                )}
              </>
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

        <Panel
          title="Pricing"
          subtitle="Rates are published by an epoch operator before you confirm."
        >
          <div className="px-4 py-3 text-sm">
            <div className="num">{epoch.operator}</div>
            <div className="mt-1 text-xs text-muted-foreground">Rates set {epoch.ratesSetAt}</div>
            <p className="mt-2 text-xs text-muted-foreground">{epoch.fixedNote}</p>
          </div>
        </Panel>
      </div>

      <div className="space-y-4">
        <Panel
          title="Preview"
          subtitle={`${distribution === 'even' ? 'Even split' : 'Custom weights'} · fee ${ladder.feeRate} (${ladder.feeBps}) · roll policy ${rollPolicy ? 'on' : 'off'}`}
        >
          {plan ? (
            <RungTable
              rungs={plan.rungs.map((rung) => toRow(rung, prototypeMarket.decimals))}
              totals={{
                deposited: formatAmountShown(plan.totals.deposited, prototypeMarket.decimals),
                fee: formatAmountShown(plan.totals.fee, prototypeMarket.decimals),
                working: formatAmountShown(plan.totals.working, prototypeMarket.decimals),
                guaranteed: formatAmountShown(plan.totals.guaranteed, prototypeMarket.decimals),
              }}
            />
          ) : (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              <p>No schedule is priced for this configuration.</p>
              <ul className="mt-2 space-y-1">
                {(result.ok ? [] : result.problems).map((problem) => (
                  <li key={problem.message}>{problem.message}</li>
                ))}
              </ul>
              <p className="mt-2">
                Nothing is estimated here — an unpriced ladder shows nothing rather than a guess.
              </p>
            </div>
          )}
        </Panel>

        <Panel title="Summary" subtitle="What goes to work, before you sign.">
          <SummaryRows plan={plan} decimals={prototypeMarket.decimals} />

          <div className="border-t border-border px-4 py-4">
            {amountProblems.length > 0 && (
              <Problems messages={amountProblems.map((problem) => problem.message)} />
            )}

            <button
              type="button"
              disabled={plan === null}
              onClick={onConfirm}
              className="w-full rounded-sm px-4 py-2.5 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                backgroundColor: 'hsl(var(--primary))',
                color: 'hsl(var(--primary-foreground))',
              }}
            >
              Deposit and build ladder — 1 signature
            </button>
            <p className="mt-2 text-xs text-muted-foreground">
              All {rungCount} rungs are created in a single transaction.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  )
}
