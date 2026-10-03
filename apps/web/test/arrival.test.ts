import type {
  Epoch,
  EpochStatus,
  Rung,
  RungStatus,
  RungView,
  SettledStatus,
} from '@runway-ladder/sdk'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  arrivalOf,
  epochsToPreview,
  expectedOf,
  isShort,
  NO_PREVIEWS,
  type SettlementPreview,
} from '../src/lib/arrival'

const KEY = new PublicKey('77B3e5ybjnHjqPXEYgDp2eFHN3RAMGywUM1QWkspD3dH')
const EPOCH_A = new PublicKey('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8')
const EPOCH_B = new PublicKey('QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF')
const NOW = 1_800_000_000n

/** One rung of 100 in an epoch that promised 300 in total — so the ratio, not the sum, decides. */
const entryOf = ({
  rung = { kind: 'active' },
  epoch = { kind: 'active' },
  maturityTs = NOW - 60n,
  address = EPOCH_A,
}: {
  rung?: RungStatus
  epoch?: EpochStatus
  maturityTs?: bigint
  address?: PublicKey
} = {}): RungView => ({
  address: KEY,
  rung: {
    ladder: KEY,
    epoch: address,
    index: 0,
    deposited: 99_000_000n,
    promised: 100_000_000n,
    feePaid: 1_000_000n,
    status: rung,
    bump: 255,
  } satisfies Rung,
  epoch: {
    market: KEY,
    maturityTs,
    rateBps: 900,
    createdBy: KEY,
    createdAt: maturityTs - 86_400n,
    totalDeposited: 297_000_000n,
    totalPromised: 300_000_000n,
    depositSeconds: 0n,
    redeemed: 0n,
    status: epoch,
    bump: 254,
  } satisfies Epoch,
})

const SHORT: SettledStatus = {
  kind: 'settledWithDeficit',
  paid: 240_000_000n,
  deficit: 60_000_000n,
}

const previewsOf = (address: PublicKey, preview: SettlementPreview) =>
  new Map([[address.toBase58(), preview]])

describe('arrivalOf', () => {
  /** The case the dashboard used to miss: the rung is still active, the epoch already short. */
  it('an epoch settled short pays the open rung at the epoch ratio', () => {
    const arrival = arrivalOf(entryOf({ epoch: SHORT }), NO_PREVIEWS)

    expect(arrival).toEqual({ kind: 'settled', amount: 80_000_000n, promised: 100_000_000n })
    expect(arrival && isShort(arrival)).toBe(true)
  })

  it('an epoch settled at par pays the promise, and is not short', () => {
    const arrival = arrivalOf(
      entryOf({ epoch: { kind: 'settled', paid: 300_000_000n } }),
      NO_PREVIEWS,
    )

    expect(arrival).toEqual({ kind: 'settled', amount: 100_000_000n, promised: 100_000_000n })
    expect(arrival && isShort(arrival)).toBe(false)
  })

  it('an unsettled epoch takes the amount from the preview of its own settlement', () => {
    const arrival = arrivalOf(entryOf(), previewsOf(EPOCH_A, { kind: 'previewed', status: SHORT }))

    expect(arrival).toEqual({ kind: 'ifSettledNow', amount: 80_000_000n, promised: 100_000_000n })
  })

  /** A preview belongs to one epoch: another epoch's shortfall must not land on this rung. */
  it('ignores the preview of another epoch', () => {
    const arrival = arrivalOf(entryOf(), previewsOf(EPOCH_B, { kind: 'previewed', status: SHORT }))

    expect(arrival).toEqual({ kind: 'promise', promised: 100_000_000n })
  })

  it('a failed preview leaves the promise and carries the reason', () => {
    const arrival = arrivalOf(entryOf(), previewsOf(EPOCH_A, { kind: 'failed', reason: 'down' }))

    expect(arrival).toEqual({ kind: 'promise', promised: 100_000_000n, reason: 'down' })
    expect(arrival && expectedOf(arrival)).toBe(100_000_000n)
  })

  it('a closed rung has no arrival — its status already says what it paid', () => {
    expect(
      arrivalOf(
        entryOf({ rung: { kind: 'redeemed', amount: 100_000_000n }, epoch: SHORT }),
        NO_PREVIEWS,
      ),
    ).toBeNull()
  })
})

describe('epochsToPreview', () => {
  it('asks once per matured, unsettled epoch of an open rung', () => {
    const due = epochsToPreview(
      [
        entryOf({ address: EPOCH_A }),
        // The same epoch twice is one simulation, not two.
        entryOf({ address: EPOCH_A }),
        // Settled already: the epoch says its amount itself.
        entryOf({ address: EPOCH_B, epoch: SHORT }),
        // Before maturity: the program would refuse to settle it.
        entryOf({ address: EPOCH_B, maturityTs: NOW + 1n }),
        // Closed: nothing is coming from it.
        entryOf({ address: EPOCH_B, rung: { kind: 'redeemed', amount: 1n } }),
      ],
      NOW,
    )

    expect(due).toEqual([{ key: EPOCH_A.toBase58(), maturityTs: NOW - 60n }])
  })

  it('opens exactly at the maturity second, as the program does', () => {
    expect(epochsToPreview([entryOf({ maturityTs: NOW })], NOW)).toHaveLength(1)
    expect(epochsToPreview([entryOf({ maturityTs: NOW + 1n })], NOW)).toHaveLength(0)
  })
})
