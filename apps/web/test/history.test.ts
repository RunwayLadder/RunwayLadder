import type {
  ClosureLookup,
  Epoch,
  LadderView,
  Rung,
  RungClosure,
  RungStatus,
} from '@runway-ladder/sdk'
import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { toHistoryRows } from '../src/lib/history'

const OWNER = new PublicKey('4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi')
const MARKET = new PublicKey('77B3e5ybjnHjqPXEYgDp2eFHN3RAMGywUM1QWkspD3dH')
const ACCOUNT = new PublicKey('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8')

const DAY = 86_400n
const OPENED = 1_800_000_000n
const PROMISED = 250_358_835_616n

/** Fixed addresses so the order of rungs in the view is the order they are listed here. */
const addresses = Array.from(
  { length: 5 },
  (_, i) => Keypair.fromSeed(new Uint8Array(32).fill(i + 1)).publicKey,
)
const at = (i: number): PublicKey => {
  const address = addresses[i]
  if (!address) throw new Error(`no address ${i}`)
  return address
}

const epoch = (termDays: bigint): Epoch => ({
  market: MARKET,
  maturityTs: OPENED + termDays * DAY,
  rateBps: 480,
  createdBy: OWNER,
  createdAt: OPENED,
  totalDeposited: 0n,
  totalPromised: 0n,
  depositSeconds: 0n,
  redeemed: 0n,
  status: { kind: 'active' },
  bump: 255,
})

const rung = (status: RungStatus): Rung => ({
  ladder: MARKET,
  epoch: MARKET,
  index: 0,
  deposited: 249_375_000_000n,
  promised: PROMISED,
  feePaid: 625_000_000n,
  status,
  bump: 255,
})

const viewOf = (...entries: { termDays: bigint; status: RungStatus }[]): LadderView => ({
  address: MARKET,
  ladder: {
    owner: OWNER,
    market: MARKET,
    seed: 0n,
    rungCount: entries.length,
    rollPolicy: 'roll',
    createdAt: OPENED,
    bump: 255,
  },
  rungs: entries.map((entry, i) => ({
    address: at(i),
    rung: rung(entry.status),
    epoch: epoch(entry.termDays),
  })),
})

const redeemed = (rungAddress: PublicKey, closedAt: bigint): RungClosure => ({
  kind: 'redeemed',
  ladder: MARKET,
  rung: rungAddress,
  epoch: MARKET,
  destination: ACCOUNT,
  promised: PROMISED,
  amount: PROMISED,
  withDeficit: false,
  at: closedAt,
})

const lookups =
  (table: Record<string, ClosureLookup>) =>
  (address: string): ClosureLookup =>
    table[address] ?? { kind: 'missing', reason: 'not in the table' }

describe('toHistoryRows', () => {
  it('leaves active rungs out and keeps every closed one', () => {
    const view = viewOf(
      { termDays: 30n, status: { kind: 'redeemed', amount: PROMISED } },
      { termDays: 90n, status: { kind: 'active' } },
    )

    const rows = toHistoryRows(view, lookups({}), 6)

    expect(rows.map((row) => row.rung)).toEqual([1])
  })

  it('takes the time and the account from the event, the amounts from the account', () => {
    const view = viewOf({ termDays: 30n, status: { kind: 'redeemed', amount: PROMISED } })
    const closedAt = OPENED + 30n * DAY + 125n

    const [row] = toHistoryRows(
      view,
      lookups({
        [at(0).toBase58()]: {
          kind: 'found',
          closure: redeemed(at(0), closedAt),
          signature: 'sig-redeem',
        },
      }),
      6,
    )

    expect(row).toMatchObject({
      outcome: 'Redeemed',
      promised: '250,358.83…',
      paid: '250,358.83…',
      shortfall: null,
      when: { kind: 'known', text: '2027-02-14 08:02 UTC' },
      where: { kind: 'known', text: "Owner's account CktR…Ezy8", title: ACCOUNT.toBase58() },
      signature: 'sig-redeem',
    })
  })

  it('keeps a redemption whose event is missing, with the shortfall and the reason', () => {
    const view = viewOf({
      termDays: 30n,
      status: { kind: 'redeemedWithDeficit', amount: 250_000_000_000n, promised: PROMISED },
    })

    const [row] = toHistoryRows(
      view,
      lookups({
        [at(0).toBase58()]: { kind: 'missing', reason: 'the node truncated the transaction logs' },
      }),
      6,
    )

    expect(row).toMatchObject({
      outcome: 'Redeemed with deficit',
      paid: '250,000.00',
      shortfall: '358.83…',
      when: { kind: 'missing', reason: 'the node truncated the transaction logs' },
      where: { kind: 'missing', reason: 'the node truncated the transaction logs' },
      signature: null,
    })
  })

  it('names the new rung of a roll from the account even without the event', () => {
    const view = viewOf(
      {
        termDays: 30n,
        status: {
          kind: 'rolledWithDeficit',
          amount: 250_000_000_000n,
          promised: PROMISED,
          into: at(1),
        },
      },
      { termDays: 365n, status: { kind: 'active' } },
    )

    const [row] = toHistoryRows(view, lookups({}), 6)

    expect(row?.outcome).toBe('Rolled with deficit')
    expect(row?.where).toEqual({
      kind: 'known',
      text: `Rolled into rung #2 · ${at(1).toBase58().slice(0, 4)}…${at(1).toBase58().slice(-4)}`,
      title: at(1).toBase58(),
    })
    expect(row?.when).toEqual({ kind: 'missing', reason: 'not in the table' })
  })

  it('puts the latest closure first, and a rung without an event by its maturity', () => {
    const view = viewOf(
      { termDays: 30n, status: { kind: 'redeemed', amount: PROMISED } },
      { termDays: 60n, status: { kind: 'redeemed', amount: PROMISED } },
      { termDays: 90n, status: { kind: 'redeemed', amount: PROMISED } },
    )

    const rows = toHistoryRows(
      view,
      lookups({
        // Rung 1 closed late — after rung 3 matured.
        [at(0).toBase58()]: {
          kind: 'found',
          closure: redeemed(at(0), OPENED + 100n * DAY),
          signature: 'late',
        },
        [at(1).toBase58()]: {
          kind: 'found',
          closure: redeemed(at(1), OPENED + 61n * DAY),
          signature: 'on-time',
        },
      }),
      6,
    )

    expect(rows.map((row) => row.rung)).toEqual([1, 3, 2])
  })
})
