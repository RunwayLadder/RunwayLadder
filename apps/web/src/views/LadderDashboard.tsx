import { useState } from 'react'
import { InflowChart } from '@/components/InflowChart'
import { Panel, StatTile } from '@/components/Primitives'
import { RungTable } from '@/components/RungTable'
import {
  ladder,
  ladderTotals,
  nextInflow,
  type Rung,
  rollPolicyCopy,
  rungs,
  treasury,
} from '@/lib/treasuryMock'

export const LadderDashboard = ({ onOpenRung }: { onOpenRung: (rung: Rung) => void }) => {
  const [rollPolicy, setRollPolicy] = useState<boolean>(ladder.rollPolicy)

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Guaranteed, next 12 months" value={ladderTotals.guaranteed} />
        <StatTile
          label="Laddered"
          value={treasury.laddered}
          meta={`Ladder ${ladder.id} · opened ${ladder.opened}`}
        />
        <StatTile
          label="Floating"
          value={treasury.floating}
          meta={`at ${treasury.floatingRate} variable`}
        />
        <StatTile label="Next inflow" value={nextInflow.amount} meta={`on ${nextInflow.date}`} />
      </div>

      <Panel
        title="Inflow schedule"
        subtitle="Sep 2026 → Aug 2027 · guaranteed versus floating estimate"
      >
        <InflowChart />
      </Panel>

      <Panel
        title={`Rungs · ${ladder.id}`}
        subtitle={`Asset ${ladder.asset} · fee ${ladder.feeRate} (${ladder.feeBps}) · ${ladder.rungCount} rungs · ${ladder.distribution.toLowerCase()} split`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="label-caps">Roll policy</div>
            <p className="mt-1 text-sm text-muted-foreground">
              {rollPolicy ? rollPolicyCopy.on : rollPolicyCopy.off}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={rollPolicy}
            aria-label="Roll policy"
            onClick={() => setRollPolicy((current) => !current)}
            className="inline-flex items-center gap-3"
          >
            <span className="text-sm">{rollPolicy ? 'On' : 'Off'}</span>
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
          </button>
        </div>

        <RungTable
          rungs={rungs}
          onSelect={onOpenRung}
          totals={{
            deposited: ladderTotals.deposited,
            fee: ladderTotals.fee,
            working: ladderTotals.working,
            guaranteed: ladderTotals.guaranteed,
          }}
        />

        <div className="flex flex-wrap gap-x-8 gap-y-1 border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <span>
            Net gain <span className="num text-foreground">{ladderTotals.netGain} USDC</span>
          </span>
          <span>
            Blended net rate{' '}
            <span className="num text-foreground">{ladderTotals.blendedNetRate}</span>
          </span>
          <span>Select a row to open the full rung record.</span>
        </div>
      </Panel>
    </div>
  )
}
