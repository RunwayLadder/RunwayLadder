/**
 * The chain as the keeper sees it — every read and the one write it makes.
 *
 * A port rather than a `Connection` handed around: the tick decides what to send from what it
 * reads, and that decision is tested against a scripted chain, without a validator.
 */

import {
  type EpochView,
  fetchActiveRungs,
  fetchEpochs,
  fetchMarket,
  fetchRollLadders,
  type LadderEntry,
  type Market,
  type RungEntry,
} from '@runway-ladder/sdk'
import {
  type Connection,
  type Keypair,
  type PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  sendAndConfirmTransaction,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'

export type Chain = {
  /** `Clock.unix_timestamp` — the time the program checks maturity against. */
  time(): Promise<bigint>
  /** The keeper's own lamports. */
  balance(): Promise<bigint>
  market(): Promise<Market>
  epochs(): Promise<EpochView[]>
  rollLadders(): Promise<LadderEntry[]>
  activeRungs(ladder: PublicKey): Promise<RungEntry[]>
  /** One instruction, signed and paid by the keeper; resolves to the confirmed signature. */
  send(instruction: TransactionInstruction): Promise<string>
}

/** `Clock.unix_timestamp`: after slot, epoch_start_timestamp, epoch and leader_schedule_epoch. */
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32

export function chainOf(
  connection: Connection,
  keeper: Keypair,
  market: PublicKey,
  programId: PublicKey,
): Chain {
  return {
    time: async () => {
      const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)
      if (!clock) throw new Error('the node returned no Clock sysvar')

      return clock.data.readBigInt64LE(CLOCK_UNIX_TIMESTAMP_OFFSET)
    },
    balance: async () => BigInt(await connection.getBalance(keeper.publicKey)),
    market: () => fetchMarket(connection, market),
    epochs: () => fetchEpochs(connection, market, programId),
    rollLadders: () => fetchRollLadders(connection, market, programId),
    activeRungs: (ladder) => fetchActiveRungs(connection, ladder, programId),
    send: (instruction) =>
      sendAndConfirmTransaction(connection, new Transaction().add(instruction), [keeper], {
        commitment: 'confirmed',
      }),
  }
}
