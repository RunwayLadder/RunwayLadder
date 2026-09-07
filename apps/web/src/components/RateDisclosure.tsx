/**
 * Rate disclosure before confirmation (FR-010a).
 *
 * The questions this block answers are "what rate", "who set it" and
 * "when". All three sit **before** the button, not in the activity log after it:
 * trust in the operator must not be implicit, and checking it after signing is
 * already too late.
 */

import { formatBps } from '@/lib/amount'
import type { PlanRung } from '@/lib/plan'
import { Panel } from './Primitives'

/**
 * One operator across all rungs, or several. Collapsing is allowed only when it is
 * truly one: a list of four identical lines adds nothing, while a hidden
 * difference between operators is a hidden difference in trust.
 */
export function singleOperator(rungs: readonly PlanRung[]): string | null {
  const first = rungs[0]?.epoch.operator
  if (first === undefined) return null

  return rungs.every((rung) => rung.epoch.operator === first) ? first : null
}

const stamp = (seconds: bigint): string =>
  `${new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`

const FIXED_NOTE = 'Rate is fixed at issuance and is never revised before maturity.'

export const RateDisclosure = ({
  rungs,
  source,
}: {
  rungs: readonly PlanRung[]
  source: 'chain' | 'prototype'
}) => {
  const operator = singleOperator(rungs)

  return (
    <Panel
      title="Pricing"
      subtitle={
        source === 'chain'
          ? 'Every rate below was published on chain before you confirm.'
          : 'Prototype rates — the operator and timestamps are illustrative.'
      }
    >
      {rungs.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No rates to disclose until the ladder is priced.
        </p>
      ) : (
        <>
          {operator && (
            <p className="border-b border-border px-4 py-2.5 text-sm">
              All rates set by <span className="num">{operator}</span>
            </p>
          )}

          <ul className="px-4 py-1">
            {rungs.map((rung) => (
              <li
                key={rung.index}
                className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-border py-2 text-sm last:border-b-0"
              >
                <span className="num whitespace-nowrap">
                  {rung.epoch.termDays} d · {formatBps(rung.epoch.rateBps)}
                </span>
                <span className="text-xs text-muted-foreground">
                  set {stamp(rung.epoch.ratesSetAt)}
                  {operator ? null : (
                    <>
                      {' by '}
                      <span className="num">{rung.epoch.operator}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>

          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            {FIXED_NOTE}
          </p>
        </>
      )}
    </Panel>
  )
}
