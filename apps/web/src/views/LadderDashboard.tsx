import { useWallet } from '@solana/wallet-adapter-react'
import { useState } from 'react'
import { InflowChart } from '@/components/InflowChart'
import { FIRST_LADDER_SEED } from '@/components/NetworkNotice'
import { Panel, StatTile } from '@/components/Primitives'
import { RungTable } from '@/components/RungTable'
import { useLadder, useMarketParams } from '@/lib/chain'
import { liveNetwork } from '@/lib/network'
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

const NOW_SECONDS = BigInt(Math.floor(Date.now() / 1000))

/**
 * The roll policy toggle is local for now: the program has no instruction that changes
 * `Ladder.roll_policy` after creation — it arrives in M2
 * together with the crank. Showing it as applied would be a promise the
 * chain does not keep.
 */
const RollPolicyRow = ({ value, onToggle }: { value: boolean; onToggle: () => void }) => (
  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
    <div>
      <div className="label-caps">Roll policy</div>
      <p className="mt-1 text-sm text-muted-foreground">
        {value ? rollPolicyCopy.on : rollPolicyCopy.off}
      </p>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label="Roll policy"
      onClick={onToggle}
      className="inline-flex items-center gap-3"
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
  chart,
  onOpenRung,
}: {
  title: string
  subtitle: string
  records: readonly RungRecord[]
  totals: LadderTotals
  source: string
  symbol: string
  chart: boolean
  onOpenRung: (rung: RungRecord) => void
}) => {
  const [rollPolicy, setRollPolicy] = useState(false)
  const next = nextInflowOf(records)

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Guaranteed at maturity" value={totals.guaranteed} />
        <StatTile label="Laddered" value={totals.deposited} meta={`${totals.rungCount} rungs`} />
        <StatTile label="Net gain" value={totals.netGain} meta={`fee ${totals.fee} paid`} />
        <StatTile
          label="Next inflow"
          value={next?.guaranteed ?? '—'}
          unit={next ? symbol : null}
          meta={next ? `on ${next.maturity}` : 'no rung is still active'}
        />
      </div>

      {chart && (
        <Panel
          title="Inflow schedule"
          subtitle="Sep 2026 → Aug 2027 · guaranteed versus floating estimate"
        >
          <InflowChart />
        </Panel>
      )}

      <Panel title={title} subtitle={subtitle}>
        <RollPolicyRow value={rollPolicy} onToggle={() => setRollPolicy((current) => !current)} />

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

const PrototypeDashboard = ({ onOpenRung }: { onOpenRung: (rung: RungRecord) => void }) => (
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
    }}
    source={prototypeMarket.source}
    symbol={prototypeMarket.symbol}
    chart
    onOpenRung={onOpenRung}
  />
)

/**
 * On the network the dashboard shows either what was read or the reason there is nothing to read.
 * There are no prototype numbers here in any state: putting them under a connected
 * wallet would mean showing the treasurer someone else's ladder as theirs.
 */
const ChainDashboard = ({ onOpenRung }: { onOpenRung: (rung: RungRecord) => void }) => {
  const { publicKey } = useWallet()
  const market = useMarketParams()
  const ladderQuery = useLadder(publicKey ?? null, FIRST_LADDER_SEED)

  if (!publicKey) {
    return <Empty title="Ladder">Connect a wallet to read the ladder it owns.</Empty>
  }
  if (!liveNetwork?.market) {
    return <Empty title="Ladder">VITE_MARKET is not set — there is no market to read.</Empty>
  }
  if (ladderQuery.isPending || market.isPending) {
    return <Empty title="Ladder">Reading the ladder from the network…</Empty>
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
  const records = toRungRecords(view, market.data.market, decimals, NOW_SECONDS)

  return (
    <LadderPanels
      title={`Rungs · ${view.address.toBase58().slice(0, 4)}…${view.address.toBase58().slice(-4)}`}
      subtitle={`Read from chain · ${records.length} rungs · roll policy ${view.ladder.rollPolicy}`}
      records={records}
      totals={toLadderTotals(view, decimals)}
      source={sourceLabel(market.data.market)}
      symbol={`${market.data.market.assetMint.toBase58().slice(0, 4)}…${market.data.market.assetMint.toBase58().slice(-4)}`}
      chart={false}
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
