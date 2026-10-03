/**
 * The owner's associated token account, created if it is missing.
 *
 * Built by hand rather than taken from `@solana/spl-token`, for the same reason the mint's
 * decimals are read by hand in `market.ts`: one instruction does not justify the dependency
 * tree. The layout is fixed by the Associated Token Account program — six accounts, one byte.
 */

import { utils } from '@coral-xyz/anchor'
import { type PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { associatedTokenAddress } from './pda.js'

/** `CreateIdempotent` in the program's instruction enum (`Create` is 0, `RecoverNested` is 2). */
const CREATE_IDEMPOTENT = 1

export type CreateAssociatedTokenParams = {
  /** Pays the rent if the account has to be created; nothing otherwise. */
  readonly payer: PublicKey
  readonly owner: PublicKey
  readonly mint: PublicKey
}

/**
 * Creates `owner`'s ATA for `mint`, or does nothing when it already exists.
 *
 * Idempotent rather than read-then-create: a read before signing can be stale by the time
 * the transaction lands, and the idempotent form is correct in both cases without one.
 */
export function buildCreateAssociatedTokenIdempotent(
  params: CreateAssociatedTokenParams,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: utils.token.ASSOCIATED_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      {
        pubkey: associatedTokenAddress(params.owner, params.mint),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: utils.token.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([CREATE_IDEMPOTENT]),
  })
}
