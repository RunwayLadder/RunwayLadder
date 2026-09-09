/**
 * A rung as the treasurer sees it.
 *
 * One view for two sources: the M0 prototype and the ladder from the network. The reason
 * is not saving code — as long as the table and the rung card take some fields from data
 * and some from constants nearby, live numbers will sooner or later end up under an
 * invented operator. Here everything the screen shows arrives as one object.
 */

import type { LadderView, Market, RungStatus } from '@treasury-runway/sdk'
import { formatAmount, formatAmountShown, formatBps } from '@/lib/amount'

export type StatusLabel = 'Active' | 'Redeemed' | 'Redeemed with deficit' | 'Exited'

export type Settlement = {
  readonly settled: string
  readonly shortfall: string
  readonly payoutRatio: string
  readonly note: string
}

export type RungRecord = {
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
  readonly deposited: string
  readonly fee: string
  readonly working: string
  readonly guaranteed: string
  readonly status: StatusLabel
  readonly settlement?: Settlement
}

export type LadderTotals = {
  readonly deposited: string
  readonly fee: string
  readonly working: string
  readonly guaranteed: string
  readonly netGain: string
  readonly rungCount: number
}

const SECONDS_PER_DAY = 86_400n

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
          ? 'Base yield fell short. Yield-holder income and the protocol buffer were applied first; the remainder was settled pro rata across the epoch.'
          : 'Settled in full at the promised amount.',
    },
  }
}

/** The payout share is a number for the eye, hence `number`; the money next to it stays exact. */
function ratio(settled: bigint, promised: bigint): string {
  if (promised === 0n) return '—'

  return `${((Number(settled) / Number(promised)) * 100).toFixed(2)}%`
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
): RungRecord[] {
  const source = sourceLabel(market)

  return view.rungs.map((entry, index) => {
    const { epoch, rung } = entry
    const termSeconds = epoch.maturityTs - epoch.createdAt
    const state = settlementOf(rung.status, rung.promised, decimals)

    return {
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
      deposited: formatAmountShown(rung.deposited, decimals),
      fee: formatAmountShown(rung.feePaid, decimals),
      working: formatAmountShown(rung.deposited - rung.feePaid, decimals),
      guaranteed: formatAmountShown(rung.promised, decimals),
      status: state.label,
      ...(state.settlement ? { settlement: state.settlement } : {}),
    }
  })
}

/** Ladder totals are computed from `bigint`s and formatted once at the end. */
export function toLadderTotals(view: LadderView, decimals: number): LadderTotals {
  const sums = view.rungs.reduce(
    (total, { rung }) => ({
      deposited: total.deposited + rung.deposited,
      fee: total.fee + rung.feePaid,
      working: total.working + (rung.deposited - rung.feePaid),
      guaranteed: total.guaranteed + rung.promised,
    }),
    { deposited: 0n, fee: 0n, working: 0n, guaranteed: 0n },
  )

  return {
    deposited: formatAmountShown(sums.deposited, decimals),
    fee: formatAmountShown(sums.fee, decimals),
    working: formatAmountShown(sums.working, decimals),
    guaranteed: formatAmountShown(sums.guaranteed, decimals),
    netGain: formatAmountShown(sums.guaranteed - sums.deposited, decimals),
    rungCount: view.rungs.length,
  }
}

/** The nearest inflow is the first rung that has not matured yet. */
export function nextInflowOf(records: readonly RungRecord[]): RungRecord | null {
  return records.find((record) => record.status === 'Active') ?? null
}
