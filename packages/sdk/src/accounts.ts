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
    min_rung_amount: u64,
    bump,
  })
  .transform((m) => ({
    authority: m.authority,
    assetMint: m.asset_mint,
    vault: m.vault,
    bufferVault: m.buffer_vault,
    source: { kind: 'deterministic' as const, rateBps: m.source.Deterministic.rate_bps },
    feeBps: m.fee_bps,
    minRungAmount: m.min_rung_amount,
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

/**
 * Enum variants arrive from the decoder as named in Rust. A string goes outward:
 * the dashboard should not have to parse the `{ Roll: {} }` shape to understand the policy.
 */
const rollPolicySchema = z
  .union([z.object({ None: z.object({}) }), z.object({ Roll: z.object({}) })])
  .transform((p) => ('Roll' in p ? ('roll' as const) : ('none' as const)))

/**
 * The rung state stays a tagged union in TypeScript too. A flat shape
 * with `status: 'redeemed'` and an optional amount next to it would make
 * "redeemed without an amount" representable — exactly what the onchain type lacks (FR-011a).
 */
const rungStatusSchema = z
  .union([
    z.object({ Active: z.object({}) }),
    z.object({ Redeemed: z.object({ amount: u64 }) }),
    z.object({ RedeemedWithDeficit: z.object({ amount: u64, promised: u64 }) }),
    z.object({ Exited: z.object({ amount: u64 }) }),
  ])
  .transform((s) => {
    if ('Redeemed' in s) return { kind: 'redeemed' as const, amount: s.Redeemed.amount }
    if ('RedeemedWithDeficit' in s) {
      return {
        kind: 'redeemedWithDeficit' as const,
        amount: s.RedeemedWithDeficit.amount,
        promised: s.RedeemedWithDeficit.promised,
      }
    }
    if ('Exited' in s) return { kind: 'exited' as const, amount: s.Exited.amount }

    return { kind: 'active' as const }
  })

const ladderSchema = z
  .object({
    owner: publicKey,
    market: publicKey,
    seed: u64,
    rung_count: z.number().int().min(0),
    roll_policy: rollPolicySchema,
    created_at: u64,
    bump,
  })
  .transform((l) => ({
    owner: l.owner,
    market: l.market,
    seed: l.seed,
    rungCount: l.rung_count,
    rollPolicy: l.roll_policy,
    createdAt: l.created_at,
    bump: l.bump,
  }))

const rungSchema = z
  .object({
    ladder: publicKey,
    epoch: publicKey,
    deposited: u64,
    promised: u64,
    fee_paid: u64,
    status: rungStatusSchema,
    bump,
  })
  .transform((r) => ({
    ladder: r.ladder,
    epoch: r.epoch,
    deposited: r.deposited,
    promised: r.promised,
    feePaid: r.fee_paid,
    status: r.status,
    bump: r.bump,
  }))

export type Market = z.output<typeof marketSchema>
export type Epoch = z.output<typeof epochSchema>
export type Ladder = z.output<typeof ladderSchema>
export type Rung = z.output<typeof rungSchema>
export type RungStatus = Rung['status']
export type RollPolicy = Ladder['rollPolicy']

export function decodeMarket(data: Buffer): Market {
  return marketSchema.parse(coder.decode('Market', data))
}

export function decodeEpoch(data: Buffer): Epoch {
  return epochSchema.parse(coder.decode('Epoch', data))
}

export function decodeLadder(data: Buffer): Ladder {
  return ladderSchema.parse(coder.decode('Ladder', data))
}

/**
 * `Rung` gets into the IDL through a separate build step (`scripts/idl-rung.py`) — rungs
 * are created from `remaining_accounts`, and Anchor does not see them there by itself. For this
 * decoder it makes no difference: the layout still comes from Rust.
 */
export function decodeRung(data: Buffer): Rung {
  return rungSchema.parse(coder.decode('Rung', data))
}

/**
 * The account discriminator — what `getProgramAccounts` uses to pick out its own.
 * Taken from the IDL rather than recomputed: it is the same eight bytes the
 * program wrote, and computing it a second time would mean having a second answer.
 */
export function accountDiscriminator(name: 'Market' | 'Epoch' | 'Ladder' | 'Rung'): Buffer {
  const account = idl.accounts.find((a) => a.name === name)
  if (!account) {
    throw new Error(`${name} is not in the IDL — the build did not splice the fragment in`)
  }

  return Buffer.from(account.discriminator)
}

/** `Rung` gets into the IDL through a separate build step — see `decodeRung`. */
export function rungDiscriminator(): Buffer {
  return accountDiscriminator('Rung')
}
