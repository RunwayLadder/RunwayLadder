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
