import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor'
import { type AccountInfo, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ID } from '../src/accounts.js'
import idl from '../src/idl/runway_ladder.json' with { type: 'json' }
import {
  buildCreateEpoch,
  buildInitMarket,
  fetchEpochs,
  fetchMarket,
  fetchMintDecimals,
  MarketNotFoundError,
  type MarketReader,
} from '../src/market.js'
import {
  bufferVaultAddress,
  epochAddress,
  marketAddress as marketPda,
  vaultAddress,
} from '../src/pda.js'

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

describe('buildInitMarket', () => {
  const authority = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
  const assetMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  const instruction = buildInitMarket({
    authority,
    assetMint,
    source: { kind: 'deterministic', rateBps: 600 },
    feeBps: 25,
    minRungAmount: 10_000_000n,
  })

  it('derives the market and both vaults instead of taking them on trust', () => {
    // The vault and buffer addresses are not parameters: supplied from outside they would be
    // the same thing as someone else's account in a transfer.
    const market = marketPda(PROGRAM_ID, assetMint, 'deterministic')

    expect(instruction.keys[2]?.pubkey.toBase58()).toBe(market.toBase58())
    expect(instruction.keys[3]?.pubkey.toBase58()).toBe(vaultAddress(PROGRAM_ID, market).toBase58())
    expect(instruction.keys[4]?.pubkey.toBase58()).toBe(
      bufferVaultAddress(PROGRAM_ID, market).toBase58(),
    )
  })

  it('encodes the arguments the program will read back', () => {
    const decoded = new BorshInstructionCoder(idl as Idl).decode(instruction.data)
    const args = decoded?.data as {
      source: unknown
      fee_bps: number
      min_rung_amount: { toString(): string }
    }

    expect(decoded?.name).toBe('init_market')
    expect(args.source).toEqual({ Deterministic: { rate_bps: 600 } })
    expect(args.fee_bps).toBe(25)
    // The minimum is a u64: through `number` it would lose precision on a large mint.
    expect(args.min_rung_amount.toString()).toBe('10000000')
  })
})

describe('buildCreateEpoch', () => {
  const authority = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
  const market = new PublicKey('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8')

  it('derives the epoch from its maturity, and signs as the operator', () => {
    const maturityTs = 1_800_000_000n
    const instruction = buildCreateEpoch({ authority, market, maturityTs, rateBps: 620 })

    expect(instruction.keys[2]?.pubkey.toBase58()).toBe(
      epochAddress(PROGRAM_ID, market, maturityTs).toBase58(),
    )
    expect(instruction.keys.filter((key) => key.isSigner)).toHaveLength(1)
    expect(instruction.keys[0]?.pubkey.toBase58()).toBe(authority.toBase58())

    const decoded = new BorshInstructionCoder(idl as Idl).decode(instruction.data)
    const args = decoded?.data as { maturity_ts: { toString(): string }; rate_bps: number }

    expect(decoded?.name).toBe('create_epoch')
    expect(args.maturity_ts.toString()).toBe('1800000000')
    expect(args.rate_bps).toBe(620)
  })

  it('keeps a maturity before 1970 signed', () => {
    // The same sign as in the seeds: as unsigned the date would give different bytes, and the
    // epoch would land at an address the client will never find.
    const maturityTs = -86_400n
    const instruction = buildCreateEpoch({ authority, market, maturityTs, rateBps: 100 })

    expect(instruction.keys[2]?.pubkey.toBase58()).toBe(
      epochAddress(PROGRAM_ID, market, maturityTs).toBase58(),
    )
  })
})
