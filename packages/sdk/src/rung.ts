/**
 * Closing a rung: the owner redeems it, or the crank rolls it into a new one.
 *
 * Both instructions address the rung by its number in the ladder, as its seeds do. The
 * epoch is passed as read from the rung (`Rung.epoch`), not re-derived from a date: the
 * program binds the two with `has_one`, and a wrong pair is refused before any funds move.
 */

import { BorshInstructionCoder, type Idl, utils } from '@coral-xyz/anchor'
import { type PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { PROGRAM_ID } from './accounts.js'
import idl from './idl/runway_ladder.json' with { type: 'json' }
import { bufferVaultAddress, rungAddress, vaultAddress } from './pda.js'

const coder = new BorshInstructionCoder(idl as Idl)

export type RedeemRungParams = {
  /** The ladder owner — the only signer the program accepts (FR-012). */
  readonly owner: PublicKey
  readonly market: PublicKey
  readonly ladder: PublicKey
  /** `Rung.epoch` of the rung being redeemed. */
  readonly epoch: PublicKey
  /** `Rung.index` — the number in the rung's seeds. */
  readonly rungIndex: number
  /** Any token account of the market's mint owned by the ladder owner. */
  readonly destination: PublicKey
  readonly programId?: PublicKey
}

export function buildRedeemRung(params: RedeemRungParams): TransactionInstruction {
  const programId = params.programId ?? PROGRAM_ID

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.owner, isSigner: true, isWritable: false },
      { pubkey: params.market, isSigner: false, isWritable: false },
      { pubkey: params.ladder, isSigner: false, isWritable: false },
      { pubkey: params.epoch, isSigner: false, isWritable: true },
      {
        pubkey: rungAddress(programId, params.ladder, params.rungIndex),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: vaultAddress(programId, params.market), isSigner: false, isWritable: true },
      { pubkey: params.destination, isSigner: false, isWritable: true },
      { pubkey: utils.token.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: coder.encode('redeem_rung', {}),
  })
}

export type RollRungParams = {
  /** Whoever cranks: pays the new rung's rent and the fee, moves no funds of their own. */
  readonly payer: PublicKey
  readonly market: PublicKey
  readonly ladder: PublicKey
  /** `Rung.epoch` of the rung being rolled. */
  readonly epoch: PublicKey
  readonly rungIndex: number
  /** The market's furthest epoch (`Market.latest_maturity`) — the only target the program takes. */
  readonly target: PublicKey
  /**
   * The ladder's `rungCount` as read before sending: the new rung takes this number. A deposit
   * landing in between makes the address stale, and the program refuses the roll.
   */
  readonly newRungIndex: number
  readonly programId?: PublicKey
}

/**
 * Rolling a matured rung (FR-013). There is no destination parameter: the new rung goes into
 * the same ladder by construction, which is what makes the crank unable to divert funds.
 */
export function buildRollRung(params: RollRungParams): TransactionInstruction {
  const programId = params.programId ?? PROGRAM_ID

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.market, isSigner: false, isWritable: false },
      { pubkey: params.ladder, isSigner: false, isWritable: true },
      { pubkey: params.epoch, isSigner: false, isWritable: true },
      {
        pubkey: rungAddress(programId, params.ladder, params.rungIndex),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: params.target, isSigner: false, isWritable: true },
      {
        pubkey: rungAddress(programId, params.ladder, params.newRungIndex),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: vaultAddress(programId, params.market), isSigner: false, isWritable: true },
      { pubkey: bufferVaultAddress(programId, params.market), isSigner: false, isWritable: true },
      { pubkey: utils.token.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: coder.encode('roll_rung', {}),
  })
}
