/**
 * The dashboard's reads of onchain state.
 *
 * Everything the dashboard knows about money comes from here — and only through
 * `packages/sdk`. There is no account decoding of its own here, and there must not be: a
 * second implementation of the deposit layout would mean a second number on screen.
 */

import {
  type Epoch,
  fetchEpochs,
  fetchLadder,
  fetchMarket,
  fetchMintDecimals,
  LadderNotFoundError,
  type LadderView,
} from '@runway-ladder/sdk'
import { useConnection } from '@solana/wallet-adapter-react'
import type { PublicKey } from '@solana/web3.js'
import { QueryClient, skipToken, useQuery } from '@tanstack/react-query'
import { liveNetwork } from '@/lib/network'

/**
 * One retry, and only on network failures. The dashboard shows amounts: a long
 * chain of retries produces a screen that looks alive while nothing underneath it
 * has refreshed for minutes.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
    },
  },
})

/** Local copy so the type narrowing holds inside `queryFn`. */
const live = liveNetwork

/**
 * The RPC address is part of every query key. Without it, changing `.env` and
 * reloading would serve another network's data from cache as if it were the current one —
 * and devnet numbers would look local.
 */
const scope = live ? live.endpoint : 'offline'
const programId = live ? live.programId.toBase58() : 'offline'

export type ProgramStatus = {
  /** The program account exists on this RPC. */
  readonly deployed: boolean
  readonly executable: boolean
}

/**
 * Whether the program is on this RPC. One read answers two of the treasurer's
 * questions at once: "is the RPC alive?" and "is this the network RunwayLadder is on?". A
 * request error here means the first, `deployed: false` the second.
 */
export function useProgramStatus() {
  const { connection } = useConnection()

  return useQuery({
    queryKey: ['program', scope, programId],
    queryFn: live
      ? async (): Promise<ProgramStatus> => {
          const info = await connection.getAccountInfo(live.programId)

          return { deployed: info !== null, executable: info?.executable ?? false }
        }
      : skipToken,
  })
}

/**
 * The owner's ladder with all its rungs — or `null` if they have not laddered
 * anything yet. `null` is not an error here: an empty treasury is an ordinary state, and
 * the only way to tell it from a failed read is the SDK's typed refusal.
 */
export function useLadder(owner: PublicKey | null, seed: bigint) {
  const { connection } = useConnection()

  return useQuery({
    queryKey: ['ladder', scope, programId, owner?.toBase58() ?? null, seed.toString()],
    queryFn:
      live && owner
        ? async (): Promise<LadderView | null> => {
            try {
              return await fetchLadder(connection, owner, seed, live.programId)
            } catch (error) {
              if (error instanceof LadderNotFoundError) return null
              throw error
            }
          }
        : skipToken,
  })
}

/**
 * Market parameters and the decimals of its mint — two reads, because the number of
 * decimals lives in the mint, not in the market. Together they are what the form computes
 * amounts with, so it is one query: half of this data lets you compute nothing.
 */
export function useMarketParams() {
  const { connection } = useConnection()
  const market = live?.market ?? null

  return useQuery({
    queryKey: ['market', scope, market?.toBase58() ?? null],
    queryFn: market
      ? async () => {
          const account = await fetchMarket(connection, market)
          const decimals = await fetchMintDecimals(connection, account.assetMint)

          return { market: account, decimals }
        }
      : skipToken,
  })
}

/**
 * The market's epochs — the calendar the form builds the ladder from. Ordering and the
 * "not yet matured" filter stay in `lib/pricing.ts`: here there is only reading.
 */
export function useEpochs() {
  const { connection } = useConnection()
  const market = live?.market ?? null

  return useQuery({
    queryKey: ['epochs', scope, programId, market?.toBase58() ?? null],
    queryFn:
      live && market
        ? async (): Promise<Epoch[]> => {
            const views = await fetchEpochs(connection, market, live.programId)

            return views.map((view) => view.epoch)
          }
        : skipToken,
  })
}
