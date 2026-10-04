import {
  type EpochView,
  type LadderEntry,
  PROGRAM_ID,
  type RungEntry,
  rungAddress,
} from '@runway-ladder/sdk'
import { PublicKey, SendTransactionError, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { Chain } from '../src/chain.js'
import { type TickReport, tick } from '../src/tick.js'
import {
  epochAt,
  ladderWith,
  marketKey,
  marketWithLatest,
  NOW,
  rungIn,
  settled,
} from './accounts.js'

const keeper = PublicKey.unique()

type Sent =
  | { kind: 'settle'; epoch: string }
  | { kind: 'roll'; rung: string; into: string; target: string }

/**
 * A chain scripted from accounts. It settles what it is asked to settle — so the tick's second
 * read of the epochs sees the change — and refuses the rungs it was told to, with the logs a
 * node returns for an Anchor error.
 */
function scriptedChain(state: {
  epochs: EpochView[]
  latest: bigint
  ladders?: LadderEntry[]
  rungs?: Map<string, RungEntry[]>
  refuse?: Map<string, string>
  balance?: bigint
}): { chain: Chain; sent: Sent[] } {
  const sent: Sent[] = []
  const key = (ix: TransactionInstruction, at: number): string =>
    ix.keys[at]?.pubkey.toBase58() ?? ''

  const chain: Chain = {
    time: async () => NOW,
    balance: async () => state.balance ?? 1_000_000_000n,
    market: async () => marketWithLatest(state.latest),
    epochs: async () => state.epochs.map((e) => ({ ...e, epoch: { ...e.epoch } })),
    rollLadders: async () => state.ladders ?? [],
    activeRungs: async (ladder) => state.rungs?.get(ladder.toBase58()) ?? [],
    send: async (ix) => {
      // `settle_epoch` names six accounts, `roll_rung` eleven (see the SDK builders).
      if (ix.keys.length === 6) {
        const epoch = key(ix, 1)
        sent.push({ kind: 'settle', epoch })
        const entry = state.epochs.find((e) => e.address.toBase58() === epoch)
        if (entry) entry.epoch.status = settled
      } else {
        const rung = key(ix, 4)
        sent.push({ kind: 'roll', rung, into: key(ix, 6), target: key(ix, 5) })
        const code = state.refuse?.get(rung)
        if (code) {
          throw new SendTransactionError({
            action: 'simulate',
            signature: '',
            transactionMessage: 'Transaction simulation failed',
            logs: [
              `Program log: AnchorError thrown in roll.rs:1. Error Code: ${code}. Error Number: 6000.`,
            ],
          })
        }
      }

      return `signature-${sent.length}`
    },
  }

  return { chain, sent }
}

const run = (chain: Chain, minBalanceLamports = 0n): Promise<TickReport> =>
  tick({
    chain,
    keeper,
    market: marketKey,
    programId: PROGRAM_ID,
    minBalanceLamports,
    log: () => {},
  })

describe('tick', () => {
  it('settles a matured epoch and rolls its rung in the same tick', async () => {
    const matured = epochAt(NOW - 10n)
    const ahead = epochAt(NOW + 86_400n)
    const ladder = ladderWith(2)
    const rung = rungIn(matured, 0, ladder.address)
    const { chain, sent } = scriptedChain({
      epochs: [matured, ahead],
      latest: ahead.epoch.maturityTs,
      ladders: [ladder],
      rungs: new Map([[ladder.address.toBase58(), [rung]]]),
    })

    const report = await run(chain)

    expect(sent).toEqual([
      { kind: 'settle', epoch: matured.address.toBase58() },
      {
        kind: 'roll',
        rung: rung.address.toBase58(),
        into: rungAddress(PROGRAM_ID, ladder.address, 2).toBase58(),
        target: ahead.address.toBase58(),
      },
    ])
    expect(report.settled).toHaveLength(1)
    expect(report.rolled).toHaveLength(1)
    expect(report.failed).toEqual([])
  })

  it('numbers new rungs one after another and does not spend a number on a refusal', async () => {
    const done = epochAt(NOW - 10n, settled)
    const ahead = epochAt(NOW + 86_400n)
    const ladder = ladderWith(3)
    const rungs = [0, 1, 2].map((index) => rungIn(done, index, ladder.address))
    const small = rungs[1]?.address.toBase58() ?? ''
    const { chain, sent } = scriptedChain({
      epochs: [done, ahead],
      latest: ahead.epoch.maturityTs,
      ladders: [ladder],
      rungs: new Map([[ladder.address.toBase58(), rungs]]),
      refuse: new Map([[small, 'RungBelowMinimum']]),
    })

    const report = await run(chain)

    const into = (n: number): string => rungAddress(PROGRAM_ID, ladder.address, n).toBase58()
    expect(sent.map((s) => (s.kind === 'roll' ? s.into : s.epoch))).toEqual([
      into(3),
      into(4),
      into(4),
    ])
    expect(report.rolled).toHaveLength(2)
    expect(report.skipped).toEqual([
      expect.stringMatching(/roll rung 1 .* into rung 4: RungBelowMinimum/),
    ])
    expect(report.failed).toEqual([])
  })

  it('rolls nothing when there is no epoch ahead, and says so', async () => {
    const last = epochAt(NOW - 10n, settled)
    const ladder = ladderWith(1)
    const { chain, sent } = scriptedChain({
      epochs: [last],
      latest: last.epoch.maturityTs,
      ladders: [ladder],
      rungs: new Map([[ladder.address.toBase58(), [rungIn(last, 0, ladder.address)]]]),
    })

    const report = await run(chain)

    expect(sent).toEqual([])
    expect(report.skipped).toEqual([expect.stringMatching(/no epoch ahead/)])
    expect(report.failed).toEqual([])
  })

  it('sends nothing below the balance floor, and fails loudly', async () => {
    const { chain, sent } = scriptedChain({
      epochs: [epochAt(NOW - 10n)],
      latest: NOW + 60n,
      balance: 999n,
    })

    const report = await run(chain, 1_000n)

    expect(sent).toEqual([])
    expect(report.failed).toEqual([expect.stringMatching(/999 lamports, below 1000/)])
  })

  it('fails on an unexpected refusal and goes on to the next ladder', async () => {
    const done = epochAt(NOW - 10n, settled)
    const ahead = epochAt(NOW + 86_400n)
    const first = ladderWith(1)
    const second = ladderWith(1)
    const broken = rungIn(done, 0, first.address)
    const { chain, sent } = scriptedChain({
      epochs: [done, ahead],
      latest: ahead.epoch.maturityTs,
      ladders: [first, second],
      rungs: new Map([
        [first.address.toBase58(), [broken]],
        [second.address.toBase58(), [rungIn(done, 0, second.address)]],
      ]),
      refuse: new Map([[broken.address.toBase58(), 'EpochOverpaid']]),
    })

    const report = await run(chain)

    expect(sent).toHaveLength(2)
    expect(report.failed).toEqual([expect.stringMatching(/EpochOverpaid/)])
    expect(report.rolled).toEqual([`${second.address.toBase58()}#0`])
  })
})
