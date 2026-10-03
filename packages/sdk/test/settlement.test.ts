import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor'
import { PublicKey, type VersionedTransaction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ID } from '../src/accounts.js'
import idl from '../src/idl/runway_ladder.json' with { type: 'json' }
import { epochAddress } from '../src/pda.js'
import {
  previewSettlement,
  SettlementPreviewError,
  type SettlementReader,
} from '../src/settlement.js'

const accounts = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/accounts.json', import.meta.url)), 'utf8'),
) as {
  epoch: { base64: string }
  epoch_settled_with_deficit: { base64: string; paid: string; deficit: string }
}

const market = new PublicKey('77B3e5ybjnHjqPXEYgDp2eFHN3RAMGywUM1QWkspD3dH')
const feePayer = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
const maturityTs = 1_800_000_000n
const epoch = epochAddress(PROGRAM_ID, market, maturityTs)

type Simulated = {
  err: unknown
  logs: string[] | null
  accounts?: ({ data: [string, string] } | null)[] | null
}

/** A node that answers one simulation and keeps what it was asked. */
const nodeAnswering = (value: Simulated) => {
  const calls: { transaction: VersionedTransaction; config: unknown }[] = []
  const reader = {
    simulateTransaction: async (transaction: VersionedTransaction, config: unknown) => {
      calls.push({ transaction, config })
      return { context: { slot: 1 }, value }
    },
  } as unknown as SettlementReader

  return { reader, calls }
}

const settledAccount = (base64: string) => ({ data: [base64, 'base64'] as [string, string] })

describe('previewSettlement', () => {
  /** The real account the program left after a short settlement — the numbers are its own. */
  it('returns the status the program leaves on the epoch', async () => {
    const { reader } = nodeAnswering({
      err: null,
      logs: [],
      accounts: [settledAccount(accounts.epoch_settled_with_deficit.base64)],
    })

    const status = await previewSettlement(reader, { market, maturityTs, feePayer })

    expect(status).toEqual({
      kind: 'settledWithDeficit',
      paid: BigInt(accounts.epoch_settled_with_deficit.paid),
      deficit: BigInt(accounts.epoch_settled_with_deficit.deficit),
    })
  })

  /**
   * Nothing in the request may be sendable or signed, and the node is asked for exactly the
   * epoch the instruction settles — otherwise the state read back belongs to another epoch.
   */
  it('simulates one unsigned settle_epoch and asks for that epoch back', async () => {
    const { reader, calls } = nodeAnswering({
      err: null,
      logs: [],
      accounts: [settledAccount(accounts.epoch_settled_with_deficit.base64)],
    })

    await previewSettlement(reader, { market, maturityTs, feePayer })

    const call = calls[0]
    expect(calls).toHaveLength(1)
    expect(call?.config).toMatchObject({
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: 'base64', addresses: [epoch.toBase58()] },
    })

    const message = call?.transaction.message
    expect(message?.staticAccountKeys[0]?.toBase58()).toBe(feePayer.toBase58())
    expect(message?.header.numRequiredSignatures).toBe(1)
    expect(message?.compiledInstructions).toHaveLength(1)

    const data = Buffer.from(message?.compiledInstructions[0]?.data ?? [])
    expect(new BorshInstructionCoder(idl as Idl).decode(data)?.name).toBe('settle_epoch')
  })

  /** A crank that settled first: the refusal and its logs, never the promise as an amount. */
  it('refuses with the program logs when the simulation fails', async () => {
    const logs = [
      'Program log: AnchorError occurred. Error Code: EpochAlreadySettled. Error Number: 6009.',
    ]
    const { reader } = nodeAnswering({
      err: { InstructionError: [0, { Custom: 6009 }] },
      logs,
      accounts: [null],
    })

    const attempt = previewSettlement(reader, { market, maturityTs, feePayer })

    await expect(attempt).rejects.toBeInstanceOf(SettlementPreviewError)
    await expect(attempt).rejects.toMatchObject({ logs, epoch })
  })

  it('refuses when the node returns no epoch state', async () => {
    const { reader } = nodeAnswering({ err: null, logs: [], accounts: [null] })

    await expect(previewSettlement(reader, { market, maturityTs, feePayer })).rejects.toThrow(
      /no epoch state/,
    )
  })

  it('refuses an epoch that is still active after a successful settlement', async () => {
    const { reader } = nodeAnswering({
      err: null,
      logs: [],
      accounts: [settledAccount(accounts.epoch.base64)],
    })

    await expect(previewSettlement(reader, { market, maturityTs, feePayer })).rejects.toThrow(
      /still active/,
    )
  })
})
