/**
 * Signing the deposit: wallet, network and the state of a single transaction.
 *
 * The decision "what we sign and whether we may" stays pure in `lib/deposit.ts` — here
 * there is only assembling state from the network and carrying out the signature. The
 * boundary is drawn so that the one place where the transaction's composition can go
 * wrong is covered by a test without a wallet.
 */

import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { Transaction } from '@solana/web3.js'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { FIRST_LADDER_SEED } from '@/components/NetworkNotice'
import { useLadder, useMarketParams } from '@/lib/chain'
import {
  type DepositAction,
  depositAction,
  type LadderState,
  type MarketState,
} from '@/lib/deposit'
import type { LiveNetwork } from '@/lib/network'
import type { Plan } from '@/lib/plan'

/**
 * Where exactly the transaction is right now. `confirming` separate from `sent` is not
 * decoration: a signed transaction is not yet an executed one, and showing "done" from
 * the moment of signing would mean reporting rungs that may not exist on the network.
 */
export type DepositStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'signing' }
  | { readonly kind: 'confirming'; readonly signature: string }
  | { readonly kind: 'sent'; readonly signature: string; readonly opensLadder: boolean }
  | { readonly kind: 'failed'; readonly message: string }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function useDeposit({
  net,
  plan,
  rollPolicy,
  pricedFromChain,
}: {
  net: LiveNetwork
  plan: Plan | null
  rollPolicy: boolean
  pricedFromChain: boolean
}) {
  const { connection } = useConnection()
  const { publicKey, sendTransaction } = useWallet()
  const marketQuery = useMarketParams()
  const ladderQuery = useLadder(publicKey ?? null, FIRST_LADDER_SEED)
  const queries = useQueryClient()

  const [status, setStatus] = useState<DepositStatus>({ kind: 'idle' })

  const market = useMemo((): MarketState => {
    if (!net.market) return { kind: 'absent' }
    if (marketQuery.isPending) return { kind: 'unknown', reason: 'Reading the market…' }
    if (marketQuery.isError || !marketQuery.data) {
      return {
        kind: 'unknown',
        reason: `The market could not be read: ${message(marketQuery.error)}`,
      }
    }

    return {
      kind: 'read',
      address: net.market,
      assetMint: marketQuery.data.market.assetMint,
    }
  }, [net.market, marketQuery])

  const ladder = useMemo((): LadderState => {
    if (!publicKey) return { kind: 'unknown', reason: 'Connect a wallet to sign the deposit.' }
    if (ladderQuery.isPending) {
      return { kind: 'unknown', reason: 'Reading your ladder from the network…' }
    }
    if (ladderQuery.isError) {
      // Not "assume there is no ladder": an unread ladder may already hold
      // a rung in the same epoch, and signing blind would cost a fee.
      return {
        kind: 'unknown',
        reason: `Your ladder could not be read: ${message(ladderQuery.error)}`,
      }
    }
    if (!ladderQuery.data) return { kind: 'absent' }

    return { kind: 'open', rungEpochs: ladderQuery.data.rungs.map((rung) => rung.rung.epoch) }
  }, [publicKey, ladderQuery])

  const action = useMemo((): DepositAction | null => {
    if (!plan) return null

    return depositAction(plan, {
      owner: publicKey ?? null,
      market,
      pricedFromChain,
      ladder,
      programId: net.programId,
      seed: FIRST_LADDER_SEED,
      rollPolicy: rollPolicy ? 'roll' : 'none',
    })
  }, [plan, publicKey, market, pricedFromChain, ladder, net.programId, rollPolicy])

  const submit = useCallback(async () => {
    if (!publicKey || action?.kind !== 'ready') return

    setStatus({ kind: 'signing' })
    try {
      // The blockhash is taken before signing and the same one goes into the wait: otherwise
      // one transaction would be confirmed while another one expired.
      const latest = await connection.getLatestBlockhash('confirmed')
      const transaction = new Transaction({ feePayer: publicKey, ...latest })
      transaction.add(...action.instructions)

      const signature = await sendTransaction(transaction, connection)
      setStatus({ kind: 'confirming', signature })

      const outcome = await connection.confirmTransaction({ signature, ...latest }, 'confirmed')
      // A confirmed transaction can be a failed one: "arrived" and "worked" are
      // different answers, and showing the first instead of the second would mean promising
      // rungs the program did not create.
      if (outcome.value.err) {
        throw new Error(`the network rejected it: ${JSON.stringify(outcome.value.err)}`)
      }

      setStatus({ kind: 'sent', signature, opensLadder: action.opensLadder })
      await queries.invalidateQueries({ queryKey: ['ladder'] })
    } catch (error) {
      setStatus({ kind: 'failed', message: message(error) })
    }
  }, [publicKey, action, connection, sendTransaction, queries])

  const reset = useCallback(() => setStatus({ kind: 'idle' }), [])

  return { action, status, submit, reset }
}
