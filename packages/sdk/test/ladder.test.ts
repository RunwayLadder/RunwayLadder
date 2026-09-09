import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor'
import {
  type AccountInfo,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ID } from '../src/accounts.js'
import idl from '../src/idl/treasury_runway.json' with { type: 'json' }
import {
  buildLadderDeposit,
  buildLadderSetup,
  buildOpenLadder,
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

describe('buildOpenLadder', () => {
  const open = buildOpenLadder({ owner, market, seed, rollPolicy: 'none' })

  it('puts the accounts in the order the program declares them', () => {
    // The order in `OpenLadder<'info>`: owner, market, ladder, system program.
    expect(open.keys.map((k) => k.pubkey.toBase58())).toEqual([
      owner.toBase58(),
      market.toBase58(),
      ladderAddress(PROGRAM_ID, owner, seed).toBase58(),
      '11111111111111111111111111111111',
    ])
  })

  it('signs with the owner and with nobody else', () => {
    // The owner is part of the ladder seeds, so a foreign signature does not open a ladder at
    // someone else's address — and there is no second signer in the instruction at all.
    const signers = open.keys.filter((k) => k.isSigner)
    expect(signers).toHaveLength(1)
    expect(signers[0]?.pubkey.toBase58()).toBe(owner.toBase58())
  })

  it('encodes the seed and the policy the program will read back', () => {
    const decoded = new BorshInstructionCoder(idl as Idl).decode(open.data)
    const args = decoded?.data as { seed: { toString(): string }; roll_policy: unknown }

    expect(decoded?.name).toBe('open_ladder')
    expect(args.seed.toString()).toBe(seed.toString())
    expect(args.roll_policy).toEqual({ None: {} })
  })

  it('carries the rolling policy through as its own variant', () => {
    // `none` and `roll` are different promises to the treasurer (FR-014), and silently
    // collapsing one into the other would mean a roll they never asked for.
    const rolling = buildOpenLadder({ owner, market, seed, rollPolicy: 'roll' })
    const decoded = new BorshInstructionCoder(idl as Idl).decode(rolling.data)
    const args = decoded?.data as { roll_policy: unknown }

    expect(args.roll_policy).toEqual({ Roll: {} })
  })
})

/**
 * The size of the signed transaction the way the network counts it: the serialised
 * message plus one signature (64 bytes and a count byte).
 */
function packetBytes(instructions: TransactionInstruction[]): number {
  const tx = new Transaction()
  tx.add(...instructions)
  tx.feePayer = owner
  tx.recentBlockhash = '11111111111111111111111111111111'

  return tx.compileMessage().serialize().length + 65
}

/** A deposit across `rungs` rungs with dates that do not coincide. */
function setupOf(rungs: number) {
  return {
    ...base,
    rollPolicy: 'none' as const,
    distribution: { kind: 'even', rungs } as const,
    maturities: Array.from({ length: rungs }, (_, i) => 1_800_000_000n + BigInt(i) * 86_400n),
  }
}

describe('buildLadderSetup', () => {
  const instructions = buildLadderSetup({ ...base, rollPolicy: 'roll' })

  it('opens the ladder and funds it in one signature', () => {
    // With two signatures there would be a state between them, "ladder exists, no funds in it":
    // rent paid, dashboard empty. FR-005 promises a single action.
    expect(instructions).toHaveLength(3)
    expect(instructions[0]?.programId.toBase58()).toBe(
      'ComputeBudget111111111111111111111111111111',
    )

    const coder = new BorshInstructionCoder(idl as Idl)
    expect(coder.decode(instructions[1]?.data ?? Buffer.alloc(0))?.name).toBe('open_ladder')
    expect(coder.decode(instructions[2]?.data ?? Buffer.alloc(0))?.name).toBe('ladder_deposit')
  })

  it('points both instructions at the same ladder', () => {
    // The ladder address is not a parameter of either: both derive it from the
    // same owner and number, so there is nothing for them to diverge on.
    const ladder = ladderAddress(PROGRAM_ID, owner, seed).toBase58()
    expect(instructions[1]?.keys[2]?.pubkey.toBase58()).toBe(ladder)
    expect(instructions[2]?.keys[2]?.pubkey.toBase58()).toBe(ladder)
  })

  it('asks for more compute than the deposit alone', () => {
    // The limit applies to the transaction, not the instruction: opening the ladder
    // spends compute from the same ceiling.
    const units = (ix: TransactionInstruction | undefined): number => {
      if (!ix) throw new Error('budget instruction')

      // `SetComputeUnitLimit`: the variant byte, then the limit as u32.
      return ix.data.readUInt32LE(1)
    }

    expect(units(instructions[0])).toBeGreaterThan(units(buildLadderDeposit(base)[0]))
  })

  it('still fits in one packet at the ceiling, priority fee included', () => {
    // The rung ceiling does not drop because of opening the ladder: the four
    // `open_ladder` accounts are already in the deposit message, so the instruction costs
    // only itself. Measured, not estimated — this is the same lock that
    // `deposit_limits.rs` holds on the Rust side.
    const ceiling = buildLadderSetup(setupOf(MAX_RUNGS_PER_DEPOSIT))
    const withPriority = [
      ...ceiling,
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ]

    expect(packetBytes(ceiling)).toBeLessThanOrEqual(1232)
    expect(packetBytes(withPriority)).toBeLessThanOrEqual(1232)
  })

  it('refuses a ladder that would not fit in one signature', () => {
    expect(() => buildLadderSetup(setupOf(MAX_RUNGS_PER_DEPOSIT + 1))).toThrow(/do not fit/)
  })

  it('refuses an empty deposit before it opens anything', () => {
    // A refusal here leaves no open ladder behind: the instruction does not exist
    // until the checks have passed.
    expect(() => buildLadderSetup({ ...base, rollPolicy: 'none', amount: 0n })).toThrow(
      /greater than zero/,
    )
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
