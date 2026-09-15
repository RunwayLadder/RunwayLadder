import type { Epoch } from '@runway-ladder/sdk'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { singleOperator } from '../src/components/RateDisclosure'
import type { PlanRung, PublishedEpoch } from '../src/lib/plan'
import { toPublishedEpoch, upcoming } from '../src/lib/pricing'

const OPERATOR = new PublicKey('QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF')
const MARKET = new PublicKey('77B3e5ybjnHjqPXEYgDp2eFHN3RAMGywUM1QWkspD3dH')

const NOW = 1_800_000_000n
const DAY = 86_400n

const epoch = (over: Partial<Epoch> = {}): Epoch => ({
  market: MARKET,
  maturityTs: NOW + 30n * DAY,
  rateBps: 480,
  createdBy: OPERATOR,
  createdAt: NOW - 2n * DAY,
  totalDeposited: 0n,
  totalPromised: 0n,
  bump: 255,
  ...over,
})

describe('toPublishedEpoch', () => {
  it('the term is counted from "now", because the account holds a date, not a term', () => {
    const published = toPublishedEpoch(epoch({ maturityTs: NOW + 90n * DAY }), NOW)

    expect(published.termDays).toBe(90)
    expect(published.maturityTs).toBe(NOW + 90n * DAY)
  })

  it('carries the operator and the moment the rate was set (FR-010a)', () => {
    const published = toPublishedEpoch(epoch(), NOW)

    expect(published.operator).toBe('QWmr…UzwF')
    expect(published.ratesSetAt).toBe(NOW - 2n * DAY)
  })

  it('the term rounds down: a partial day is not a day yet', () => {
    const published = toPublishedEpoch(epoch({ maturityTs: NOW + 30n * DAY - 1n }), NOW)

    expect(published.termDays).toBe(29)
  })
})

describe('upcoming', () => {
  /**
   * `ladder_deposit` rejects an epoch that has already matured (`EpochAlreadyMatured`).
   * The form must not offer what the network will refuse.
   */
  it('removes epochs that can no longer be entered', () => {
    const calendar = upcoming(
      [
        epoch({ maturityTs: NOW - DAY }),
        epoch({ maturityTs: NOW }),
        epoch({ maturityTs: NOW + DAY }),
        epoch({ maturityTs: NOW + 30n * DAY }),
      ],
      NOW,
    )

    expect(calendar.map((entry) => entry.termDays)).toEqual([1, 30])
  })

  it('an empty calendar is an empty list', () => {
    expect(upcoming([], NOW)).toEqual([])
  })
})

describe('singleOperator', () => {
  const rung = (operator: string): PlanRung => ({
    index: 1,
    epoch: {
      termDays: 30,
      rateBps: 480,
      maturityTs: NOW,
      operator,
      ratesSetAt: NOW,
    } satisfies PublishedEpoch,
    deposited: 1n,
    fee: 0n,
    working: 1n,
    guaranteed: 1n,
  })

  it('one operator across all rungs is named once', () => {
    expect(singleOperator([rung('9fRe…Lq2b'), rung('9fRe…Lq2b')])).toBe('9fRe…Lq2b')
  })

  /** Different operators are different trust, and this cannot be collapsed into one line. */
  it('different operators are not collapsed', () => {
    expect(singleOperator([rung('9fRe…Lq2b'), rung('QWmr…UzwF')])).toBeNull()
  })

  it('an empty ladder has no operator', () => {
    expect(singleOperator([])).toBeNull()
  })
})
