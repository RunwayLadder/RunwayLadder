import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { decodeEpoch, decodeLadder, decodeMarket, decodeRung } from '../src/accounts.js'

type Fixture = {
  market: {
    base64: string
    authority: string
    asset_mint: string
    vault: string
    buffer_vault: string
    source_rate_bps: number
    fee_bps: number
    min_rung_amount: number
    bump: number
  }
  ladder: {
    base64: string
    owner: string
    market: string
    seed: number
    rung_count: number
    roll_policy: string
    created_at: number
    bump: number
  }
  rung: {
    base64: string
    ladder: string
    epoch: string
    deposited: number
    promised: number
    fee_paid: number
    status: string
    settled_amount: number
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
    deposit_seconds: string
    status: string
    bump: number
  }
  epoch_settled_with_deficit: {
    base64: string
    total_promised: number
    deposit_seconds: string
    status: string
    paid: string
    deficit: string
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
    // The rung minimum is a u64: on the treasurer's screen it sits next to the deposit
    // amount, and a number here would start to differ from the chain on large assets.
    expect(market.minRungAmount).toBe(BigInt(fixture.market.min_rung_amount))
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

  it('reads deposit_seconds off the reference account', () => {
    expect(epoch.depositSeconds).toBe(BigInt(fixture.epoch.deposit_seconds))
  })

  // The reference value — a thousand USDC over ninety days — still fits in a double, so on its
  // own it proves nothing about the u128 path. This writes a span that does not fit: past 2^53
  // a decoder that went through a number would come back with a neighbouring value, not throw.
  it('reads a deposit_seconds too large for a double without losing a unit', () => {
    // discriminator 8 + market 32 + maturity 8 + rate 2 + operator 32 + created 8 + two u64s.
    const offset = 8 + 32 + 8 + 2 + 32 + 8 + 8 + 8
    const huge = (1n << 70n) + 12_345n

    const data = Buffer.from(fixture.epoch.base64, 'base64')
    data.writeBigUInt64LE(huge & 0xff_ff_ff_ff_ff_ff_ff_ffn, offset)
    data.writeBigUInt64LE(huge >> 64n, offset + 8)

    expect(decodeEpoch(data).depositSeconds).toBe(huge)
    expect(huge).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
  })

  it('reads an epoch that has not been settled as active', () => {
    expect(epoch.status).toEqual({ kind: 'active' })
  })

  // FR-011a on the client side: the amount paid cannot be read without the shortfall
  // coming with it, because they live in the same variant.
  it('carries the shortfall inside the settled variant', () => {
    const settled = decodeEpoch(Buffer.from(fixture.epoch_settled_with_deficit.base64, 'base64'))

    expect(settled.status).toEqual({
      kind: 'settledWithDeficit',
      paid: BigInt(fixture.epoch_settled_with_deficit.paid),
      deficit: BigInt(fixture.epoch_settled_with_deficit.deficit),
    })

    if (settled.status.kind !== 'settledWithDeficit') throw new Error('unreachable')
    expect(settled.status.paid + settled.status.deficit).toBe(settled.totalPromised)
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

describe('decodeLadder', () => {
  const ladder = decodeLadder(Buffer.from(fixture.ladder.base64, 'base64'))

  it('reads every field of the reference account', () => {
    expect(ladder.owner.toBase58()).toBe(fixture.ladder.owner)
    expect(ladder.market.toBase58()).toBe(fixture.ladder.market)
    expect(ladder.seed).toBe(BigInt(fixture.ladder.seed))
    expect(ladder.rungCount).toBe(fixture.ladder.rung_count)
    expect(ladder.createdAt).toBe(BigInt(fixture.ladder.created_at))
    expect(ladder.bump).toBe(fixture.ladder.bump)
  })

  it('flattens the roll policy into a name', () => {
    // The dashboard asks "rolls or not" rather than parsing the `{ Roll: {} }` shape.
    expect(ladder.rollPolicy).toBe(fixture.ladder.roll_policy)
  })
})

describe('decodeRung', () => {
  const rung = decodeRung(Buffer.from(fixture.rung.base64, 'base64'))

  it('reads every field of the reference account', () => {
    expect(rung.ladder.toBase58()).toBe(fixture.rung.ladder)
    expect(rung.epoch.toBase58()).toBe(fixture.rung.epoch)
    expect(rung.deposited).toBe(BigInt(fixture.rung.deposited))
    expect(rung.promised).toBe(BigInt(fixture.rung.promised))
    expect(rung.feePaid).toBe(BigInt(fixture.rung.fee_paid))
    expect(rung.bump).toBe(fixture.rung.bump)
  })

  it('keeps the deficit inside the status, with both numbers', () => {
    // A flat shape with a status string and an amount next to it would make
    // "redeemed without an amount" representable — what the onchain type lacks (FR-011a).
    expect(rung.status.kind).toBe(fixture.rung.status)
    if (rung.status.kind !== 'redeemedWithDeficit') throw new Error('expected a deficit')

    expect(rung.status.amount).toBe(BigInt(fixture.rung.settled_amount))
    expect(rung.status.promised).toBe(BigInt(fixture.rung.promised))
    expect(rung.status.amount).toBeLessThan(rung.status.promised)
  })

  it('reads an account whose data is longer than the value it holds', () => {
    // The account on the network has the full InitSpace size, while the status variant is
    // short. The tail of zeros must stay a tail, not become an error.
    const raw = Buffer.from(fixture.rung.base64, 'base64')
    expect(raw.length).toBeGreaterThan(8 + 32 + 32 + 8 + 8 + 8 + 17 + 1 - 1)
    expect(() => decodeRung(raw)).not.toThrow()
  })
})
