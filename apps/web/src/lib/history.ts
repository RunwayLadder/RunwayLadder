/**
 * The redemption history as the treasurer sees it (FR-015): when, how much, where the funds went.
 *
 * Every row is built from the rung **account**: a closed rung is in the history whether or not
 * its transaction could be found. The amount, the deficit and — for a roll — the new rung are
 * written in the status and cannot be lost. The event contributes only what the account does not
 * keep: the moment and, for a redemption, the token account. When it is missing, those two cells
 * say so and why, instead of the row quietly disappearing.
 */

import type { ClosureLookup, LadderView, RungStatus } from '@runway-ladder/sdk'
import { formatAmountShown } from '@/lib/amount'
import type { StatusLabel } from '@/lib/rungRecord'

/** A cell the event fills: its text, or why it stays empty. */
export type Sourced =
  | { readonly kind: 'known'; readonly text: string; readonly title?: string }
  | { readonly kind: 'missing'; readonly reason: string }

export type HistoryRow = {
  readonly key: string
  /** The rung's number in the ladder table — the same position the dashboard shows. */
  readonly rung: number
  readonly rungId: string
  readonly maturity: string
  readonly outcome: StatusLabel
  readonly promised: string
  readonly paid: string
  /** `null` when the rung received all it was promised. */
  readonly shortfall: string | null
  readonly when: Sourced
  readonly where: Sourced
  readonly signature: string | null
}

type Closed = Exclude<RungStatus, { kind: 'active' }>

const shortAddress = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`

const isoDate = (seconds: bigint): string =>
  new Date(Number(seconds) * 1000).toISOString().slice(0, 10)

const isoStamp = (seconds: bigint): string =>
  `${new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`

const OUTCOME: Record<Closed['kind'], StatusLabel> = {
  redeemed: 'Redeemed',
  redeemedWithDeficit: 'Redeemed with deficit',
  exited: 'Exited',
  rolled: 'Rolled',
  rolledWithDeficit: 'Rolled with deficit',
}

/**
 * What the rung was owed. On a deficit the status keeps the promise next to the payout; without
 * one the payout **is** the promise of the rung.
 */
const owedOf = (status: Closed, promised: bigint): bigint =>
  status.kind === 'redeemedWithDeficit' || status.kind === 'rolledWithDeficit'
    ? status.promised
    : promised

/**
 * Where the funds went. A roll names its new rung in the account status itself, so its
 * destination never depends on the logs; a redemption's token account is known only from
 * the event.
 */
function whereOf(
  status: Closed,
  found: ClosureLookup,
  positions: ReadonlyMap<string, number>,
  missing: Sourced,
): Sourced {
  if (status.kind === 'rolled' || status.kind === 'rolledWithDeficit') {
    const into = status.into.toBase58()
    const position = positions.get(into)
    const number = position === undefined ? '' : `#${position} · `

    return { kind: 'known', text: `Rolled into rung ${number}${shortAddress(into)}`, title: into }
  }
  if (found.kind === 'found' && found.closure.kind === 'redeemed') {
    const destination = found.closure.destination.toBase58()

    return {
      kind: 'known',
      text: `Owner's account ${shortAddress(destination)}`,
      title: destination,
    }
  }

  return missing
}

/**
 * Closed rungs → history rows, newest first.
 *
 * `lookup` answers for each closed rung what the node gave: the closing event, or the reason
 * there is none — including "still reading" and "the read failed", which are the hook's to name.
 */
export function toHistoryRows(
  view: LadderView,
  lookup: (rung: string) => ClosureLookup,
  decimals: number,
): HistoryRow[] {
  const positions = new Map(
    view.rungs.map((entry, index) => [entry.address.toBase58(), index + 1] as const),
  )

  const rows = view.rungs.flatMap((entry, index) => {
    const { status } = entry.rung
    if (status.kind === 'active') return []

    const address = entry.address.toBase58()
    const found = lookup(address)
    const closure = found.kind === 'found' ? found.closure : null
    const owed = owedOf(status, entry.rung.promised)
    const missing: Sourced = {
      kind: 'missing',
      reason:
        found.kind === 'missing' ? found.reason : 'the closing event does not name an account',
    }

    const row: HistoryRow & { at: bigint } = {
      key: address,
      rung: index + 1,
      rungId: shortAddress(address),
      maturity: isoDate(entry.epoch.maturityTs),
      outcome: OUTCOME[status.kind],
      promised: formatAmountShown(owed, decimals),
      paid: formatAmountShown(status.amount, decimals),
      shortfall: owed > status.amount ? formatAmountShown(owed - status.amount, decimals) : null,
      when: closure ? { kind: 'known', text: isoStamp(closure.at) } : missing,
      where: whereOf(status, found, positions, missing),
      signature: found.kind === 'found' ? found.signature : null,
      // Without an event the maturity is the best bound on when the rung closed: a rung
      // cannot be closed before its epoch matures.
      at: closure?.at ?? entry.epoch.maturityTs,
    }

    return [row]
  })

  return rows
    .sort((a, b) => (a.at === b.at ? b.rung - a.rung : a.at > b.at ? -1 : 1))
    .map(({ at: _at, ...row }) => row)
}
