import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { decodeEpoch, decodeMarket } from '../src/accounts.js'

type Fixture = {
  market: {
    base64: string
    authority: string
    asset_mint: string
    vault: string
    buffer_vault: string
    source_rate_bps: number
    fee_bps: number
    bump: number
  }
  epoch: {
    base64: string
    market: string
    maturity_ts: number
    rate_bps: number
    created_by: string
    created_at: number
    total_deposited: number
    total_promised: number
    bump: number
  }
}

const path = fileURLToPath(new URL('../../../fixtures/accounts.json', import.meta.url))
const fixture = JSON.parse(readFileSync(path, 'utf8')) as Fixture

describe('decodeMarket', () => {
  const market = decodeMarket(Buffer.from(fixture.market.base64, 'base64'))

  it('reads every field of the reference account', () => {
    expect(market.authority.toBase58()).toBe(fixture.market.authority)
    expect(market.assetMint.toBase58()).toBe(fixture.market.asset_mint)
    expect(market.vault.toBase58()).toBe(fixture.market.vault)
    expect(market.bufferVault.toBase58()).toBe(fixture.market.buffer_vault)
    expect(market.feeBps).toBe(fixture.market.fee_bps)
    expect(market.bump).toBe(fixture.market.bump)
  })

  it('flattens the source into a kind and its parameters', () => {
    expect(market.source).toEqual({
      kind: 'deterministic',
      rateBps: fixture.market.source_rate_bps,
    })
  })

  it('refuses data whose discriminator belongs to another account', () => {
    const wrong = Buffer.from(fixture.epoch.base64, 'base64')
    expect(() => decodeMarket(wrong)).toThrow()
  })
})

describe('decodeEpoch', () => {
  const epoch = decodeEpoch(Buffer.from(fixture.epoch.base64, 'base64'))

  it('reads every field of the reference account', () => {
    expect(epoch.market.toBase58()).toBe(fixture.epoch.market)
    expect(epoch.rateBps).toBe(fixture.epoch.rate_bps)
    expect(epoch.createdBy.toBase58()).toBe(fixture.epoch.created_by)
    expect(epoch.bump).toBe(fixture.epoch.bump)
  })

  // Amounts and time are bigint, not number: 2^53 is smaller than u64, and a silent loss
  // of precision here would mean a wrong amount on the treasurer's screen.
  it('returns amounts and timestamps as bigint', () => {
    expect(epoch.maturityTs).toBe(BigInt(fixture.epoch.maturity_ts))
    expect(epoch.createdAt).toBe(BigInt(fixture.epoch.created_at))
    expect(epoch.totalDeposited).toBe(BigInt(fixture.epoch.total_deposited))
    expect(epoch.totalPromised).toBe(BigInt(fixture.epoch.total_promised))
  })
})

describe('the network is not a trusted input', () => {
  it('rejects an account whose fee is outside the representable range', () => {
    const data = Buffer.from(fixture.market.base64, 'base64')
    // fee_bps sits after 4×32 bytes of keys, the variant byte and the u16 source rate
    data.writeUInt16LE(10_001, 8 + 32 * 4 + 1 + 2)

    expect(() => decodeMarket(data)).toThrow()
  })

  it('rejects truncated data', () => {
    const short = Buffer.from(fixture.market.base64, 'base64').subarray(0, 40)
    expect(() => decodeMarket(short)).toThrow()
  })

  it('derives no key from an empty buffer', () => {
    expect(() => decodeEpoch(Buffer.alloc(0))).toThrow()
  })
})

describe('PublicKey plumbing', () => {
  it('round-trips the reference authority', () => {
    expect(new PublicKey(fixture.market.authority).toBuffer()).toEqual(Buffer.alloc(32, 1))
  })
})
