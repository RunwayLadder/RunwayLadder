/**
 * Signing a redemption: wallet, network and the state of one transaction.
 *
 * What is signed is decided in `lib/redeem.ts`; here the transaction is sent, confirmed and
 * followed by a fresh read. The rung page shows the closed state only after that read — the
 * status it shows is the one on chain, not the one this hook expects.
 */

import type { LadderView, RungView } from '@runway-ladder/sdk'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { type PublicKey, Transaction } from '@solana/web3.js'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import type { SettlementPreviews } from '@/lib/arrival'
import { liveNetwork } from '@/lib/network'
import { type RedeemAction, redeemAction } from '@/lib/redeem'

export type RedeemStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'signing' }
  | { readonly kind: 'confirming'; readonly signature: string }
  | { readonly kind: 'done'; readonly signature: string }
  | { readonly kind: 'failed'; readonly message: string }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function useRedeem({
  view,
  entry,
  assetMint,
  previews,
}: {
  view: LadderView
  entry: RungView
  assetMint: PublicKey
  previews: SettlementPreviews
}) {
  const { connection } = useConnection()
  const { publicKey, sendTransaction } = useWallet()
  const queries = useQueryClient()

  const [status, setStatus] = useState<RedeemStatus>({ kind: 'idle' })

  // The clock is read on every render, not once at load like the dashboard's: the page
  // re-renders on each refetch, so one left open past the maturity date unlocks on the next
  // read instead of waiting for a reload. Cheap enough not to memoise.
  const action: RedeemAction | null = liveNetwork
    ? redeemAction({
        owner: publicKey ?? null,
        view,
        entry,
        assetMint,
        nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
        programId: liveNetwork.programId,
        previews,
      })
    : null

  const redeem = useCallback(async () => {
    if (!publicKey || action?.kind !== 'ready') return

    setStatus({ kind: 'signing' })
    try {
      // The same blockhash goes into the transaction and into the wait, as in the deposit.
      const latest = await connection.getLatestBlockhash('confirmed')
      const transaction = new Transaction({ feePayer: publicKey, ...latest })
      transaction.add(...action.instructions)

      const signature = await sendTransaction(transaction, connection)
      setStatus({ kind: 'confirming', signature })

      const outcome = await connection.confirmTransaction({ signature, ...latest }, 'confirmed')
      // Confirmed is not executed: a crank that settled the epoch first makes this one fail,
      // and the rung would still be active.
      if (outcome.value.err) {
        throw new Error(`the network rejected it: ${JSON.stringify(outcome.value.err)}`)
      }

      // The history tab reads closed rungs; without this it would miss the one just closed.
      // The settlement previews go too: the epoch this signature settled has nothing to preview.
      await Promise.all([
        queries.invalidateQueries({ queryKey: ['ladder'] }),
        queries.invalidateQueries({ queryKey: ['history'] }),
        queries.invalidateQueries({ queryKey: ['settlement'] }),
      ])
      setStatus({ kind: 'done', signature })
    } catch (error) {
      setStatus({ kind: 'failed', message: message(error) })
    }
  }, [publicKey, action, connection, sendTransaction, queries])

  const busy = status.kind === 'signing' || status.kind === 'confirming'

  return { action, status, busy, redeem }
}
