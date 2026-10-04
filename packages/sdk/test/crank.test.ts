import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { utils } from '@coral-xyz/anchor'
import { type AccountInfo, type GetProgramAccountsConfig, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ID } from '../src/accounts.js'
import {
  type CrankReader,
  fetchActiveRungs,
  fetchRollLadders,
  LADDER_MARKET_OFFSET,
  LADDER_ROLL_POLICY_OFFSET,
  RUNG_LADDER_OFFSET,
  RUNG_STATUS_OFFSET,
} from '../src/crank.js'

const accounts = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/accounts.json', import.meta.url)), 'utf8'),
) as {
  ladder: { base64: string; market: string; roll_policy: string }
  rung: { base64: string; ladder: string; index: number }
  rung_rolled_with_deficit: { base64: string }
}

const ladderData = Buffer.from(accounts.ladder.base64, 'base64')
const rungData = Buffer.from(accounts.rung.base64, 'base64')
const market = new PublicKey(accounts.ladder.market)
const ladder = new PublicKey(accounts.rung.ladder)

const info = (data: Buffer): AccountInfo<Buffer> => ({
  data,
  executable: false,
  lamports: 1,
  owner: PROGRAM_ID,
  rentEpoch: 0,
})

/**
 * The fixture rung re-tagged `Active` with another number. `Active` carries no payload, so the
 * bump follows the tag directly and the rest of the allocated space is zeros — exactly how the
 * program leaves a rung it has just issued.
 */
function activeRung(index: number): Buffer {
  const data = Buffer.alloc(rungData.length)
  rungData.copy(data, 0, 0, RUNG_STATUS_OFFSET)
  data.writeUInt32LE(index, RUNG_STATUS_OFFSET - 28)
  data[RUNG_STATUS_OFFSET] = 0
  data[RUNG_STATUS_OFFSET + 1] = 254

  return data
}

/** A node that answers with whatever it is given and remembers what it was asked. */
function readerOf(answer: Buffer[]): { reader: CrankReader; asked: GetProgramAccountsConfig[] } {
  const asked: GetProgramAccountsConfig[] = []
  const reader = {
    getProgramAccounts: async (_program: PublicKey, config: GetProgramAccountsConfig) => {
      asked.push(config)
      return answer.map((data) => ({ pubkey: PublicKey.unique(), account: info(data) }))
    },
  } as unknown as CrankReader

  return { reader, asked }
}

const memcmpOf = (config: GetProgramAccountsConfig | undefined) =>
  (config?.filters ?? []).flatMap((f) => ('memcmp' in f ? [f.memcmp] : []))

describe('account offsets', () => {
  // The offsets are checked against bytes encoded outside both implementations: a test
  // against our own encoder would agree with a layout mistake made in both places.
  it('finds the market and the roll policy of the reference ladder', () => {
    expect(
      new PublicKey(ladderData.subarray(LADDER_MARKET_OFFSET, LADDER_MARKET_OFFSET + 32)),
    ).toEqual(market)
    expect(accounts.ladder.roll_policy).toBe('roll')
    expect(ladderData[LADDER_ROLL_POLICY_OFFSET]).toBe(1)
  })

  it('finds the ladder and the status tag of the reference rungs', () => {
    expect(new PublicKey(rungData.subarray(RUNG_LADDER_OFFSET, RUNG_LADDER_OFFSET + 32))).toEqual(
      ladder,
    )
    // `RedeemedWithDeficit` and `RolledWithDeficit` are the third and the sixth variant.
    expect(rungData[RUNG_STATUS_OFFSET]).toBe(2)
    expect(
      Buffer.from(accounts.rung_rolled_with_deficit.base64, 'base64')[RUNG_STATUS_OFFSET],
    ).toBe(5)
  })
})

describe('fetchRollLadders', () => {
  it('asks for the market and policy=Roll inside the account', async () => {
    const { reader, asked } = readerOf([ladderData])
    const found = await fetchRollLadders(reader, market)

    expect(found).toHaveLength(1)
    expect(found[0]?.ladder.rollPolicy).toBe('roll')
    const filters = memcmpOf(asked[0])
    expect(filters).toContainEqual({ offset: LADDER_MARKET_OFFSET, bytes: market.toBase58() })
    expect(filters).toContainEqual({
      offset: LADDER_ROLL_POLICY_OFFSET,
      bytes: utils.bytes.bs58.encode([1]),
    })
  })

  it('drops what the node returned outside the filter', async () => {
    // The node is not trusted: a ladder of another market or with the policy off would be
    // a roll the program refuses — or, worse, one that rolls in the wrong market.
    const policyOff = Buffer.from(ladderData)
    policyOff[LADDER_ROLL_POLICY_OFFSET] = 0
    const { reader } = readerOf([policyOff])

    expect(await fetchRollLadders(reader, market)).toEqual([])
    expect(await fetchRollLadders(readerOf([ladderData]).reader, PublicKey.unique())).toEqual([])
  })
})

describe('fetchActiveRungs', () => {
  it('asks for the ladder and the Active tag inside the account', async () => {
    const { reader, asked } = readerOf([activeRung(3)])
    const found = await fetchActiveRungs(reader, ladder)

    expect(found.map((r) => r.rung.index)).toEqual([3])
    const filters = memcmpOf(asked[0])
    expect(filters).toContainEqual({ offset: RUNG_LADDER_OFFSET, bytes: ladder.toBase58() })
    expect(filters).toContainEqual({
      offset: RUNG_STATUS_OFFSET,
      bytes: utils.bytes.bs58.encode([0]),
    })
  })

  it('orders rungs by number and drops closed ones the node let through', async () => {
    const { reader } = readerOf([activeRung(5), rungData, activeRung(2)])

    expect((await fetchActiveRungs(reader, ladder)).map((r) => r.rung.index)).toEqual([2, 5])
  })
})
