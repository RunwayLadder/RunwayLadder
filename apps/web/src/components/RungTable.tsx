import { Amount, StatusBadge } from '@/components/Primitives'
import type { Rung } from '@/lib/treasuryMock'

const th = 'px-3 py-2 text-left align-bottom label-caps font-medium'
const thNum = `${th} text-right`
const td = 'px-3 py-2.5 align-top text-sm'
const tdNum = `${td} text-right`

export const RungTable = ({
  rungs,
  onSelect,
  totals,
}: {
  rungs: Rung[]
  onSelect?: (rung: Rung) => void
  totals?: {
    deposited: string
    fee: string
    working: string
    guaranteed: string
  }
}) => (
  <div className="overflow-x-auto">
    <table className="w-full min-w-[900px] border-collapse">
      <thead>
        <tr className="border-b border-border">
          <th className={th}>#</th>
          <th className={th}>Term</th>
          <th className={th}>Maturity</th>
          <th className={th}>Fixed rate</th>
          <th className={thNum}>Deposited</th>
          <th className={thNum}>Fee</th>
          <th className={thNum}>Working</th>
          <th className={thNum}>Guaranteed at maturity</th>
          <th className={th}>Status</th>
        </tr>
      </thead>
      <tbody>
        {rungs.map((rung) => {
          const interactive = Boolean(onSelect)
          return (
            <tr
              key={rung.id}
              tabIndex={interactive ? 0 : undefined}
              role={interactive ? 'button' : undefined}
              aria-label={interactive ? `Open rung ${rung.index} detail` : undefined}
              onClick={interactive ? () => onSelect?.(rung) : undefined}
              onKeyDown={
                interactive
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onSelect?.(rung)
                      }
                    }
                  : undefined
              }
              className={`border-b border-border last:border-b-0 ${
                interactive
                  ? 'cursor-pointer hover:bg-[hsl(var(--surface-raised))] focus:bg-[hsl(var(--surface-raised))]'
                  : ''
              }`}
            >
              <td className={`${td} num text-muted-foreground`}>{rung.index}</td>
              <td className={`${td} num whitespace-nowrap`}>{rung.term}</td>
              <td className={`${td} num whitespace-nowrap`}>{rung.maturity}</td>
              <td className={`${td} num`}>{rung.fixedRate}</td>
              <td className={tdNum}>
                <Amount value={rung.deposited} unit={null} />
              </td>
              <td className={`${tdNum} text-muted-foreground`}>
                <Amount value={rung.fee} unit={null} />
              </td>
              <td className={tdNum}>
                <Amount value={rung.working} unit={null} />
              </td>
              <td className={tdNum}>
                <Amount value={rung.guaranteed} unit={null} />
              </td>
              <td className={td}>
                <StatusBadge status={rung.status} />
              </td>
            </tr>
          )
        })}
      </tbody>
      {totals && (
        <tfoot>
          <tr
            className="border-t border-border"
            style={{ backgroundColor: 'hsl(var(--surface-raised))' }}
          >
            <td className={`${td} label-caps`} colSpan={4}>
              Total
            </td>
            <td className={tdNum}>
              <Amount value={totals.deposited} unit={null} />
            </td>
            <td className={`${tdNum} text-muted-foreground`}>
              <Amount value={totals.fee} unit={null} />
            </td>
            <td className={tdNum}>
              <Amount value={totals.working} unit={null} />
            </td>
            <td className={tdNum}>
              <Amount value={totals.guaranteed} unit={null} />
            </td>
            <td className={td} />
          </tr>
        </tfoot>
      )}
    </table>
    {/* Who set these rates and when lives in `RateDisclosure`: here they would be
        a second copy of the same data, and that copy is the one that would drift from the chain. */}
    <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
      Amounts are shown to the cent; “…” marks a figure the display truncates — the signed amount is
      exact to the last unit of the mint.
    </p>
  </div>
)
