/**
 * The redemption history (FR-015): when, how much, and where the funds went.
 *
 * A row comes from the rung account and stays on screen even when its transaction is out of
 * reach: an empty cell names the reason. Hiding the row would make money that left the ladder
 * vanish from the record because a node trimmed its logs.
 */

import type { ClosureLookup } from '@runway-ladder/sdk'
import { useWallet } from '@solana/wallet-adapter-react'
import { FIRST_LADDER_SEED } from '@/components/NetworkNotice'
import { Amount, Panel, StatusBadge, shortSignature } from '@/components/Primitives'
import { useLadder, useMarketParams, useRungClosures } from '@/lib/chain'
import { type HistoryRow, type Sourced, toHistoryRows } from '@/lib/history'
import { liveNetwork } from '@/lib/network'
import { prototypeHistory } from '@/lib/treasuryMock'

const th = 'label-caps px-3 py-2 text-left font-medium'
const thNum = 'label-caps px-3 py-2 text-right font-medium'
const td = 'px-3 py-2.5 text-sm'

/** `mono` for values that are numbers; a sentence with an address in it stays in text type. */
const Cell = ({ value, mono = false }: { value: Sourced; mono?: boolean }) =>
  value.kind === 'known' ? (
    <span className={`whitespace-nowrap ${mono ? 'num' : ''}`} title={value.title}>
      {value.text}
    </span>
  ) : (
    <span className="inline-block max-w-[16rem] text-xs" style={{ color: 'hsl(var(--caution))' }}>
      Not found — {value.reason}
    </span>
  )

const HistoryTable = ({
  title,
  subtitle,
  rows,
  unit,
}: {
  title: string
  subtitle: string
  rows: readonly HistoryRow[]
  unit: string
}) => (
  <Panel title={title} subtitle={`${subtitle} · amounts in ${unit}`}>
    {rows.length === 0 ? (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        No rung has been redeemed or rolled yet. A rung enters the history once its epoch matures
        and the rung is closed.
      </p>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1040px] border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className={th}>Closed</th>
              <th className={th}>Rung</th>
              <th className={th}>Outcome</th>
              <th className={thNum}>Promised</th>
              <th className={thNum}>Paid</th>
              <th className={thNum}>Shortfall</th>
              <th className={th}>Where the funds went</th>
              <th className={th}>Signature</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-border last:border-b-0">
                <td className={`${td} text-muted-foreground`}>
                  <Cell value={row.when} mono />
                </td>
                <td className={td}>
                  <div className="whitespace-nowrap">
                    <span className="num">#{row.rung}</span>{' '}
                    <span className="num text-muted-foreground">{row.rungId}</span>
                  </div>
                  <div className="whitespace-nowrap text-xs text-muted-foreground">
                    matured {row.maturity}
                  </div>
                </td>
                <td className={td}>
                  <StatusBadge status={row.outcome} />
                </td>
                <td className={`${td} text-right`}>
                  <Amount value={row.promised} unit={null} />
                </td>
                <td className={`${td} text-right`}>
                  <Amount value={row.paid} unit={null} />
                </td>
                <td className={`${td} text-right`}>
                  {row.shortfall === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span style={{ color: 'hsl(var(--caution))' }}>
                      <Amount value={row.shortfall} unit={null} />
                    </span>
                  )}
                </td>
                <td className={td}>
                  <Cell value={row.where} />
                </td>
                <td className={`${td} num whitespace-nowrap text-muted-foreground`}>
                  {row.signature === null ? (
                    '—'
                  ) : (
                    <span title={row.signature}>{shortSignature(row.signature)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Panel>
)

const Empty = ({ children }: { children: string }) => (
  <Panel title="Redemption history">
    <p className="px-4 py-6 text-sm text-muted-foreground">{children}</p>
  </Panel>
)

/** What the hook knows about a rung before, or instead of, an answer from the node. */
const pending = (query: ReturnType<typeof useRungClosures>): ((rung: string) => ClosureLookup) => {
  if (query.data) {
    const lookups = query.data
    return (rung) =>
      lookups.get(rung) ?? { kind: 'missing', reason: 'the rung closed after the history was read' }
  }
  if (query.isError) {
    return () => ({ kind: 'missing', reason: `the node could not be read: ${query.error}` })
  }

  return () => ({ kind: 'missing', reason: 'reading the transaction…' })
}

const ChainHistory = () => {
  const { publicKey } = useWallet()
  const market = useMarketParams()
  const ladderQuery = useLadder(publicKey ?? null, FIRST_LADDER_SEED)
  const closures = useRungClosures(ladderQuery.data ?? null)

  if (!publicKey) return <Empty>Connect a wallet to read the history of the ladder it owns.</Empty>
  if (!liveNetwork?.market)
    return <Empty>VITE_MARKET is not set — there is no market to read.</Empty>
  if (ladderQuery.isPending || market.isPending) {
    return <Empty>Reading the ladder from the network…</Empty>
  }
  if (ladderQuery.isError)
    return <Empty>{`The ladder could not be read: ${ladderQuery.error}`}</Empty>
  if (market.isError || !market.data) {
    return <Empty>The market could not be read, so amounts have no unit.</Empty>
  }
  if (!ladderQuery.data) return <Empty>This wallet has not opened a ladder yet.</Empty>

  const view = ladderQuery.data
  const rows = toHistoryRows(view, pending(closures), market.data.decimals)
  const mint = market.data.market.assetMint.toBase58()

  return (
    <HistoryTable
      title="Redemption history"
      subtitle={`Read from chain · ${rows.length} closed of ${view.rungs.length} rungs · amounts from the rung accounts, time and account from the closing transaction`}
      rows={rows}
      unit={`${mint.slice(0, 4)}…${mint.slice(-4)}`}
    />
  )
}

/** The branch is fixed at load, as on the dashboard: wallet hooks run only under their providers. */
export const History = () =>
  liveNetwork ? (
    <ChainHistory />
  ) : (
    <HistoryTable
      title="Redemption history"
      subtitle="Prototype data · one row per way a rung leaves the ladder"
      rows={prototypeHistory}
      unit="USDC"
    />
  )
