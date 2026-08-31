import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor'
import { type AccountInfo, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ID } from '../src/accounts.js'
import idl from '../src/idl/treasury_runway.json' with { type: 'json' }
import {
  buildLadderDeposit,
  fetchLadder,
  type LadderReader,
  MAX_RUNGS_PER_DEPOSIT,
} from '../src/ladder.js'
import { epochAddress, ladderAddress, rungAddress } from '../src/pda.js'

type Fixture = {
  ladder_owner: string
  ladder_seed: number
  ladder: string
  market: string
  epochs: { maturity_ts: number; address: string }[]
  rungs: { maturity_ts: number; address: string }[]
}

const pdas = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/pdas.json', import.meta.url)), 'utf8'),
) as Fixture

const accounts = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/accounts.json', import.meta.url)), 'utf8'),
) as {
  ladder: { base64: string }
  rung: { base64: string; epoch: string }
  epoch: { base64: string; maturity_ts: number }
}

const owner = new PublicKey(pdas.ladder_owner)
const market = new PublicKey(pdas.market)
const seed = BigInt(pdas.ladder_seed)
const sourceToken = new PublicKey('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8')
const maturities = [1_800_000_000n, 1_807_776_000n]

const base = {
  owner,
  market,
  seed,
  sourceToken,
  amount: 1_000_000_000n,
  distribution: { kind: 'even', rungs: 2 } as const,
  maturities,
}

describe('buildLadderDeposit', () => {
  const instructions = buildLadderDeposit(base)
  const deposit = instructions[1]
  if (!deposit) throw new Error('deposit instruction')

  it('asks for the compute budget the deposit actually needs', () => {
    // The deposit exceeds the default 200k by the fifth rung, so the budget
    // request is not an optimisation but a condition of execution (measured in T026).
    const budget = instructions[0]
    expect(budget?.programId.toBase58()).toBe('ComputeBudget111111111111111111111111111111')
    expect(instructions).toHaveLength(2)
  })

  it('puts the epoch and its rung side by side, in the order of the split', () => {
    const ladder = ladderAddress(PROGRAM_ID, owner, seed)
    const tail = deposit.keys.slice(8)

    expect(tail).toHaveLength(maturities.length * 2)
    maturities.forEach((maturity, index) => {
      const epoch = epochAddress(PROGRAM_ID, market, maturity)
      expect(tail[index * 2]?.pubkey.toBase58()).toBe(epoch.toBase58())
      expect(tail[index * 2 + 1]?.pubkey.toBase58()).toBe(
        rungAddress(PROGRAM_ID, ladder, epoch).toBase58(),
      )
    })
  })

  it('signs with the owner and with nobody else', () => {
    // FR-020: the deposit is initiated by the ladder owner. There are no other signatures
    // in it — neither the market operator's nor the crank's.
    const signers = deposit.keys.filter((k) => k.isSigner)
    expect(signers).toHaveLength(1)
    expect(signers[0]?.pubkey.toBase58()).toBe(owner.toBase58())
  })

  it('encodes the arguments the program will read back', () => {
    const decoded = new BorshInstructionCoder(idl as Idl).decode(deposit.data)

    expect(decoded?.name).toBe('ladder_deposit')
    const args = decoded?.data as { amount: { toString(): string }; distribution: unknown }
    expect(args.amount.toString()).toBe('1000000000')
    expect(args.distribution).toEqual({ Even: { rungs: 2 } })
  })

  it('carries weights through in the shape the program expects', () => {
    const [, weighted] = buildLadderDeposit({
      ...base,
      distribution: { kind: 'weighted', weightsBps: [6_000, 4_000] },
    })
    if (!weighted) throw new Error('deposit instruction')

    const decoded = new BorshInstructionCoder(idl as Idl).decode(weighted.data)
    const args = decoded?.data as { distribution: { Weighted: { weights_bps: number[] } } }

    expect(args.distribution.Weighted.weights_bps).toEqual([6_000, 4_000])
  })

  it('refuses a ladder that would not fit in one signature', () => {
    // The limit is visible to the client before signing — otherwise the treasurer would learn
    // about it from a network refusal, having already paid for the attempt.
    const rungs = MAX_RUNGS_PER_DEPOSIT + 1
    expect(() =>
      buildLadderDeposit({
        ...base,
        distribution: { kind: 'even', rungs },
        maturities: Array.from({ length: rungs }, (_, i) => 1_800_000_000n + BigInt(i)),
      }),
    ).toThrow(/do not fit/)
  })

  it('refuses a split whose rungs and maturities disagree', () => {
    expect(() => buildLadderDeposit({ ...base, distribution: { kind: 'even', rungs: 3 } })).toThrow(
      /maturity dates/,
    )
  })

  it('refuses an empty deposit', () => {
    expect(() => buildLadderDeposit({ ...base, amount: 0n })).toThrow(/greater than zero/)
  })
})

/** The network reduced to three answers: reading a ladder needs no more. */
function readerOf(ladder: PublicKey, rungs: { address: PublicKey; data: Buffer }[]): LadderReader {
  const info = (data: Buffer): AccountInfo<Buffer> => ({
    data,
    executable: false,
    lamports: 1,
    owner: PROGRAM_ID,
    rentEpoch: 0,
  })

  return {
    getAccountInfo: async (address: PublicKey) =>
      address.equals(ladder) ? info(Buffer.from(accounts.ladder.base64, 'base64')) : null,
    getProgramAccounts: async () =>
      rungs.map((r) => ({ pubkey: r.address, account: info(r.data) })),
    getMultipleAccountsInfo: async (addresses: PublicKey[]) =>
      addresses.map(() => info(Buffer.from(accounts.epoch.base64, 'base64'))),
  } as unknown as LadderReader
}

describe('fetchLadder', () => {
  const address = ladderAddress(PROGRAM_ID, owner, seed)
  const rungData = Buffer.from(accounts.rung.base64, 'base64')

  /** A rung address from the fixture — by name, not by a random index. */
  const rungAt = (index: number): PublicKey => {
    const entry = pdas.rungs[index]
    if (!entry) throw new Error(`the fixture has no rung ${index}`)

    return new PublicKey(entry.address)
  }

  it('returns the ladder with its rungs and their epochs', async () => {
    const reader = readerOf(address, [{ address: rungAt(0), data: rungData }])
    const view = await fetchLadder(reader, owner, seed)

    expect(view.address.toBase58()).toBe(pdas.ladder)
    expect(view.ladder.owner.toBase58()).toBe(pdas.ladder_owner)
    expect(view.rungs).toHaveLength(1)
    expect(view.rungs[0]?.rung.epoch.toBase58()).toBe(accounts.rung.epoch)
    expect(view.rungs[0]?.epoch.maturityTs).toBe(BigInt(accounts.epoch.maturity_ts))
  })

  it('orders rungs by maturity, not by what the network returned', async () => {
    // `getProgramAccounts` promises no order at all, while a ladder is a sequence
    // of dates: an unordered list would draw the chart backwards.
    const reader = readerOf(address, [
      { address: rungAt(0), data: rungData },
      { address: rungAt(1), data: rungData },
    ])

    let call = 0
    const staggered: LadderReader = {
      ...reader,
      getMultipleAccountsInfo: async () => {
        const later = Buffer.from(accounts.epoch.base64, 'base64')
        later.writeBigInt64LE(BigInt(accounts.epoch.maturity_ts) + 86_400n, 8 + 32)
        const first = Buffer.from(accounts.epoch.base64, 'base64')

        call += 1
        return [
          { data: later, executable: false, lamports: 1, owner: PROGRAM_ID, rentEpoch: 0 },
          { data: first, executable: false, lamports: 1, owner: PROGRAM_ID, rentEpoch: 0 },
        ]
      },
    } as unknown as LadderReader

    const view = await fetchLadder(staggered, owner, seed)

    expect(call).toBe(1)

    const [first, second] = view.rungs
    if (!first || !second) throw new Error('expected two rungs')

    expect(first.epoch.maturityTs).toBeLessThan(second.epoch.maturityTs)
  })

  it('says plainly when the ladder is not there', async () => {
    const empty = { ...readerOf(address, []), getAccountInfo: async () => null } as LadderReader

    await expect(fetchLadder(empty, owner, seed)).rejects.toThrow(/not on the network/)
  })
})
