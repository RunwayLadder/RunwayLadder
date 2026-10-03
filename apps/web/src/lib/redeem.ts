/**
 * What the Redeem button will sign — and whether it may sign at all (FR-012).
 *
 * Pure for the same reason as `lib/deposit.ts` and `lib/rollPolicy.ts`: the wallet and the
 * network live in `lib/useRedeem.ts`, while the composition of the transaction is decided
 * here and covered by a test without a wallet.
 */

import {
  associatedTokenAddress,
  buildCreateAssociatedTokenIdempotent,
  buildRedeemRung,
  buildSettleEpoch,
  type LadderView,
  type RungView,
} from '@runway-ladder/sdk'
import type { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { arrivalOf, type SettlementPreviews } from '@/lib/arrival'

/**
 * What the treasurer receives. Exact once the epoch is settled. Before that the settlement in
 * the same signature decides it: `ifSettledNow` is the program's answer for the chain as it is
 * (FR-011a — a shortfall is shown before the signature, not found after it), and
 * `atSettlement` is what is left when that answer could not be had — the promise, and why.
 */
export type RedeemOutcome =
  | { readonly kind: 'exact'; readonly amount: bigint; readonly promised: bigint }
  | { readonly kind: 'ifSettledNow'; readonly amount: bigint; readonly promised: bigint }
  | { readonly kind: 'atSettlement'; readonly promised: bigint; readonly reason?: string }

export type RedeemAction =
  | { readonly kind: 'blocked'; readonly reason: string }
  | {
      readonly kind: 'ready'
      readonly instructions: TransactionInstruction[]
      /** The epoch is settled by this same signature — the button says so. */
      readonly settlesEpoch: boolean
      /** The owner's ATA for the market's mint: the account the deposit left from. */
      readonly destination: PublicKey
      readonly outcome: RedeemOutcome
    }

export type RedeemContext = {
  /** The connected wallet. `null` — not connected. */
  readonly owner: PublicKey | null
  readonly view: LadderView
  /** The rung as read with its epoch — one of `view.rungs`. */
  readonly entry: RungView
  /** `Market.asset_mint`: the program pays only into an account of this mint. */
  readonly assetMint: PublicKey
  readonly nowSeconds: bigint
  readonly programId: PublicKey
  /** What the matured, unsettled epochs would settle for now — see `lib/arrival.ts`. */
  readonly previews: SettlementPreviews
}

const isoDate = (seconds: bigint): string =>
  new Date(Number(seconds) * 1000).toISOString().slice(0, 10)

/**
 * The redemption instructions — or the reason there will be no signature.
 *
 * A matured epoch that nobody has settled yet is settled in the same transaction:
 * `settle_epoch` is permissionless, and without it the treasurer's money would wait on a
 * crank. The destination ATA is created idempotently in front, so a closed account costs
 * rent rather than a failed redemption after signing.
 */
export function redeemAction(context: RedeemContext): RedeemAction {
  const { owner, view, entry, programId } = context
  const { rung, epoch } = entry

  if (!owner) return { kind: 'blocked', reason: 'Connect the owner wallet to redeem this rung.' }
  // The program refuses it too (`NotLadderOwner`), but only after the attempt is paid for.
  if (!owner.equals(view.ladder.owner)) {
    return { kind: 'blocked', reason: 'Only the ladder owner can redeem its rungs.' }
  }
  if (rung.status.kind !== 'active') {
    return { kind: 'blocked', reason: 'This rung is already closed.' }
  }
  if (epoch.maturityTs > context.nowSeconds) {
    return {
      kind: 'blocked',
      reason: `The rung matures on ${isoDate(epoch.maturityTs)} — redemption opens then.`,
    }
  }

  const destination = associatedTokenAddress(owner, context.assetMint)
  const settlesEpoch = epoch.status.kind === 'active'
  const outcome = outcomeOf(entry, context.previews)

  const instructions = [
    buildCreateAssociatedTokenIdempotent({ payer: owner, owner, mint: context.assetMint }),
    ...(settlesEpoch
      ? [buildSettleEpoch({ market: view.ladder.market, maturityTs: epoch.maturityTs, programId })]
      : []),
    buildRedeemRung({
      owner,
      market: view.ladder.market,
      ladder: view.address,
      epoch: rung.epoch,
      rungIndex: rung.index,
      destination,
      programId,
    }),
  ]

  return { kind: 'ready', instructions, settlesEpoch, destination, outcome }
}

/** The rung's arrival in the words of the button. An open rung always has one. */
function outcomeOf(entry: RungView, previews: SettlementPreviews): RedeemOutcome {
  const arrival = arrivalOf(entry, previews) ?? { kind: 'promise', promised: entry.rung.promised }

  switch (arrival.kind) {
    case 'settled':
      return { kind: 'exact', amount: arrival.amount, promised: arrival.promised }
    case 'ifSettledNow':
      return arrival
    case 'promise':
      return arrival.reason === undefined
        ? { kind: 'atSettlement', promised: arrival.promised }
        : { kind: 'atSettlement', promised: arrival.promised, reason: arrival.reason }
  }
}
