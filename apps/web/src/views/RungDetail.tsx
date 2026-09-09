import { useState } from 'react'
import { Amount, KeyValue, Panel, StatusBadge } from '@/components/Primitives'
import type { RungRecord } from '@/lib/rungRecord'
import { type ActivityRow, epoch, ladder } from '@/lib/treasuryMock'

type PreviewState = 'Active' | 'Redeemed with deficit'

/**
 * `deficitPreview` exists only for the prototype: there is no redemption in M1 at all, and
 * the toggle on live data would show a state the rung has never been in.
 */
export const RungDetail = ({
  rung,
  deficitPreview,
  activity,
  onBack,
}: {
  rung: RungRecord
  deficitPreview?: RungRecord
  /** The activity trail. A prototype log under a live rung would be invented
   *  captions under real numbers, so it arrives from outside rather than from here.
   *  Reading events from the network is separate work (FR-021, T041). */
  activity?: readonly ActivityRow[]
  onBack: () => void
}) => {
  const [previewState, setPreviewState] = useState<PreviewState>('Active')
  const record: RungRecord = previewState === 'Active' || !deficitPreview ? rung : deficitPreview
  const settlement = record.settlement

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        ← Back to ladder {ladder.id}
      </button>

      <Panel
        title={`Rung ${record.index} · ${record.id}`}
        subtitle={`${record.term} term · matures ${record.maturity}`}
        right={
          deficitPreview && (
            <div className="text-right">
              <div className="label-caps mb-1">Preview state</div>
              <div className="inline-flex overflow-hidden rounded-sm border border-border">
                {(['Active', 'Redeemed with deficit'] as const).map((state) => (
                  <button
                    key={state}
                    type="button"
                    aria-pressed={previewState === state}
                    onClick={() => setPreviewState(state)}
                    className={`px-2.5 py-1 text-xs ${
                      previewState === state
                        ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {state}
                  </button>
                ))}
              </div>
            </div>
          )
        }
      >
        <div className="grid gap-x-8 px-4 py-2 md:grid-cols-2">
          <div>
            <KeyValue label="Status">
              <StatusBadge status={record.status} />
            </KeyValue>
            <KeyValue label="Term">
              <span className="num">{record.term}</span>
            </KeyValue>
            <KeyValue label="Maturity">
              <span className="num">{record.maturity}</span>
              <span className="ml-2 text-xs text-muted-foreground">{record.countdown}</span>
            </KeyValue>
            <KeyValue label="Fixed rate" helper={epoch.fixedNote}>
              <span className="num text-base">{record.fixedRate}</span>
              <div className="mt-1 text-xs text-muted-foreground">
                Set by <span className="num">{record.operator}</span>
              </div>
              <div className="text-xs text-muted-foreground">Rate set {record.ratesSetAt}</div>
            </KeyValue>
            <KeyValue label="Yield source">{record.yieldSource}</KeyValue>
          </div>

          <div>
            <KeyValue label="Deposited">
              <Amount value={record.deposited} />
            </KeyValue>
            <KeyValue label={`Fee (${ladder.feeRate})`}>
              <Amount value={record.fee} className="text-muted-foreground" />
            </KeyValue>
            <KeyValue label="Working">
              <Amount value={record.working} />
            </KeyValue>
            {settlement ? (
              <>
                <KeyValue label="Settled at maturity">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <Amount value={settlement.settled} className="text-2xl" />
                    <span className="text-xs text-muted-foreground">
                      Promised <Amount value={record.guaranteed} unit={null} strike />
                    </span>
                  </div>
                </KeyValue>
                <KeyValue label="Shortfall">
                  <Amount value={settlement.shortfall} className="text-[hsl(var(--caution))]" />
                </KeyValue>
                <KeyValue label="Epoch payout ratio">
                  <span className="num">{settlement.payoutRatio}</span>
                </KeyValue>
              </>
            ) : (
              <KeyValue label="Guaranteed at maturity">
                <Amount value={record.guaranteed} className="text-2xl" />
              </KeyValue>
            )}
          </div>
        </div>

        {settlement && (
          <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
            {settlement.note}
          </p>
        )}
      </Panel>

      {activity && (
        <Panel title="Activity" subtitle="Signatures shown as text records.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="label-caps px-4 py-2 text-left font-medium">Time</th>
                  <th className="label-caps px-4 py-2 text-left font-medium">Event</th>
                  <th className="label-caps px-4 py-2 text-right font-medium">Amount</th>
                  <th className="label-caps px-4 py-2 text-left font-medium">Signature</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((row) => (
                  <tr key={row.signature} className="border-b border-border last:border-b-0">
                    <td className="num px-4 py-2.5 text-sm text-muted-foreground">
                      {row.timestamp}
                    </td>
                    <td className="px-4 py-2.5 text-sm">{row.label}</td>
                    <td className="px-4 py-2.5 text-right text-sm">
                      <Amount value={row.amount} unit={null} />
                    </td>
                    <td className="num px-4 py-2.5 text-sm text-muted-foreground">
                      {row.signature}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  )
}
