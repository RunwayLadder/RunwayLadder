/**
 * TreasuryRunway — static prototype data.
 *
 * Every figure in this file is rendered verbatim by the UI. Amounts are stored
 * as pre-formatted strings so nothing is recomputed in JavaScript floats.
 * Numeric mirrors exist only where a chart needs a bar height.
 *
 * No network calls, no chain reads. This file is the only source of truth.
 */

import type { RungRecord, StatusLabel } from '@/lib/rungRecord'

/** An alias, not a second copy of the union: they have no right to drift apart. */
export type RungStatus = StatusLabel

export type YieldSource = 'Deterministic Adapter · demo' | 'Stablecoin Lending Adapter'

export interface Rung {
  index: number
  id: string
  term: string
  termDays: number
  maturity: string
  fixedRate: string
  deposited: string
  fee: string
  working: string
  guaranteed: string
  status: RungStatus
  countdown: string
  /** Present only when the rung settled below the guaranteed figure. */
  settlement?: {
    settled: string
    shortfall: string
    payoutRatio: string
    note: string
  }
}

export interface ActivityRow {
  timestamp: string
  label: string
  amount: string
  signature: string
}

export const PROTOTYPE_NOTICE = 'Prototype — mock data. Not connected to any network.'

export const MINIMUM_POSITION_SIZE = 10000
export const MINIMUM_POSITION_SIZE_LABEL = '10,000.00'

/**
 * Market parameters that live in `Market` on the network: the mint's decimals, the fee
 * and the minimum rung size in base units. Here they are the prototype's — the form
 * really computes with them, and T031 will substitute the account read from chain.
 */
export const prototypeMarket = {
  symbol: 'USDC',
  source: 'Deterministic Adapter · demo',
  decimals: 6,
  feeBps: 25,
  minRungAmount: 10_000_000_000n,
} as const

/**
 * Terms and rates that the epoch operator publishes on the network (FR-010). The form
 * builds the ladder **from these dates**, not arbitrary ones: a date invented by the
 * client would point at an epoch that does not exist. T030 replaces this list with epochs read from the network.
 */
export const PROTOTYPE_OPERATOR = '9fRe…Lq2b'

/** 2026-08-18 09:14 UTC — the same moment the Pricing panel shows. */
export const PROTOTYPE_RATES_SET_AT = 1_787_044_440n

export const publishedEpochs: { termDays: number; rateBps: number }[] = [
  { termDays: 30, rateBps: 480 },
  { termDays: 60, rateBps: 520 },
  { termDays: 90, rateBps: 560 },
  { termDays: 180, rateBps: 620 },
]

export const treasury = {
  name: 'Northwind Foundation',
  owner: 'Treasury Safe (3-of-5 multisig)',
  address: '7xKQ…vT4m',
  network: 'Solana',
  asset: 'USDC',
  totalBalance: '1,400,000.00',
  laddered: '1,000,000.00',
  floating: '400,000.00',
  floatingRate: '4.80%',
} as const

export const ladder = {
  id: 'LDR-0142',
  opened: '2026-08-20',
  asset: 'USDC',
  feeRate: '0.25%',
  feeBps: '25 bps',
  rungCount: 4,
  distribution: 'Even',
  rollPolicy: false,
  horizonDays: 180,
  /**
   * FR-009b: the source is fixed when the ladder is created and is the same for all its
   * rungs. That is why it lives here and not in `Rung` — a rung with its own source
   * must be unrepresentable, not merely undesirable.
   */
  yieldSource: 'Deterministic Adapter · demo' satisfies YieldSource,
} as const

export const epoch = {
  operator: 'Epoch operator · 9fRe…Lq2b',
  ratesSetAt: '2026-08-18 09:14 UTC',
  fixedNote: 'Rate is fixed at issuance and is never revised before maturity.',
} as const

/**
 * A tuple, not an array: there are exactly four rungs, and `rungs[0]` here is a constant, not
 * an assumption. Otherwise `noUncheckedIndexedAccess` would demand an undefined check
 * in a place where it cannot happen.
 */
export const rungs: [Rung, Rung, Rung, Rung] = [
  {
    index: 1,
    id: 'LDR-0142-R1',
    term: '30 d',
    termDays: 30,
    maturity: '2026-09-19',
    fixedRate: '4.80%',
    deposited: '250,000.00',
    fee: '625.00',
    working: '249,375.00',
    guaranteed: '250,358.83',
    status: 'Active',
    countdown: '30 days to maturity',
  },
  {
    index: 2,
    id: 'LDR-0142-R2',
    term: '60 d',
    termDays: 60,
    maturity: '2026-10-19',
    fixedRate: '5.20%',
    deposited: '250,000.00',
    fee: '625.00',
    working: '249,375.00',
    guaranteed: '251,506.64',
    status: 'Active',
    countdown: '60 days to maturity',
  },
  {
    index: 3,
    id: 'LDR-0142-R3',
    term: '90 d',
    termDays: 90,
    maturity: '2026-11-18',
    fixedRate: '5.60%',
    deposited: '250,000.00',
    fee: '625.00',
    working: '249,375.00',
    guaranteed: '252,818.42',
    status: 'Active',
    countdown: '90 days to maturity',
  },
  {
    index: 4,
    id: 'LDR-0142-R4',
    term: '180 d',
    termDays: 180,
    maturity: '2027-02-16',
    fixedRate: '6.20%',
    deposited: '250,000.00',
    fee: '625.00',
    working: '249,375.00',
    guaranteed: '256,999.72',
    status: 'Active',
    countdown: '180 days to maturity',
  },
]

/** Rung 2 shown as a settled-short record. Preview state only. */
export const rungTwoWithDeficit: Rung = {
  ...rungs[1],
  status: 'Redeemed with deficit',
  countdown: 'Matured 2026-10-19',
  settlement: {
    settled: '250,047.90',
    shortfall: '1,458.73',
    payoutRatio: '99.42%',
    note: 'Base yield fell short. Yield-holder income and the protocol buffer were applied first; the remainder was settled pro rata across the epoch.',
  },
}

export const ladderTotals = {
  deposited: '1,000,000.00',
  fee: '2,500.00',
  working: '997,500.00',
  guaranteed: '1,011,683.63',
  netGain: '11,683.63',
  blendedNetRate: '4.74%',
} as const

export const nextInflow = {
  amount: '250,358.83',
  date: '2026-09-19',
} as const

export const rollPolicyCopy = {
  off: 'Off — matured funds return to the treasury wallet.',
  on: 'On — matured funds open a new rung at the end of the horizon.',
} as const

export const activityLog: ActivityRow[] = [
  {
    timestamp: '2026-08-20 12:04 UTC',
    label: 'Rung issued',
    amount: '250,000.00',
    signature: '4Zt9pQ…mR3vXb',
  },
  {
    timestamp: '2026-08-20 12:04 UTC',
    label: 'Fee to protocol buffer',
    amount: '625.00',
    signature: '2Hs7kA…wL8dNc',
  },
]

/** Canonical build-ladder form defaults. */
export const builderDefaults = {
  amount: '1000000',
  availableLabel: '1,400,000.00',
  horizonDays: 180,
  rungs: 4,
  distribution: 'Even' as 'Even' | 'Custom weights',
  weights: ['25', '25', '25', '25'] as [string, string, string, string],
  rollPolicy: false,
}

/**
 * Prototype rungs in the same shape as those read from the network. The operator,
 * the moment and the source are added here rather than in every record: in the prototype
 * they are identical by construction, and scattered copies drift apart first.
 */
export const prototypeRecords: RungRecord[] = rungs.map((rung) => ({
  ...rung,
  operator: PROTOTYPE_OPERATOR,
  ratesSetAt: epoch.ratesSetAt,
  yieldSource: ladder.yieldSource,
}))

/** The same second rung, shown as redeemed with a deficit. A preview of M2 state. */
export const prototypeDeficitRecord: RungRecord = {
  ...rungTwoWithDeficit,
  operator: PROTOTYPE_OPERATOR,
  ratesSetAt: epoch.ratesSetAt,
  yieldSource: ladder.yieldSource,
}
