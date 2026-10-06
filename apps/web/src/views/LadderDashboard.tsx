import { type CashflowForecast, projectCashflow } from '@runway-ladder/math'
import { useWallet } from '@solana/wallet-adapter-react'
import { type ReactNode, useState } from 'react'
import { CashflowChart } from '@/components/CashflowChart'
import { FIRST_LADDER_SEED } from '@/components/NetworkNotice'
import { Caption, Caution, Panel, StatTile, shortSignature } from '@/components/Primitives'
import { RungTable } from '@/components/RungTable'
import { NO_PREVIEWS, type SettlementPreviews } from '@/lib/arrival'
import { useLadder, useMarketParams, useSettlementPreviews } from '@/lib/chain'
import { NO_FLOATING, PROTOTYPE_FLOATING, prototypeInflows, toInflows } from '@/lib/inflows'
import { liveNetwork } from '@/lib/network'
import type { RollPolicyAction } from '@/lib/rollPolicy'
import {
  type LadderTotals,
  nextInflowOf,
  type RungRecord,
  sourceLabel,
  toLadderTotals,
  toRungRecords,
} from '@/lib/rungRecord'
import {
  ladder,
  ladderTotals,
  prototypeMarket,
  prototypeRecords,
  rollPolicyCopy,
} from '@/lib/treasuryMock'
import { type RollPolicyStatus, useRollPolicy } from '@/lib/useRollPolicy'

const NOW_SECONDS = BigInt(Math.floor(Date.now() / 1000))

/**
 * The roll policy switch. It only draws a position it is given: on the network that is
 * `Ladder.roll_policy` as read, in the prototype a local value. `note` says what the
 * switch is waiting for or why it cannot be used.
 */
const RollPolicyRow = ({
  value,
  onToggle,
  disabled = false,
  note = null,
}: {
  value: boolean
  onToggle: () => void
  disabled?: boolean
  note?: ReactNode
}) => (
  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
    <div>
      <div className="label-caps">Roll policy</div>
      <p className="mt-1 text-sm text-muted-foreground">
        {value ? rollPolicyCopy.on : rollPolicyCopy.off}
      </p>
      {note}
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label="Roll policy"
      onClick={onToggle}
      disabled={disabled}
      className="inline-flex items-center gap-3 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="text-sm">{value ? 'On' : 'Off'}</span>
      <span
        className="relative inline-flex h-5 w-9 items-center rounded-full border border-border transition-colors"
        style={{ backgroundColor: value ? 'hsl(var(--primary))' : 'hsl(var(--muted))' }}
      >
        <span
          className="absolute h-3.5 w-3.5 rounded-full bg-foreground transition-transform"
          style={{ transform: value ? 'translateX(19px)' : 'translateX(3px)' }}
        />
      </span>
    </button>
  </div>
)

/**
 * The ladder itself. The component does not know where the rows came from — which is
 * exactly why the prototype view and the network view cannot drift apart.
 */
const LadderPanels = ({
  title,
  subtitle,
  records,
  totals,
  source,
  symbol,
  decimals,
  forecast,
  forecastNote,
  policy,
  onOpenRung,
}: {
  title: string
  subtitle: string
  records: readonly RungRecord[]
  totals: LadderTotals
  source: string
  symbol: string
  decimals: number
  forecast: CashflowForecast
  /** How certain the chart's amounts are, when some of them are not final. */
  forecastNote?: string | undefined
  /** The roll policy row: the prototype and the network fill it from different state. */
  policy: ReactNode
  onOpenRung: (rung: RungRecord) => void
}) => {
  const next = nextInflowOf(records)

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Guaranteed at maturity"
          value={totals.guaranteed}
          unit={symbol}
          {...(totals.shortfall
            ? {
                meta: `promised ${totals.shortfall.promised} · deficit ${totals.shortfall.deficit}`,
                caution: true,
              }
            : {})}
        />
        <StatTile
          label="Laddered"
          value={totals.deposited}
          unit={symbol}
          meta={`${totals.rungCount} ${totals.rungCount === 1 ? 'rung' : 'rungs'}`}
        />
        <StatTile
          label="Net gain"
          value={totals.netGain}
          unit={symbol}
          meta={`fee ${totals.fee} paid`}
        />
        <StatTile
          label="Next inflow"
          value={next ? (next.pendingDeficit?.expected ?? next.guaranteed) : '—'}
          unit={next ? symbol : null}
          meta={
            next
              ? next.pendingDeficit
                ? `matured ${next.maturity} · ${next.pendingDeficit.shortfall} short of the promise`
                : `on ${next.maturity}`
              : 'no rung is still active'
          }
          caution={Boolean(next?.pendingDeficit)}
        />
      </div>

      <Panel
        title="Inflow schedule"
        subtitle="Twelve months ahead · guaranteed versus floating estimate"
      >
        <CashflowChart
          forecast={forecast}
          decimals={decimals}
          symbol={symbol}
          {...(forecastNote ? { caption: forecastNote } : {})}
        />
      </Panel>

      <Panel title={title} subtitle={subtitle}>
        {policy}

        <RungTable
          rungs={records}
          onSelect={onOpenRung}
          totals={{
            deposited: totals.deposited,
            fee: totals.fee,
            working: totals.working,
            guaranteed: totals.guaranteed,
          }}
        />

        <div className="flex flex-wrap gap-x-8 gap-y-1 border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <span>
            Net gain <span className="num text-foreground">{totals.netGain}</span>
          </span>
          <span>
            Yield source <span className="text-foreground">{source}</span>
          </span>
          <span>Select a row to open the full rung record.</span>
        </div>
      </Panel>
    </div>
  )
}

const Empty = ({ title, children }: { title: string; children: string }) => (
  <Panel title={title}>
    <p className="px-4 py-6 text-sm text-muted-foreground">{children}</p>
  </Panel>
)

const PrototypeDashboard = ({ onOpenRung }: { onOpenRung: (rung: RungRecord) => void }) => {
  // Local on purpose: the prototype signs nothing, so there is no network to ask.
  const [rollPolicy, setRollPolicy] = useState(false)

  return (
    <LadderPanels
      title={`Rungs · ${ladder.id}`}
      subtitle={`Asset ${ladder.asset} · fee ${ladder.feeRate} (${ladder.feeBps}) · ${ladder.rungCount} rungs · ${ladder.distribution.toLowerCase()} split`}
      records={prototypeRecords}
      totals={{
        deposited: ladderTotals.deposited,
        fee: ladderTotals.fee,
        working: ladderTotals.working,
        guaranteed: ladderTotals.guaranteed,
        netGain: ladderTotals.netGain,
        rungCount: ladder.rungCount,
        // A fresh ladder: nothing has matured, so nothing can fall short yet.
        shortfall: null,
      }}
      source={prototypeMarket.source}
      symbol={prototypeMarket.symbol}
      decimals={prototypeMarket.decimals}
      forecast={projectCashflow({
        fromTs: Number(NOW_SECONDS),
        months: 12,
        rungs: prototypeInflows(Number(NOW_SECONDS)),
        floating: PROTOTYPE_FLOATING,
      })}
      policy={
        <RollPolicyRow value={rollPolicy} onToggle={() => setRollPolicy((current) => !current)} />
      }
      onOpenRung={onOpenRung}
    />
  )
}

/** What the switch says under itself: progress, the refusal, or nothing. */
const PolicyNote = ({
  status,
  action,
}: {
  status: RollPolicyStatus
  action: RollPolicyAction | null
}) => {
  switch (status.kind) {
    case 'signing':
      return <Caption>Approve the transaction in your wallet…</Caption>
    case 'confirming':
      return (
        <Caption>
          Signed as{' '}
          <span className="num" title={status.signature}>
            {shortSignature(status.signature)}
          </span>{' '}
          — waiting for confirmation.
        </Caption>
      )
    case 'failed':
      return <Caution>The policy was not changed: {status.message}</Caution>
    case 'idle':
      return action?.kind === 'blocked' ? <Caution>{action.reason}</Caution> : null
  }
}

/**
 * What the chart cannot say with bars: which amounts are not final yet, and which matured epochs
 * could not be asked at all — those show the promise, and the treasurer should know why.
 */
function forecastNoteOf(
  records: readonly RungRecord[],
  previews: SettlementPreviews,
): string | undefined {
  const notes: string[] = []
  if (records.some((record) => record.pendingDeficit && !record.pendingDeficit.final)) {
    notes.push(
      'Matured rungs of an unsettled epoch show what the program would settle it for now — a top-up of the yield source reserve before settlement can still raise it.',
    )
  }

  const failed = [...previews.values()].flatMap((preview) =>
    preview.kind === 'failed' ? [preview.reason] : [],
  )
  if (failed.length > 0) {
    notes.push(
      `${failed.length} matured epoch${failed.length === 1 ? '' : 's'} could not be previewed, so ${failed.length === 1 ? 'its rungs show' : 'their rungs show'} the promise: ${failed.join('; ')}.`,
    )
  }

  return notes.length > 0 ? notes.join(' ') : undefined
}

/**
 * On the network the dashboard shows either what was read or the reason there is nothing to read.
 * There are no prototype numbers here in any state: putting them under a connected
 * wallet would mean showing the treasurer someone else's ladder as theirs.
 */
const ChainDashboard = ({ onOpenRung }: { onOpenRung: (rung: RungRecord) => void }) => {
  const { publicKey } = useWallet()
  const market = useMarketParams()
  const ladderQuery = useLadder(publicKey ?? null, FIRST_LADDER_SEED)
  const policy = useRollPolicy(ladderQuery.data ?? null)
  const previewQuery = useSettlementPreviews(
    ladderQuery.data ?? null,
    publicKey ?? null,
    NOW_SECONDS,
  )

  if (!publicKey) {
    return <Empty title="Ladder">Connect a wallet to read the ladder it owns.</Empty>
  }
  if (!liveNetwork?.market) {
    return <Empty title="Ladder">VITE_MARKET is not set — there is no market to read.</Empty>
  }
  if (ladderQuery.isPending || market.isPending) {
    return <Empty title="Ladder">Reading the ladder from the network…</Empty>
  }
  // Waited for rather than filled in later: until it arrives, a matured rung would show its
  // promise as if it were what arrives — the moment FR-011a is about.
  if (previewQuery.isLoading) {
    return <Empty title="Ladder">Asking the program what the matured epochs settle for…</Empty>
  }
  if (ladderQuery.isError) {
    return <Empty title="Ladder">{`The ladder could not be read: ${ladderQuery.error}`}</Empty>
  }
  if (market.isError || !market.data) {
    return <Empty title="Ladder">The market could not be read, so amounts have no unit.</Empty>
  }
  if (!ladderQuery.data) {
    return <Empty title="Ladder">This wallet has not opened a ladder yet.</Empty>
  }

  const view = ladderQuery.data
  const { decimals } = market.data
  const previews = previewQuery.data ?? NO_PREVIEWS
  const records = toRungRecords(view, market.data.market, decimals, NOW_SECONDS, previews)

  return (
    <LadderPanels
      title={`Rungs · ${view.address.toBase58().slice(0, 4)}…${view.address.toBase58().slice(-4)}`}
      subtitle={`Read from chain · ${records.length} rungs · roll policy ${view.ladder.rollPolicy}`}
      records={records}
      totals={toLadderTotals(view, decimals, previews)}
      source={sourceLabel(market.data.market)}
      symbol={`${market.data.market.assetMint.toBase58().slice(0, 4)}…${market.data.market.assetMint.toBase58().slice(-4)}`}
      decimals={decimals}
      // The floating part on the network is unknown: the treasury wallet balance is not
      // the same state, and the dashboard does not read it. A zero here is more honest than an estimate.
      forecast={projectCashflow({
        fromTs: Number(NOW_SECONDS),
        months: 12,
        rungs: toInflows(view, previews, Number(NOW_SECONDS)),
        floating: NO_FLOATING,
      })}
      forecastNote={forecastNoteOf(records, previews)}
      policy={
        <RollPolicyRow
          value={view.ladder.rollPolicy === 'roll'}
          onToggle={() => void policy.toggle()}
          disabled={policy.busy || policy.action?.kind !== 'ready'}
          note={<PolicyNote status={policy.status} action={policy.action} />}
        />
      }
      onOpenRung={onOpenRung}
    />
  )
}

/**
 * The branch is stable across renders (`liveNetwork` is read once at load),
 * so wallet hooks are never called where the providers are absent.
 */
export const LadderDashboard = ({ onOpenRung }: { onOpenRung: (rung: RungRecord) => void }) =>
  liveNetwork ? (
    <ChainDashboard onOpenRung={onOpenRung} />
  ) : (
    <PrototypeDashboard onOpenRung={onOpenRung} />
  )
