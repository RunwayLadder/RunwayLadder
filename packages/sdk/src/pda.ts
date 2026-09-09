import { utils } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'

/**
 * The seeds duplicate those in the program — otherwise the client simply will not find the account.
 * The guard against drift is `fixtures/pdas.json`: the same addresses are checked by
 * the Rust test, and a discrepancy turns one of the two suites red.
 */
const MARKET = Buffer.from('market')
const VAULT = Buffer.from('vault')
const BUFFER = Buffer.from('buffer')
const EPOCH = Buffer.from('epoch')
const LADDER = Buffer.from('ladder')
const RUNG = Buffer.from('rung')

/** The source kind as it goes into the market seeds. Source parameters are not part of the seeds. */
export const SOURCE_SEED = { deterministic: 0 } as const

export type SourceKind = keyof typeof SOURCE_SEED

export function marketAddress(
  programId: PublicKey,
  assetMint: PublicKey,
  source: SourceKind,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [MARKET, assetMint.toBuffer(), Buffer.from([SOURCE_SEED[source]])],
    programId,
  )[0]
}

export function vaultAddress(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT, market.toBuffer()], programId)[0]
}

export function bufferVaultAddress(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([BUFFER, market.toBuffer()], programId)[0]
}

/**
 * The maturity date enters the seeds as little-endian i64 — the same way the program
 * writes `maturity_ts.to_le_bytes()`. The sign matters: a date before 1970 would give a
 * different byte sequence, which is exactly why this is not `BigUint64`.
 */
export function epochAddress(
  programId: PublicKey,
  market: PublicKey,
  maturityTs: bigint,
): PublicKey {
  const seed = Buffer.alloc(8)
  seed.writeBigInt64LE(maturityTs)

  return PublicKey.findProgramAddressSync([EPOCH, market.toBuffer(), seed], programId)[0]
}

/**
 * The owner is part of the ladder seeds, and that, rather than a check in the instruction,
 * divides the address space between treasuries: an address cannot be derived from someone else's key.
 *
 * `seed` is an unsigned `u64`, unlike the maturity date: it is the ladder's sequence
 * number for the owner, not a moment in time.
 */
export function ladderAddress(programId: PublicKey, owner: PublicKey, seed: bigint): PublicKey {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64LE(seed)

  return PublicKey.findProgramAddressSync([LADDER, owner.toBuffer(), bytes], programId)[0]
}

/**
 * A rung is uniquely defined by the pair "ladder, epoch". A consequence visible
 * only from here: one ladder cannot have two rungs in one epoch.
 */
export function rungAddress(programId: PublicKey, ladder: PublicKey, epoch: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([RUNG, ladder.toBuffer(), epoch.toBuffer()], programId)[0]
}

/**
 * The owner's associated token account for the mint.
 *
 * The deposit takes **any** treasury token account: the program checks
 * the mint and the owner (`token::mint`, `token::authority`), not the address. This is only
 * the dashboard's default assumption — wallets show exactly the ATA, and that is
 * what the treasurer will pay from unless they name another account explicitly.
 *
 * The derivation comes from `@coral-xyz/anchor` rather than being rewritten: the same three
 * seeds under the same program, only verified by someone other than us.
 */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return utils.token.associatedAddress({ owner, mint })
}
