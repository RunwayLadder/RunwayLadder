/**
 * Signing the roll policy change: wallet, network and the state of one transaction.
 *
 * The switch never shows a position of its own. It shows `Ladder.roll_policy` as read from
 * the network, and while a change is in flight it is locked instead of moved ahead: a
 * switch that flips on click would claim a policy the crank does not see yet.
 */

import type { LadderView } from '@runway-ladder/sdk'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { Transaction } from '@solana/web3.js'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { liveNetwork } from '@/lib/network'
import { type RollPolicyAction, rollPolicyAction } from '@/lib/rollPolicy'

export type RollPolicyStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'signing' }
  | { readonly kind: 'confirming'; readonly signature: string }
  | { readonly kind: 'failed'; readonly message: string }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function useRollPolicy(view: LadderView | null) {
  const { connection } = useConnection()
  const { publicKey, sendTransaction } = useWallet()
  const queries = useQueryClient()

  const [status, setStatus] = useState<RollPolicyStatus>({ kind: 'idle' })

  const action = useMemo((): RollPolicyAction | null => {
    if (!view || !liveNetwork) return null

    return rollPolicyAction({ owner: publicKey ?? null, view, programId: liveNetwork.programId })
  }, [view, publicKey])

  const toggle = useCallback(async () => {
    if (!publicKey || action?.kind !== 'ready') return

    setStatus({ kind: 'signing' })
    try {
      // The same blockhash goes into the transaction and into the wait, as in the deposit.
      const latest = await connection.getLatestBlockhash('confirmed')
      const transaction = new Transaction({ feePayer: publicKey, ...latest })
      transaction.add(action.instruction)

      const signature = await sendTransaction(transaction, connection)
      setStatus({ kind: 'confirming', signature })

      const outcome = await connection.confirmTransaction({ signature, ...latest }, 'confirmed')
      if (outcome.value.err) {
        throw new Error(`the network rejected it: ${JSON.stringify(outcome.value.err)}`)
      }

      // The switch stays locked until the ladder is read again: unlocking first would
      // show the old policy for a moment, as if the change had not happened.
      await queries.invalidateQueries({ queryKey: ['ladder'] })
      setStatus({ kind: 'idle' })
    } catch (error) {
      setStatus({ kind: 'failed', message: message(error) })
    }
  }, [publicKey, action, connection, sendTransaction, queries])

  const busy = status.kind === 'signing' || status.kind === 'confirming'

  return { action, status, busy, toggle }
}
