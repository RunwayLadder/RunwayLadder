/**
 * A rung as the treasurer sees it.
 *
 * One view for two sources: the M0 prototype and the ladder from the network. The reason
 * is not saving code — as long as the table and the rung card take some fields from data
 * and some from constants nearby, live numbers will sooner or later end up under an
 * invented operator. Here everything the screen shows arrives as one object.
 */

import type { LadderView, Market, Rung, RungStatus } from '@runway-ladder/sdk'
import { formatAmount, formatAmountShown, formatBps } from '@/lib/amount'
import {
  type Arrival,
  arrivalOf,
  expectedOf,
  isShort,
  type SettlementPreviews,
} from '@/lib/arrival'

export type StatusLabel =
  | 'Active'
  | 'Deficit · awaiting redemption'
  | 'Deficit expected'
  | 'Redeemed'
  | 'Redeemed with deficit'
  | 'Exited'
  | 'Rolled'
  | 'Rolled with deficit'

export type Settlement = {
  readonly settled: string
  readonly shortfall: string
  readonly payoutRatio: string
  readonly note: string
}

/**
 * An open rung that will pay less than its promise (FR-011a) — shown on the row before the
 * money arrives. `final` tells a settled epoch from the program's answer for settling it now.
 */
export type PendingDeficit = {
  readonly expected: string
  readonly shortfall: string
  readonly final: boolean
}

export type RungRecord = {
  /**
   * What identifies the rung across reads: on the network the full account address, elsewhere
   * any id unique in its list. `id` is what the screen shows, and two rungs may share it.
   */
  readonly key: string
  readonly index: number
  readonly id: string
  readonly term: string
  readonly termDays: number
  readonly maturity: string
  readonly countdown: string
  readonly fixedRate: string
  /** Who set the rate and when — FR-010a applies after signing too, not just before. */
  readonly operator: string
  readonly ratesSetAt: string
  /** FR-009b: the source is fixed when the ladder is created, the same for all rungs. */
  readonly yieldSource: string
  /** What the treasury paid in — before the fee. */
  readonly deposited: string
  readonly fee: string
  readonly working: string
  readonly guaranteed: string
  readonly status: StatusLabel
  readonly settlement?: Settlement
  readonly pendingDeficit?: PendingDeficit
}

export type LadderTotals = {
  readonly deposited: string
  readonly fee: string
  readonly working: string
  readonly guaranteed: string
  readonly netGain: string
  readonly rungCount: number
  /**
   * What the rungs were promised, and how far below it `guaranteed` falls. `null` when nothing
   * falls short — then `guaranteed` is the promise.
   */
  readonly shortfall: { readonly promised: string; readonly deficit: string } | null
}

const SECONDS_PER_DAY = 86_400n

/**
 * `Rung.deposited` is what went to work, already net of the fee. What the treasury paid
 * is the two together — subtracting the fee from it once more would take it twice.
 */
const paidIn = (rung: Rung): bigint => rung.deposited + rung.feePaid

const shortAddress = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`

const isoDate = (seconds: bigint): string =>
  new Date(Number(seconds) * 1000).toISOString().slice(0, 10)

const isoStamp = (seconds: bigint): string =>
  `${new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/**
 * The yield source in words. `Market.source` is a tagged union, and the adapter
 * name is taken from it, not from a string nearby: otherwise changing the source in
 * the program would leave the previous name on screen.
 */
export function sourceLabel(market: Market): string {
  return `Deterministic adapter · ${formatBps(market.source.rateBps)} base`
}

/**
 * Rung state → what the treasurer sees. A deficit carries both numbers because
 * the onchain type carries both: "redeemed for less than promised" without the promise
 * is a claim that cannot be verified.
 */
function settlementOf(status: RungStatus, promised: bigint, decimals: number) {
  if (status.kind === 'active') return { label: 'Active' as const }
  if (status.kind === 'exited') {
    return {
      label: 'Exited' as const,
      settlement: {
        settled: formatAmountShown(status.amount, decimals),
        shortfall: formatAmount(0n, decimals),
        payoutRatio: ratio(status.amount, promised),
        note: 'Exited before maturity — the fixed promise no longer applies.',
      },
    }
  }

  if (status.kind === 'rolled' || status.kind === 'rolledWithDeficit') {
    return rolledSettlement(status, promised, decimals)
  }

  const settled = status.amount
  const owed = status.kind === 'redeemedWithDeficit' ? status.promised : promised
  const shortfall = owed > settled ? owed - settled : 0n

  return {
    label: (status.kind === 'redeemedWithDeficit'
      ? 'Redeemed with deficit'
      : 'Redeemed') as StatusLabel,
    settlement: {
      settled: formatAmountShown(settled, decimals),
      shortfall: formatAmountShown(shortfall, decimals),
      payoutRatio: ratio(settled, owed),
      note:
        status.kind === 'redeemedWithDeficit'
          ? 'Base yield fell short. The protocol buffer covered what it could; the remainder was settled pro rata across the epoch.'
          : 'Settled in full at the promised amount.',
    },
  }
}

/**
 * A rolled rung paid the treasury nothing: its amount went into the rung named in the status.
 * The shortfall is shown the same way as on a redemption — it is the same haircut, only the
 * money went back to work instead of out.
 */
function rolledSettlement(
  status: Extract<RungStatus, { kind: 'rolled' | 'rolledWithDeficit' }>,
  promised: bigint,
  decimals: number,
) {
  const owed = status.kind === 'rolledWithDeficit' ? status.promised : promised
  const shortfall = owed > status.amount ? owed - status.amount : 0n
  const into = shortAddress(status.into.toBase58())

  return {
    label: (status.kind === 'rolledWithDeficit' ? 'Rolled with deficit' : 'Rolled') as StatusLabel,
    settlement: {
      settled: formatAmountShown(status.amount, decimals),
      shortfall: formatAmountShown(shortfall, decimals),
      payoutRatio: ratio(status.amount, owed),
      note:
        status.kind === 'rolledWithDeficit'
          ? `Base yield fell short, and what the rung received was rolled into rung ${into} at the furthest date.`
          : `Rolled at par into rung ${into} at the furthest date — nothing was paid out to the treasury.`,
    },
  }
}

/** The payout share is a number for the eye, hence `number`; the money next to it stays exact. */
function ratio(settled: bigint, promised: bigint): string {
  if (promised === 0n) return '—'

  return `${((Number(settled) / Number(promised)) * 100).toFixed(2)}%`
}

/** The open rung's row when it pays less than promised; the label says how certain that is. */
function pendingDeficitOf(arrival: Arrival, decimals: number) {
  if (arrival.kind === 'promise' || !isShort(arrival)) return null

  return {
    label: (arrival.kind === 'settled'
      ? 'Deficit · awaiting redemption'
      : 'Deficit expected') as StatusLabel,
    pendingDeficit: {
      expected: formatAmountShown(arrival.amount, decimals),
      shortfall: formatAmountShown(arrival.promised - arrival.amount, decimals),
      final: arrival.kind === 'settled',
    },
  }
}

const countdown = (maturityTs: bigint, nowSeconds: bigint): string => {
  const seconds = maturityTs - nowSeconds
  if (seconds <= 0n) return `Matured ${isoDate(maturityTs)}`

  const days = seconds / SECONDS_PER_DAY

  return days === 0n ? 'Matures today' : `${days} days to maturity`
}

/**
 * Ladder from the network → screen rows. Rung order is set by `fetchLadder` (by
 * maturity date), and there is nothing to reorder here.
 */
export function toRungRecords(
  view: LadderView,
  market: Market,
  decimals: number,
  nowSeconds: bigint,
  previews: SettlementPreviews,
): RungRecord[] {
  const source = sourceLabel(market)

  return view.rungs.map((entry, index) => {
    const { epoch, rung } = entry
    const termSeconds = epoch.maturityTs - epoch.createdAt
    const state = settlementOf(rung.status, rung.promised, decimals)
    const arrival = arrivalOf(entry, previews)
    const pending = arrival ? pendingDeficitOf(arrival, decimals) : null

    return {
      key: entry.address.toBase58(),
      index: index + 1,
      id: shortAddress(entry.address.toBase58()),
      term: `${termSeconds / SECONDS_PER_DAY} d`,
      termDays: Number(termSeconds / SECONDS_PER_DAY),
      maturity: isoDate(epoch.maturityTs),
      countdown: countdown(epoch.maturityTs, nowSeconds),
      fixedRate: formatBps(epoch.rateBps),
      operator: shortAddress(epoch.createdBy.toBase58()),
      ratesSetAt: isoStamp(epoch.createdAt),
      yieldSource: source,
      deposited: formatAmountShown(paidIn(rung), decimals),
      fee: formatAmountShown(rung.feePaid, decimals),
      working: formatAmountShown(rung.deposited, decimals),
      guaranteed: formatAmountShown(rung.promised, decimals),
      status: pending?.label ?? state.label,
      ...(state.settlement ? { settlement: state.settlement } : {}),
      ...(pending ? { pendingDeficit: pending.pendingDeficit } : {}),
    }
  })
}

/**
 * What a rung pays, or paid, the ladder: the settled amount of a closed rung, the expected one of
 * an open rung. The promise only where nothing has decided otherwise yet.
 */
function paidOutOf(entry: LadderView['rungs'][number], previews: SettlementPreviews): bigint {
  const arrival = arrivalOf(entry, previews)
  if (arrival) return expectedOf(arrival)

  const { status } = entry.rung

  return status.kind === 'active' ? entry.rung.promised : status.amount
}

/**
 * Ladder totals are computed from `bigint`s and formatted once at the end. `guaranteed` is what
 * the rungs actually pay, so the tile, the table footer and the chart agree on one number.
 */
export function toLadderTotals(
  view: LadderView,
  decimals: number,
  previews: SettlementPreviews,
): LadderTotals {
  const sums = view.rungs.reduce(
    (total, entry) => ({
      deposited: total.deposited + paidIn(entry.rung),
      fee: total.fee + entry.rung.feePaid,
      working: total.working + entry.rung.deposited,
      guaranteed: total.guaranteed + paidOutOf(entry, previews),
      promised: total.promised + entry.rung.promised,
    }),
    { deposited: 0n, fee: 0n, working: 0n, guaranteed: 0n, promised: 0n },
  )

  return {
    deposited: formatAmountShown(sums.deposited, decimals),
    fee: formatAmountShown(sums.fee, decimals),
    working: formatAmountShown(sums.working, decimals),
    guaranteed: formatAmountShown(sums.guaranteed, decimals),
    netGain: formatAmountShown(sums.guaranteed - sums.deposited, decimals),
    rungCount: view.rungs.length,
    shortfall:
      sums.guaranteed < sums.promised
        ? {
            promised: formatAmountShown(sums.promised, decimals),
            deficit: formatAmountShown(sums.promised - sums.guaranteed, decimals),
          }
        : null,
  }
}

/**
 * The nearest inflow is the first rung still open. A rung that will arrive short is open too —
 * it is the nearest money coming, and the tile shows what it really brings.
 */
export function nextInflowOf(records: readonly RungRecord[]): RungRecord | null {
  return (
    records.find(
      (record) =>
        record.status === 'Active' ||
        record.status === 'Deficit · awaiting redemption' ||
        record.status === 'Deficit expected',
    ) ?? null
  )
}
