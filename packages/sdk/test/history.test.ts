import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { fetchRungClosure, type HistoryReader } from '../src/history.js'

const read = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../fixtures/events/${name}.json`, import.meta.url)),
      'utf8',
    ),
  ) as { programId: string; rung: string; logs: string[] }

const redeem = read('redeem')
const deposit = read('deposit')
const programId = new PublicKey(redeem.programId)
const rung = new PublicKey(redeem.rung)

type Entry = { signature: string; err: unknown; logs: string[] | null }

/**
 * A node that answers from a table: signatures newest first, as `getSignaturesForAddress`
 * returns them, and `null` for a transaction it no longer serves.
 */
function node(entries: Entry[]): HistoryReader & { asked: string[] } {
  const asked: string[] = []
  const reader = {
    asked,
    getSignaturesForAddress: async (_address: PublicKey, options?: { limit?: number }) =>
      entries.slice(0, options?.limit ?? entries.length).map(({ signature, err }) => ({
        signature,
        err,
        slot: 1,
        blockTime: null,
        memo: null,
      })),
    getTransaction: async (signature: string) => {
      asked.push(signature)
      const entry = entries.find((candidate) => candidate.signature === signature)
      return entry?.logs ? { meta: { logMessages: entry.logs } } : null
    },
  }

  return reader as unknown as HistoryReader & { asked: string[] }
}

describe('fetchRungClosure', () => {
  it('finds the closing transaction among the rung’s two', async () => {
    const reader = node([
      { signature: 'close', err: null, logs: redeem.logs },
      { signature: 'issue', err: null, logs: deposit.logs },
    ])

    const lookup = await fetchRungClosure(reader, rung, programId)

    expect(lookup).toMatchObject({ kind: 'found', signature: 'close' })
    expect(reader.asked).toEqual(['close'])
  })

  it('asks the node for two signatures and no more', async () => {
    let limit: number | undefined
    const reader = node([])
    reader.getSignaturesForAddress = async (_address, options) => {
      limit = options?.limit
      return []
    }

    await fetchRungClosure(reader, rung, programId)

    expect(limit).toBe(2)
  })

  it('skips a failed transaction — it changed nothing', async () => {
    const reader = node([
      { signature: 'failed', err: { InstructionError: [0, 'Custom'] }, logs: redeem.logs },
      { signature: 'close', err: null, logs: redeem.logs },
    ])

    expect(await fetchRungClosure(reader, rung, programId)).toMatchObject({
      kind: 'found',
      signature: 'close',
    })
    expect(reader.asked).toEqual(['close'])
  })

  it('ignores a closure of another rung in the same logs', async () => {
    const other = new PublicKey('So11111111111111111111111111111111111111112')
    const reader = node([{ signature: 'close', err: null, logs: redeem.logs }])

    expect(await fetchRungClosure(reader, other, programId)).toEqual({
      kind: 'missing',
      reason: 'the node holds no closing transaction for this rung',
    })
  })

  it('names a truncated log as the reason', async () => {
    const reader = node([
      { signature: 'close', err: null, logs: [...redeem.logs.slice(0, 2), 'Log truncated'] },
      { signature: 'issue', err: null, logs: deposit.logs },
    ])

    expect(await fetchRungClosure(reader, rung, programId)).toEqual({
      kind: 'missing',
      reason: 'the node truncated the transaction logs',
    })
  })

  it('names a transaction the node no longer serves as the reason', async () => {
    const reader = node([
      { signature: 'close', err: null, logs: null },
      { signature: 'issue', err: null, logs: deposit.logs },
    ])

    expect(await fetchRungClosure(reader, rung, programId)).toEqual({
      kind: 'missing',
      reason: 'the node did not return the transaction',
    })
  })
})
