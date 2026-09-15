import type { Epoch, LadderView, Market, Rung, RungStatus } from '@runway-ladder/sdk'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { nextInflowOf, sourceLabel, toLadderTotals, toRungRecords } from '../src/lib/rungRecord'

const OWNER = new PublicKey('4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi')
const OPERATOR = new PublicKey('QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF')
const MARKET_ADDRESS = new PublicKey('77B3e5ybjnHjqPXEYgDp2eFHN3RAMGywUM1QWkspD3dH')
const RUNG_ADDRESS = new PublicKey('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8')

const DAY = 86_400n
const NOW = 1_800_000_000n
const OPENED = NOW - 10n * DAY

const market: Market = {
  authority: OWNER,
  assetMint: OWNER,
  vault: RUNG_ADDRESS,
  bufferVault: RUNG_ADDRESS,
  source: { kind: 'deterministic', rateBps: 600 },
  feeBps: 25,
  minRungAmount: 10_000_000_000n,
  bump: 254,
}

const epoch = (termDays: bigint): Epoch => ({
  market: MARKET_ADDRESS,
  maturityTs: OPENED + termDays * DAY,
  rateBps: 480,
  createdBy: OPERATOR,
  createdAt: OPENED,
  totalDeposited: 0n,
  totalPromised: 0n,
  bump: 255,
})

const rung = (status: RungStatus): Rung => ({
  ladder: MARKET_ADDRESS,
  epoch: MARKET_ADDRESS,
  deposited: 250_000_000_000n,
  promised: 250_358_835_616n,
  feePaid: 625_000_000n,
  status,
  bump: 255,
})

const viewOf = (...entries: { termDays: bigint; status: RungStatus }[]): LadderView => ({
  address: MARKET_ADDRESS,
  ladder: {
    owner: OWNER,
    market: MARKET_ADDRESS,
    seed: 0n,
    rungCount: entries.length,
    rollPolicy: 'none',
    createdAt: OPENED,
    bump: 255,
  },
  rungs: entries.map((entry) => ({
    address: RUNG_ADDRESS,
    rung: rung(entry.status),
    epoch: epoch(entry.termDays),
  })),
})

describe('toRungRecords', () => {
  it('carries the amount, date, rate and source for every rung (FR-007)', () => {
    const [record] = toRungRecords(
      viewOf({ termDays: 30n, status: { kind: 'active' } }),
      market,
      6,
      NOW,
    )

    expect(record).toMatchObject({
      term: '30 d',
      fixedRate: '4.80%',
      deposited: '250,000.00',
      fee: '625.00',
      working: '249,375.00',
      guaranteed: '250,358.83…',
      status: 'Active',
      yieldSource: 'Deterministic adapter · 6.00% base',
    })
  })

  it('the operator and the rate moment stay visible after signing too', () => {
    const [record] = toRungRecords(
      viewOf({ termDays: 30n, status: { kind: 'active' } }),
      market,
      6,
      NOW,
    )

    expect(record?.operator).toBe('QWmr…UzwF')
    expect(record?.ratesSetAt).toContain('UTC')
  })

  it('the term is counted from epoch creation, not from "now"', () => {
    // A rung does not get shorter because the treasurer opened the screen later.
    const [record] = toRungRecords(
      viewOf({ termDays: 90n, status: { kind: 'active' } }),
      market,
      6,
      NOW,
    )

    expect(record?.term).toBe('90 d')
    expect(record?.countdown).toBe('80 days to maturity')
  })

  it('a date in the past reads as "matured", not as a negative countdown', () => {
    const [record] = toRungRecords(
      viewOf({ termDays: 5n, status: { kind: 'active' } }),
      market,
      6,
      NOW,
    )

    expect(record?.countdown).toMatch(/^Matured /)
  })

  /** FR-011a: a deficit carries both numbers, and both are on screen. */
  it('a deficit shows both what was paid and what was promised', () => {
    const [record] = toRungRecords(
      viewOf({
        termDays: 30n,
        status: {
          kind: 'redeemedWithDeficit',
          amount: 250_047_900_000n,
          promised: 250_358_835_616n,
        },
      }),
      market,
      6,
      NOW,
    )

    expect(record?.status).toBe('Redeemed with deficit')
    expect(record?.settlement).toMatchObject({
      settled: '250,047.90',
      shortfall: '310.93…',
      payoutRatio: '99.88%',
    })
  })

  it('a redemption in full has no deficit', () => {
    const [record] = toRungRecords(
      viewOf({ termDays: 30n, status: { kind: 'redeemed', amount: 250_358_835_616n } }),
      market,
      6,
      NOW,
    )

    expect(record?.status).toBe('Redeemed')
    expect(record?.settlement?.shortfall).toBe('0.00')
  })
})

describe('toLadderTotals', () => {
  it('totals are computed from exact units and formatted once', () => {
    const totals = toLadderTotals(
      viewOf(
        { termDays: 30n, status: { kind: 'active' } },
        { termDays: 90n, status: { kind: 'active' } },
      ),
      6,
    )

    expect(totals).toMatchObject({
      deposited: '500,000.00',
      fee: '1,250.00',
      working: '498,750.00',
      guaranteed: '500,717.67…',
      rungCount: 2,
    })
  })
})

describe('nextInflowOf', () => {
  it('the nearest inflow is the first rung that is still alive', () => {
    const records = toRungRecords(
      viewOf(
        { termDays: 30n, status: { kind: 'redeemed', amount: 1n } },
        { termDays: 90n, status: { kind: 'active' } },
      ),
      market,
      6,
      NOW,
    )

    expect(nextInflowOf(records)?.term).toBe('90 d')
  })

  it('a redeemed ladder has no next inflow', () => {
    const records = toRungRecords(
      viewOf({ termDays: 30n, status: { kind: 'redeemed', amount: 1n } }),
      market,
      6,
      NOW,
    )

    expect(nextInflowOf(records)).toBeNull()
  })
})

describe('sourceLabel', () => {
  it('the source name is taken from the market, not from a string nearby', () => {
    expect(sourceLabel(market)).toBe('Deterministic adapter · 6.00% base')
  })
})
