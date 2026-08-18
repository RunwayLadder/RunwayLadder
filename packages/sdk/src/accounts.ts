import { BN, BorshAccountsCoder, type Idl } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import idl from './idl/treasury_runway.json' with { type: 'json' }

/**
 * The IDL is generated from Rust and copied here by the build — so the account layout
 * exists in one place rather than being retyped by hand in TypeScript.
 */
export const PROGRAM_ID = new PublicKey(idl.address)

const coder = new BorshAccountsCoder(idl as Idl)

/**
 * An account from the network is not trusted input: anything at all may sit at a suggested
 * address. The schemas stand exactly on that boundary — after decoding and before
 * a number enters a computation the treasurer will see.
 *
 * The decoder returns fields in snake_case, as in the IDL. camelCase goes outward: the raw
 * shape stays a detail of this file.
 */
const publicKey = z.custom<PublicKey>((v) => v instanceof PublicKey, 'expected a PublicKey')

/** u64 and i64 arrive as BN. From here on — bigint: 2^53 is smaller than u64, and a silent
 *  loss of precision here would mean a wrong amount on the treasurer's screen. */
const u64 = z
  .custom<BN>((v) => BN.isBN(v), 'expected an integer')
  .transform((v) => BigInt(v.toString()))

const bps = z.number().int().min(0).max(10_000)
const rate = z.number().int().min(0)
const bump = z.number().int().min(0).max(255)

const marketSchema = z
  .object({
    authority: publicKey,
    asset_mint: publicKey,
    vault: publicKey,
    buffer_vault: publicKey,
    source: z.object({ Deterministic: z.object({ rate_bps: rate }) }),
    fee_bps: bps,
    bump,
  })
  .transform((m) => ({
    authority: m.authority,
    assetMint: m.asset_mint,
    vault: m.vault,
    bufferVault: m.buffer_vault,
    source: { kind: 'deterministic' as const, rateBps: m.source.Deterministic.rate_bps },
    feeBps: m.fee_bps,
    bump: m.bump,
  }))

const epochSchema = z
  .object({
    market: publicKey,
    maturity_ts: u64,
    rate_bps: rate,
    created_by: publicKey,
    created_at: u64,
    total_deposited: u64,
    total_promised: u64,
    bump,
  })
  .transform((e) => ({
    market: e.market,
    maturityTs: e.maturity_ts,
    rateBps: e.rate_bps,
    createdBy: e.created_by,
    createdAt: e.created_at,
    totalDeposited: e.total_deposited,
    totalPromised: e.total_promised,
    bump: e.bump,
  }))

export type Market = z.output<typeof marketSchema>
export type Epoch = z.output<typeof epochSchema>

export function decodeMarket(data: Buffer): Market {
  return marketSchema.parse(coder.decode('Market', data))
}

export function decodeEpoch(data: Buffer): Epoch {
  return epochSchema.parse(coder.decode('Epoch', data))
}
