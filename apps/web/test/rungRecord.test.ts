import type { Epoch, LadderView, Market, Rung, RungStatus } from '@runway-ladder/sdk'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { NO_PREVIEWS, type SettlementPreview } from '../src/lib/arrival'
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
  latestMaturity: OPENED + 90n * DAY,
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
  depositSeconds: 0n,
  redeemed: 0n,
  status: { kind: 'active' },
  bump: 255,
})

const rung = (status: RungStatus): Rung => ({
  ladder: MARKET_ADDRESS,
  epoch: MARKET_ADDRESS,
  index: 0,
  // As the program writes it: net of the fee, the amount the promise is computed from.
  deposited: 249_375_000_000n,
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
      NO_PREVIEWS,
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

  it('the fee rate comes from the market the rung was issued in', () => {
    const view = viewOf({ termDays: 30n, status: { kind: 'active' } })
    const [charged] = toRungRecords(view, market, 6, NOW, NO_PREVIEWS)
    const [free] = toRungRecords(view, { ...market, feeBps: 0 }, 6, NOW, NO_PREVIEWS)

    expect(charged?.feeRate).toBe('0.25%')
    expect(free?.feeRate).toBe('0.00%')
  })

  it('the operator and the rate moment stay visible after signing too', () => {
    const [record] = toRungRecords(
      viewOf({ termDays: 30n, status: { kind: 'active' } }),
      market,
      6,
      NOW,
      NO_PREVIEWS,
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
      NO_PREVIEWS,
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
      NO_PREVIEWS,
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
      NO_PREVIEWS,
    )

    expect(record?.status).toBe('Redeemed with deficit')
    expect(record?.settlement).toMatchObject({
      settled: '250,047.90',
      shortfall: '310.93…',
      payoutRatio: '99.88%',
    })
    // The order on screen is the order the program runs (FR-011): the buffer, then the haircut.
    // There is no yield-holder step, and the note must not claim one.
    expect(record?.settlement?.note).toMatch(/protocol buffer/)
    expect(record?.settlement?.note).not.toMatch(/yield-holder/i)
  })

  it('a rolled rung names where the funds went, and that the treasury received nothing', () => {
    const into = new PublicKey('QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF')
    const [record] = toRungRecords(
      viewOf({ termDays: 30n, status: { kind: 'rolled', amount: 250_358_835_616n, into } }),
      market,
      6,
      NOW,
      NO_PREVIEWS,
    )

    expect(record?.status).toBe('Rolled')
    expect(record?.settlement?.shortfall).toBe('0.00')
    expect(record?.settlement?.note).toMatch(/QWmr…UzwF/)
    expect(record?.settlement?.note).toMatch(/nothing was paid out/)
  })

  it('a rolled deficit keeps both numbers, as a redeemed one does (FR-011a)', () => {
    const into = new PublicKey('QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF')
    const [record] = toRungRecords(
      viewOf({
        termDays: 30n,
        status: {
          kind: 'rolledWithDeficit',
          amount: 250_047_900_000n,
          promised: 250_358_835_616n,
          into,
        },
      }),
      market,
      6,
      NOW,
      NO_PREVIEWS,
    )

    expect(record?.status).toBe('Rolled with deficit')
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
      NO_PREVIEWS,
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
      NO_PREVIEWS,
    )

    expect(totals).toMatchObject({
      deposited: '500,000.00',
      fee: '1,250.00',
      working: '498,750.00',
      guaranteed: '500,717.67…',
      netGain: '717.67…',
      rungCount: 2,
      shortfall: null,
    })
  })
})

/** A rung rolled at maturity and the rung it opened — the same money, twice in the list. */
const CHILD_ADDRESS = new PublicKey('4oqng8fCR6pML9cVYA39hCYn7wYCfcMw9HyVsJoGGGDX')
const rolledChain = (parentStatus: RungStatus): LadderView => {
  const base = viewOf(
    { termDays: 30n, status: parentStatus },
    { termDays: 60n, status: { kind: 'active' } },
  )
  const [parent, child] = base.rungs
  if (!parent || !child) throw new Error('two rungs expected')

  return {
    ...base,
    rungs: [
      parent,
      {
        ...child,
        address: CHILD_ADDRESS,
        rung: {
          ...child.rung,
          deposited: 249_732_938_527n,
          feePaid: 625_897_089n,
          promised: 250_700_000_000n,
        },
      },
    ],
  }
}

describe('toLadderTotals after a roll', () => {
  it('counts the treasury money once: paid in at the first rung, paid out at the last', () => {
    const totals = toLadderTotals(
      rolledChain({ kind: 'rolled', amount: 250_358_835_616n, into: CHILD_ADDRESS }),
      6,
      NO_PREVIEWS,
    )

    expect(totals).toMatchObject({
      deposited: '250,000.00',
      fee: '1,250.89…',
      working: '249,732.93…',
      guaranteed: '250,700.00',
      netGain: '700.00',
      rungCount: 1,
      shortfall: null,
    })
  })

  it('a shortfall taken on the roll stays in the promise', () => {
    const totals = toLadderTotals(
      rolledChain({
        kind: 'rolledWithDeficit',
        amount: 250_047_900_000n,
        promised: 250_358_835_616n,
        into: CHILD_ADDRESS,
      }),
      6,
      NO_PREVIEWS,
    )

    expect(totals.guaranteed).toBe('250,700.00')
    expect(totals.shortfall).toEqual({ promised: '251,010.93…', deficit: '310.93…' })
  })
})

/** An open rung whose epoch promised exactly this rung — the ratio is then the rung's own. */
const openIn = (status: Epoch['status'], termDays = 5n): LadderView => {
  const view = viewOf({ termDays, status: { kind: 'active' } })

  return {
    ...view,
    rungs: view.rungs.map((entry) => ({
      ...entry,
      epoch: { ...entry.epoch, totalPromised: entry.rung.promised, status },
    })),
  }
}

describe('a deficit before redemption (FR-011a)', () => {
  const short = {
    kind: 'settledWithDeficit' as const,
    paid: 250_047_900_000n,
    deficit: 310_935_616n,
  }

  it('the row of a short epoch shows what arrives, the shortfall and that it is final', () => {
    const [record] = toRungRecords(openIn(short), market, 6, NOW, NO_PREVIEWS)

    expect(record?.status).toBe('Deficit · awaiting redemption')
    expect(record?.guaranteed).toBe('250,358.83…')
    expect(record?.pendingDeficit).toEqual({
      expected: '250,047.90',
      shortfall: '310.93…',
      final: true,
    })
  })

  it('a shortfall from the settlement preview is marked as not final', () => {
    const previews = new Map<string, SettlementPreview>([
      [MARKET_ADDRESS.toBase58(), { kind: 'previewed', status: short }],
    ])
    const [record] = toRungRecords(openIn({ kind: 'active' }), market, 6, NOW, previews)

    expect(record?.status).toBe('Deficit expected')
    expect(record?.pendingDeficit?.final).toBe(false)
  })

  it('an epoch settled at par leaves the row as it was', () => {
    const [record] = toRungRecords(
      openIn({ kind: 'settled', paid: 250_358_835_616n }),
      market,
      6,
      NOW,
      NO_PREVIEWS,
    )

    expect(record?.status).toBe('Active')
    expect(record?.pendingDeficit).toBeUndefined()
  })

  /** The tile, the table footer and the chart must agree: the total is what arrives. */
  it('the totals count what arrives and name the promise and the deficit', () => {
    const totals = toLadderTotals(openIn(short), 6, NO_PREVIEWS)

    expect(totals).toMatchObject({
      guaranteed: '250,047.90',
      netGain: '47.90',
      shortfall: { promised: '250,358.83…', deficit: '310.93…' },
    })
  })

  it('a closed rung counts what it settled for, not its promise', () => {
    const totals = toLadderTotals(
      viewOf({
        termDays: 5n,
        status: {
          kind: 'redeemedWithDeficit',
          amount: 250_047_900_000n,
          promised: 250_358_835_616n,
        },
      }),
      6,
      NO_PREVIEWS,
    )

    expect(totals.guaranteed).toBe('250,047.90')
    expect(totals.shortfall?.deficit).toBe('310.93…')
  })

  it('the next inflow is the short rung, since it is still coming', () => {
    const records = toRungRecords(openIn(short), market, 6, NOW, NO_PREVIEWS)

    expect(nextInflowOf(records)?.pendingDeficit?.expected).toBe('250,047.90')
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
      NO_PREVIEWS,
    )

    expect(nextInflowOf(records)?.term).toBe('90 d')
  })

  it('a redeemed ladder has no next inflow', () => {
    const records = toRungRecords(
      viewOf({ termDays: 30n, status: { kind: 'redeemed', amount: 1n } }),
      market,
      6,
      NOW,
      NO_PREVIEWS,
    )

    expect(nextInflowOf(records)).toBeNull()
  })
})

describe('sourceLabel', () => {
  it('the source name is taken from the market, not from a string nearby', () => {
    expect(sourceLabel(market)).toBe('Deterministic adapter · 6.00% base')
  })
})
