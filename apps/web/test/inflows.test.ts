import { projectCashflow } from '@runway-ladder/math'
import {
  type EpochStatus,
  epochAddress,
  type LadderView,
  type RungStatus,
  type SettledStatus,
} from '@runway-ladder/sdk'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { formatAmount } from '../src/lib/amount'
import { NO_PREVIEWS, type SettlementPreview } from '../src/lib/arrival'
import { NO_FLOATING, PROTOTYPE_FLOATING, prototypeInflows, toInflows } from '../src/lib/inflows'

const KEY = new PublicKey('77B3e5ybjnHjqPXEYgDp2eFHN3RAMGywUM1QWkspD3dH')
const DAY = 86_400
const NOW = 1_800_000_000
const epochKey = (index: number) => epochAddress(KEY, KEY, BigInt(NOW + index))

const PROMISED = 250_358_835_616n

type Entry = {
  status: RungStatus
  /** Days from `NOW` to maturity; negative — matured in the past. */
  days: number
  epoch?: EpochStatus
}

/** Every rung in its own epoch, the rung's promise the epoch's whole promise. */
const viewOf = (...entries: Entry[]): LadderView => ({
  address: KEY,
  ladder: {
    owner: KEY,
    market: KEY,
    seed: 0n,
    rungCount: entries.length,
    rollPolicy: 'none',
    createdAt: BigInt(NOW),
    bump: 255,
  },
  rungs: entries.map((entry, index) => ({
    address: KEY,
    rung: {
      ladder: KEY,
      epoch: epochKey(index),
      index,
      deposited: 250_000_000_000n,
      promised: PROMISED,
      feePaid: 625_000_000n,
      status: entry.status,
      bump: 255,
    },
    epoch: {
      market: KEY,
      maturityTs: BigInt(NOW + entry.days * DAY),
      rateBps: 480,
      createdBy: KEY,
      createdAt: BigInt(NOW - 60 * DAY),
      totalDeposited: 250_000_000_000n,
      totalPromised: PROMISED,
      depositSeconds: 0n,
      redeemed: 0n,
      status: entry.epoch ?? { kind: 'active' },
      bump: 255,
    },
  })),
})

const SHORT: EpochStatus = {
  kind: 'settledWithDeficit',
  paid: 250_047_900_000n,
  deficit: 310_935_616n,
}

describe('toInflows', () => {
  /**
   * The forecast is what is still coming: a redeemed rung has arrived, a rolled one lives on as
   * the newer rung it went into. Either on the chart again would count money that is not coming.
   */
  it('leaves out every closed rung', () => {
    const into = new PublicKey('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8')
    const inflows = toInflows(
      viewOf(
        {
          status: { kind: 'redeemedWithDeficit', amount: 250_047_900_000n, promised: PROMISED },
          days: -3,
          epoch: SHORT,
        },
        {
          status: { kind: 'redeemed', amount: PROMISED },
          days: -2,
          epoch: { kind: 'settled', paid: PROMISED },
        },
        {
          status: { kind: 'rolled', amount: PROMISED, into },
          days: -1,
          epoch: { kind: 'settled', paid: PROMISED },
        },
        { status: { kind: 'active' }, days: 30 },
      ),
      NO_PREVIEWS,
      NOW,
    )

    expect(inflows).toEqual([{ maturityTs: NOW + 30 * DAY, promised: PROMISED, settled: null }])
  })

  /**
   * FR-011a: the epoch settled short, the rung is not redeemed yet. The actual amount is on the
   * chart now — and in the current month, since a past date would drop it out of the window.
   */
  it('a matured rung of a settled epoch is due now, at the actual amount', () => {
    const inflows = toInflows(
      viewOf({ status: { kind: 'active' }, days: -5, epoch: SHORT }),
      NO_PREVIEWS,
      NOW,
    )

    expect(inflows).toEqual([{ maturityTs: NOW, promised: PROMISED, settled: 250_047_900_000n }])
  })

  it('a matured rung of an unsettled epoch arrives at what settling it now pays', () => {
    const previews = new Map<string, SettlementPreview>([
      [epochKey(0).toBase58(), { kind: 'previewed', status: SHORT as SettledStatus }],
    ])
    const inflows = toInflows(viewOf({ status: { kind: 'active' }, days: -1 }), previews, NOW)

    expect(inflows[0]?.settled).toBe(250_047_900_000n)
  })

  it('without a preview a matured rung shows its promise, not a guess', () => {
    const previews = new Map<string, SettlementPreview>([
      [epochKey(0).toBase58(), { kind: 'failed', reason: 'the node is down' }],
    ])
    const inflows = toInflows(viewOf({ status: { kind: 'active' }, days: -1 }), previews, NOW)

    expect(inflows).toEqual([{ maturityTs: NOW, promised: PROMISED, settled: null }])
  })

  it('a rung before maturity keeps its own date and its promise', () => {
    const inflows = toInflows(viewOf({ status: { kind: 'active' }, days: 30 }), NO_PREVIEWS, NOW)

    expect(inflows).toEqual([{ maturityTs: NOW + 30 * DAY, promised: PROMISED, settled: null }])
  })

  /** The whole path to the bars: the deficit is in this month's bucket, both numbers kept. */
  it('the chart shows the deficit in the current month', () => {
    const forecast = projectCashflow({
      fromTs: NOW,
      months: 12,
      rungs: toInflows(
        viewOf({ status: { kind: 'active' }, days: -5, epoch: SHORT }),
        NO_PREVIEWS,
        NOW,
      ),
      floating: NO_FLOATING,
    })

    expect(forecast.months[0]).toMatchObject({ guaranteed: 250_047_900_000n, promised: PROMISED })
    expect(forecast.outsideHorizon).toEqual({ guaranteed: 0n, promised: 0n })
  })
})

describe('prototypeInflows', () => {
  /** The same numbers the prototype table and the form preview show. */
  it('add up to the guaranteed total of the reference ladder', () => {
    const total = prototypeInflows(NOW).reduce((sum, entry) => sum + entry.promised, 0n)

    expect(formatAmount(total, 6)).toBe('1,011,683.63')
  })

  it('all rungs are still unsettled', () => {
    expect(prototypeInflows(NOW).every((entry) => entry.settled === null)).toBe(true)
  })
})

describe('projection on dashboard data', () => {
  it('the charted total equals the sum of rungs in the window (SC-005)', () => {
    const rungs = prototypeInflows(NOW)
    const forecast = projectCashflow({ fromTs: NOW, months: 12, rungs, floating: NO_FLOATING })

    const onChart = forecast.months.reduce((sum, month) => sum + month.guaranteed, 0n)
    const total = rungs.reduce((sum, entry) => sum + entry.promised, 0n)

    expect(onChart + forecast.outsideHorizon.guaranteed).toBe(total)
  })

  it('the prototype floating estimate is non-zero in every month', () => {
    // These are the bars that were invisible on a scale shared with the guaranteed ones — and
    // that is why the chart is split into two scales.
    const forecast = projectCashflow({
      fromTs: NOW,
      months: 12,
      rungs: prototypeInflows(NOW),
      floating: PROTOTYPE_FLOATING,
    })

    expect(forecast.months.every((month) => month.floating > 0n)).toBe(true)
  })
})
