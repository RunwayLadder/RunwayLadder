import { type ReactNode, useMemo, useState } from 'react'
import { Amount, Panel } from '@/components/Primitives'
import { RungTable } from '@/components/RungTable'
import {
  builderDefaults,
  epoch,
  ladder,
  ladderTotals,
  MINIMUM_POSITION_SIZE,
  MINIMUM_POSITION_SIZE_LABEL,
  rollPolicyCopy,
  rungs,
  treasury,
} from '@/lib/treasuryMock'

/** A stable `id` instead of an index: the key and `htmlFor` must not depend on position. */
type Weight = { id: string; value: string }

const HORIZONS = [30, 90, 180, 365] as const
const RUNG_OPTIONS = [2, 3, 4, 6] as const

/** Formats a whole-number USDC threshold for the rejection message. */
const thresholdLabel = (value: number): string =>
  value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
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
const SummaryRows = ({ priced }: { priced: boolean }) => {
  const money = (value: string) => (priced ? value : '—')
  const unit = priced ? 'USDC' : null

  return (
    <div className="px-4 py-2">
      <SummaryRow label="Total fee" value={money(ladderTotals.fee)} unit={unit} />
      <SummaryRow label="Working capital" value={money(ladderTotals.working)} unit={unit} />
      <SummaryRow
        label="Guaranteed at maturity"
        value={money(ladderTotals.guaranteed)}
        unit={unit}
      />
      <SummaryRow label="Net gain" value={money(ladderTotals.netGain)} unit={unit} />
      <SummaryRow label="Blended net rate" value={money(ladderTotals.blendedNetRate)} unit={null} />
    </div>
  )
}

export const BuildLadder = ({ onConfirm }: { onConfirm: () => void }) => {
  const [amount, setAmount] = useState(builderDefaults.amount)
  const [horizon, setHorizon] = useState<number>(builderDefaults.horizonDays)
  const [rungCount, setRungCount] = useState<number>(builderDefaults.rungs)
  const [distribution, setDistribution] = useState<'Even' | 'Custom weights'>(
    builderDefaults.distribution,
  )
  const [weights, setWeights] = useState<Weight[]>(() =>
    builderDefaults.weights.map((value, index) => ({
      id: `weight-rung-${index + 1}`,
      value,
    })),
  )
  const [rollPolicy, setRollPolicy] = useState(builderDefaults.rollPolicy)

  const numericAmount = useMemo(() => {
    const parsed = Number(amount.replace(/[,\s]/g, ''))
    return Number.isFinite(parsed) ? parsed : 0
  }, [amount])

  const perRung = rungCount > 0 ? numericAmount / rungCount : 0
  const belowMinimum = perRung < MINIMUM_POSITION_SIZE
  const requiredTotal = thresholdLabel(rungCount * MINIMUM_POSITION_SIZE)

  const evenWeights = weights.every(({ value }) => value.trim() === '25')
  const isReferenceLadder =
    numericAmount === 1_000_000 &&
    rungCount === 4 &&
    horizon === 180 &&
    (distribution === 'Even' || evenWeights)

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(340px,420px)_1fr]">
      <div className="space-y-4">
        <Panel
          title="Build ladder"
          subtitle={`${treasury.name} · ${treasury.asset} on ${treasury.network}`}
        >
          <FieldRow label="Amount" helper={`Available ${builderDefaults.availableLabel} USDC`}>
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
              onChange={setHorizon}
              format={(option) => `${option} d`}
            />
          </FieldRow>

          <FieldRow
            label="Rungs"
            helper={`Each rung must hold at least ${MINIMUM_POSITION_SIZE_LABEL} USDC.`}
          >
            <SegmentedControl options={RUNG_OPTIONS} value={rungCount} onChange={setRungCount} />
          </FieldRow>

          <FieldRow label="Distribution">
            <SegmentedControl
              options={['Even', 'Custom weights'] as const}
              value={distribution}
              onChange={setDistribution}
            />
            {distribution === 'Custom weights' && (
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
          subtitle={`Even split · fee ${ladder.feeRate} (${ladder.feeBps}) · roll policy ${rollPolicy ? 'on' : 'off'}`}
        >
          {isReferenceLadder ? (
            <RungTable
              rungs={rungs}
              totals={{
                deposited: ladderTotals.deposited,
                fee: ladderTotals.fee,
                working: ladderTotals.working,
                guaranteed: ladderTotals.guaranteed,
              }}
            />
          ) : (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              <p>
                Epoch pricing in this prototype is published for one configuration only:{' '}
                <span className="num text-foreground">1,000,000.00 USDC</span>, 4 rungs, 180-day
                horizon, even split.
              </p>
              <p className="mt-2">
                Return the form to those values to see the priced schedule. No figures are estimated
                here — an unpriced ladder shows nothing rather than a guess.
              </p>
            </div>
          )}
        </Panel>

        <Panel title="Summary" subtitle="What goes to work, before you sign.">
          <SummaryRows priced={isReferenceLadder} />

          <div className="border-t border-border px-4 py-4">
            {belowMinimum && (
              <p
                className="mb-3 rounded-sm border px-3 py-2 text-sm"
                style={{
                  borderColor: 'hsl(var(--caution))',
                  color: 'hsl(var(--caution))',
                }}
                role="alert"
              >
                Minimum position size is {MINIMUM_POSITION_SIZE_LABEL} USDC per rung. {rungCount}{' '}
                rungs require at least {requiredTotal} USDC. No funds have been moved.
              </p>
            )}

            <button
              type="button"
              disabled={belowMinimum || !isReferenceLadder}
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
              All four rungs are created in a single transaction.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  )
}
