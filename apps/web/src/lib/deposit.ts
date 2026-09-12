/**
 * What exactly will be signed — and whether signing is possible at all.
 *
 * The module is pure on purpose: the wallet and the network live in `lib/useDeposit.ts`,
 * while the decision that must be covered by a test stays here — which instructions go
 * out and why signing is impossible right now. Every refusal is spelled out, because the
 * only alternative to a disabled button without explanation is a treasurer who does not know what to expect.
 */

import type { PublicKey, TransactionInstruction } from '@solana/web3.js'
import {
  associatedTokenAddress,
  buildLadderDeposit,
  buildLadderSetup,
  epochAddress,
} from '@treasury-runway/sdk'
import type { Plan } from '@/lib/plan'

/**
 * The market reduced to what affects signing. `unknown` is not "let's wait a
 * little longer": until the mint is read, the account the funds will leave from is unknown,
 * and substituting anything else for it would mean debiting the wrong account.
 */
export type MarketState =
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'read'; readonly address: PublicKey; readonly assetMint: PublicKey }

/**
 * The state of the owner's ladder.
 *
 * `unknown` here for the same reason: both guesses cost the treasurer a signature.
 * Guessing "no ladder" on an open one runs into an occupied address, guessing
 * "ladder exists" on an empty one into an uninitialised account.
 */
export type LadderState =
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'open'; readonly rungEpochs: readonly PublicKey[] }

export type DepositContext = {
  /** The connected wallet. `null` — not connected. */
  readonly owner: PublicKey | null
  readonly market: MarketState
  /**
   * Whether prices were read from the network. This is not about convenience: in the
   * prototype maturity dates are counted from "now", epochs at such addresses do not exist,
   * and the transaction would fail on the very first rung — after signing.
   */
  readonly pricedFromChain: boolean
  readonly ladder: LadderState
  readonly programId: PublicKey
  readonly seed: bigint
  readonly rollPolicy: 'none' | 'roll'
}

export type DepositAction =
  | { readonly kind: 'blocked'; readonly reason: string }
  | {
      readonly kind: 'ready'
      readonly instructions: TransactionInstruction[]
      /** Whether the ladder is opened by this same signature — the button says so. */
      readonly opensLadder: boolean
      /** The account the funds leave from: the owner's ATA for the market's mint. */
      readonly sourceToken: PublicKey
    }

const isoDate = (maturityTs: bigint): string =>
  new Date(Number(maturityTs) * 1000).toISOString().slice(0, 10)

/**
 * Whether one of the deposit's dates is already taken.
 *
 * A rung is addressed by the pair "ladder, epoch", so a second rung of the same
 * ladder in the same epoch cannot exist — there is nowhere for it to go. Onchain this
 * shows up as creating an account that already exists; here — as a date already in the ladder.
 */
function occupiedMaturity(
  plan: Plan,
  market: PublicKey,
  ladder: LadderState,
  programId: PublicKey,
): bigint | null {
  if (ladder.kind !== 'open') return null

  const taken = new Set(ladder.rungEpochs.map((epoch) => epoch.toBase58()))

  for (const rung of plan.rungs) {
    if (taken.has(epochAddress(programId, market, rung.epoch.maturityTs).toBase58())) {
      return rung.epoch.maturityTs
    }
  }

  return null
}

/**
 * The deposit instructions — or the reason there will be no signature.
 *
 * The order of checks is the order in which the treasurer can act on them:
 * first what is fixed by connecting a wallet, then the stand configuration,
 * and only at the end what depends on an already created ladder.
 */
export function depositAction(plan: Plan, context: DepositContext): DepositAction {
  const { owner, market, ladder } = context

  if (!owner) {
    return { kind: 'blocked', reason: 'Connect a wallet to sign the deposit.' }
  }
  if (market.kind === 'absent') {
    return { kind: 'blocked', reason: 'VITE_MARKET is not set — there is no market to deposit in.' }
  }
  if (market.kind === 'unknown') {
    return { kind: 'blocked', reason: market.reason }
  }
  if (!context.pricedFromChain) {
    return {
      kind: 'blocked',
      reason:
        'These are prototype prices. Their maturities do not exist on chain, so nothing can be signed against them.',
    }
  }
  if (ladder.kind === 'unknown') {
    return { kind: 'blocked', reason: ladder.reason }
  }

  const occupied = occupiedMaturity(plan, market.address, ladder, context.programId)
  if (occupied !== null) {
    return {
      kind: 'blocked',
      // The advice "open another ladder" would lead nowhere here: this build has a
      // single ladder number (`FIRST_LADDER_SEED`), and the form does not open a
      // second one. What remains is what the treasurer can actually do.
      reason: `Your ladder already holds a rung maturing on ${isoDate(occupied)}. One ladder holds one rung per maturity — pick a horizon whose dates it does not cover yet.`,
    }
  }

  const sourceToken = associatedTokenAddress(owner, market.assetMint)
  const params = {
    owner,
    market: market.address,
    seed: context.seed,
    sourceToken,
    amount: plan.amount,
    distribution: plan.distribution,
    maturities: plan.rungs.map((rung) => rung.epoch.maturityTs),
    programId: context.programId,
  }

  const opensLadder = ladder.kind === 'absent'

  return {
    kind: 'ready',
    opensLadder,
    sourceToken,
    instructions: opensLadder
      ? buildLadderSetup({ ...params, rollPolicy: context.rollPolicy })
      : buildLadderDeposit(params),
  }
}
