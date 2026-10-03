/**
 * What settling a matured epoch would decide — asked of the program, not recomputed.
 *
 * FR-011a wants a shortfall on screen before the treasurer receives it, and since the Redeem
 * button settles and redeems in one signature, a matured epoch is usually still unsettled when
 * the treasurer looks at it. The amount it settles for is `principal + min(accrued, reserve)`
 * against the buffer: a client-side copy of that would read three balances and repeat the
 * program's rules, and the day the two disagree the screen shows a number the program does not
 * pay. Simulating `settle_epoch` and reading the epoch it leaves behind is the program's own
 * answer, for the state the chain is in at that moment.
 */

import {
  type Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { decodeEpoch, type EpochStatus, PROGRAM_ID } from './accounts.js'
import { buildSettleEpoch, type SettleEpochParams } from './market.js'
import { epochAddress } from './pda.js'

/** Network methods for the preview. Narrower than `Connection` — the test substitutes. */
export type SettlementReader = Pick<Connection, 'simulateTransaction'>

/** An epoch status after settlement: never `active`. */
export type SettledStatus = Exclude<EpochStatus, { kind: 'active' }>

export class SettlementPreviewError extends Error {
  constructor(
    readonly epoch: PublicKey,
    reason: string,
    readonly logs: readonly string[],
  ) {
    super(`settling epoch ${epoch.toBase58()} could not be previewed: ${reason}`)
    this.name = 'SettlementPreviewError'
  }
}

export type PreviewSettlementParams = SettleEpochParams & {
  /**
   * Pays the fee of a transaction that is never sent. The node still checks that it exists and
   * can pay, so it is the connected wallet, not an arbitrary key.
   */
  readonly feePayer: PublicKey
}

/**
 * The status `settle_epoch` would leave on the epoch if it ran now.
 *
 * Unsigned and with the blockhash replaced by the node: nothing here can be sent. A refusal
 * (the epoch not matured, already settled by a crank) comes back as `SettlementPreviewError`
 * with the program's logs, never as a guessed amount.
 */
export async function previewSettlement(
  connection: SettlementReader,
  params: PreviewSettlementParams,
): Promise<SettledStatus> {
  const programId = params.programId ?? PROGRAM_ID
  const epoch = epochAddress(programId, params.market, params.maturityTs)
  const message = new TransactionMessage({
    payerKey: params.feePayer,
    // Replaced by the node (`replaceRecentBlockhash`), so any well-formed hash will do.
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [buildSettleEpoch({ ...params, programId })],
  }).compileToV0Message()

  const { value } = await connection.simulateTransaction(new VersionedTransaction(message), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
    accounts: { encoding: 'base64', addresses: [epoch.toBase58()] },
  })

  const logs = value.logs ?? []
  if (value.err) throw new SettlementPreviewError(epoch, JSON.stringify(value.err), logs)

  const account = value.accounts?.[0]
  if (!account) throw new SettlementPreviewError(epoch, 'the node returned no epoch state', logs)

  const { status } = decodeEpoch(Buffer.from(account.data[0] ?? '', 'base64'))
  // A successful settlement that leaves the epoch active would be a program bug; showing the
  // promise as if it were the outcome would hide it.
  if (status.kind === 'active') {
    throw new SettlementPreviewError(epoch, 'the epoch is still active after settlement', logs)
  }

  return status
}
