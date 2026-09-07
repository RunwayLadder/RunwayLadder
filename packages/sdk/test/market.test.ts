import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type AccountInfo, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ID } from '../src/accounts.js'
import {
  fetchEpochs,
  fetchMarket,
  fetchMintDecimals,
  MarketNotFoundError,
  type MarketReader,
} from '../src/market.js'

const accounts = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/accounts.json', import.meta.url)), 'utf8'),
) as {
  market: { base64: string; fee_bps: number; min_rung_amount: number; asset_mint: string }
  epoch: { base64: string; maturity_ts: number; rate_bps: number; created_by: string }
}

const marketAddress = new PublicKey('77B3e5ybjnHjqPXEYgDp2eFHN3RAMGywUM1QWkspD3dH')
const marketData = Buffer.from(accounts.market.base64, 'base64')
const epochData = Buffer.from(accounts.epoch.base64, 'base64')

const info = (data: Buffer): AccountInfo<Buffer> => ({
  data,
  executable: false,
  lamports: 1,
  owner: PROGRAM_ID,
  rentEpoch: 0,
})

/** An epoch with the same content but a different maturity date: offset 8 + 32. */
const epochAt = (maturityTs: number): Buffer => {
  const data = Buffer.from(epochData)
  data.writeBigInt64LE(BigInt(maturityTs), 8 + 32)

  return data
}

const readerOf = (
  account: AccountInfo<Buffer> | null,
  program: { pubkey: PublicKey; account: AccountInfo<Buffer> }[] = [],
): MarketReader =>
  ({
    getAccountInfo: async () => account,
    getProgramAccounts: async () => program,
  }) as unknown as MarketReader

describe('fetchMarket', () => {
  it('returns the parameters that constrain the deposit', async () => {
    const market = await fetchMarket(readerOf(info(marketData)), marketAddress)

    expect(market.feeBps).toBe(accounts.market.fee_bps)
    expect(market.minRungAmount).toBe(BigInt(accounts.market.min_rung_amount))
    expect(market.assetMint.toBase58()).toBe(accounts.market.asset_mint)
  })

  it('a missing market is a separate type, not an error message', async () => {
    await expect(fetchMarket(readerOf(null), marketAddress)).rejects.toBeInstanceOf(
      MarketNotFoundError,
    )
  })
})

describe('fetchEpochs', () => {
  it('returns the rate, the operator and the moment it was set', async () => {
    const epochs = await fetchEpochs(
      readerOf(null, [{ pubkey: marketAddress, account: info(epochData) }]),
      marketAddress,
    )

    expect(epochs).toHaveLength(1)
    expect(epochs[0]?.epoch.rateBps).toBe(accounts.epoch.rate_bps)
    expect(epochs[0]?.epoch.createdBy.toBase58()).toBe(accounts.epoch.created_by)
    expect(epochs[0]?.epoch.createdAt).toBeGreaterThan(0n)
  })

  it('orders by date, not by whatever the network returned', async () => {
    // `getProgramAccounts` promises no order, while the epoch calendar is a sequence
    // of dates: an unordered list would give a ladder with its rungs shuffled.
    const later = new PublicKey('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8')
    const epochs = await fetchEpochs(
      readerOf(null, [
        { pubkey: later, account: info(epochAt(1_900_000_000)) },
        { pubkey: marketAddress, account: info(epochAt(1_800_000_000)) },
      ]),
      marketAddress,
    )

    expect(epochs.map((entry) => entry.epoch.maturityTs)).toEqual([1_800_000_000n, 1_900_000_000n])
  })

  it('an empty market is an empty list, not an error', async () => {
    await expect(fetchEpochs(readerOf(null, []), marketAddress)).resolves.toEqual([])
  })
})

describe('fetchMintDecimals', () => {
  const mint = (decimals: number, size = 82): Buffer => {
    const data = Buffer.alloc(size)
    data[44] = decimals

    return data
  }

  it('reads the decimals from the mint rather than assuming six', async () => {
    await expect(fetchMintDecimals(readerOf(info(mint(9))), marketAddress)).resolves.toBe(9)
    await expect(fetchMintDecimals(readerOf(info(mint(6))), marketAddress)).resolves.toBe(6)
  })

  it('accepts Token-2022, where extensions follow the base 82 bytes', async () => {
    await expect(fetchMintDecimals(readerOf(info(mint(6, 200))), marketAddress)).resolves.toBe(6)
  })

  it('an account of the wrong size is a refusal, not a random byte', async () => {
    await expect(
      fetchMintDecimals(readerOf(info(Buffer.alloc(40))), marketAddress),
    ).rejects.toThrow(/is not a mint/)
  })
})
