import { PublicKey } from '@solana/web3.js'
import { projectCashflow } from '@treasury-runway/math'
import type { LadderView, RungStatus } from '@treasury-runway/sdk'
import { describe, expect, it } from 'vitest'
import { formatAmount } from '../src/lib/amount'
import { NO_FLOATING, PROTOTYPE_FLOATING, prototypeInflows, toInflows } from '../src/lib/inflows'

const KEY = new PublicKey('77B3e5ybjnHjqPXEYgDp2eFHN3RAMGywUM1QWkspD3dH')
const DAY = 86_400
const NOW = 1_800_000_000

const viewOf = (...statuses: RungStatus[]): LadderView => ({
  address: KEY,
  ladder: {
    owner: KEY,
    market: KEY,
    seed: 0n,
    rungCount: statuses.length,
    rollPolicy: 'none',
    createdAt: BigInt(NOW),
    bump: 255,
  },
  rungs: statuses.map((status, index) => ({
    address: KEY,
    rung: {
      ladder: KEY,
      epoch: KEY,
      deposited: 250_000_000_000n,
      promised: 250_358_835_616n,
      feePaid: 625_000_000n,
      status,
      bump: 255,
    },
    epoch: {
      market: KEY,
      maturityTs: BigInt(NOW + (index + 1) * 30 * DAY),
      rateBps: 480,
      createdBy: KEY,
      createdAt: BigInt(NOW),
      totalDeposited: 0n,
      totalPromised: 0n,
      bump: 255,
    },
  })),
})

describe('toInflows', () => {
  /**
   * FR-011a: what actually got paid goes into the projection if the epoch is settled. Otherwise
   * the chart would show the promise as what is coming — and the deficit would only be seen
   * after the fact.
   */
  it('a settled epoch arrives with the actual amount, an unsettled one with the promised', () => {
    const inflows = toInflows(
      viewOf(
        { kind: 'active' },
        { kind: 'redeemedWithDeficit', amount: 250_047_900_000n, promised: 250_358_835_616n },
        { kind: 'redeemed', amount: 250_358_835_616n },
        { kind: 'exited', amount: 249_000_000_000n },
      ),
    )

    expect(inflows.map((entry) => entry.settled)).toEqual([
      null,
      250_047_900_000n,
      250_358_835_616n,
      249_000_000_000n,
    ])
    expect(inflows.every((entry) => entry.promised === 250_358_835_616n)).toBe(true)
  })

  it('the maturity date is carried over as is', () => {
    const inflows = toInflows(viewOf({ kind: 'active' }))

    expect(inflows[0]?.maturityTs).toBe(NOW + 30 * DAY)
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
