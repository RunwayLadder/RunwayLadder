/**
 * The boundary between `.env` and the network.
 *
 * The dashboard has no backend of its own: everything it shows comes from the RPC. So
 * configuration here is not a convenience but the first place where a lie can begin on
 * the treasurer's screen. Parsing is pulled into the pure `readNetworkConfig()` so that
 * a test checks it, not the application launch.
 */

import { PublicKey } from '@solana/web3.js'
import { PROGRAM_ID } from '@treasury-runway/sdk'
import { z } from 'zod'

/**
 * The network name is derived from the RPC address — there is deliberately no separate
 * variable for it: two truths about the network (address and label) drift apart first.
 */
export type Cluster = 'localnet' | 'devnet' | 'testnet' | 'unknown'

/**
 * The prototype on mocks remains a valid state, not an error: without `VITE_RPC_URL`
 * the app shows exactly what it showed in M0, and says so out loud.
 * The reason for the refusal is part of the type, because "no network" without an
 * explanation means an hour in the console.
 */
export type NetworkConfig =
  | { readonly kind: 'offline'; readonly reason: string }
  | {
      readonly kind: 'live'
      readonly endpoint: string
      readonly cluster: Cluster
      readonly programId: PublicKey
      /**
       * The market the dashboard shows. Without it the network is read (program,
       * ladder) but there are no prices: the market sets the fee, the rung minimum and the mint,
       * and there is no way to guess them from the program address.
       */
      readonly market: PublicKey | null
    }

const envSchema = z.object({
  VITE_RPC_URL: z.string().trim().optional(),
  VITE_PROGRAM_ID: z.string().trim().optional(),
  VITE_MARKET: z.string().trim().optional(),
})

/**
 * The input is the raw `import.meta.env`, i.e. a dictionary of unknown content. A more
 * precise type here would be self-deception: Vite puts into it whatever is in `.env`.
 */
export type NetworkEnv = Record<string, unknown>

/** A configuration that really reads the network — the shape without the `offline` branch. */
export type LiveNetwork = Extract<NetworkConfig, { kind: 'live' }>

const OFFLINE_NO_RPC =
  'VITE_RPC_URL is not set — the dashboard stays on prototype data and reads nothing.'

/**
 * Mainnet is cut off by configuration, not by discipline: the program is unaudited,
 * and `docs/SPEC.md` keeps mainnet out of scope. The check is heuristic — it
 * catches the typical mistake (a provider's mainnet URL pasted into the variable), not
 * every way of reaching mainnet: a private proxy with a neutral name
 * reads as `unknown` and gets through. It is a guard against carelessness,
 * not a guarantee.
 */
const MAINNET = /mainnet/i

function clusterOf(host: string): Cluster {
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return 'localnet'
  if (/devnet/i.test(host)) return 'devnet'
  if (/testnet/i.test(host)) return 'testnet'

  return 'unknown'
}

export function readNetworkConfig(env: NetworkEnv): NetworkConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    return { kind: 'offline', reason: 'RPC configuration is not readable.' }
  }

  const { VITE_RPC_URL: rpc, VITE_PROGRAM_ID: program } = parsed.data
  if (!rpc) {
    return { kind: 'offline', reason: OFFLINE_NO_RPC }
  }

  let url: URL
  try {
    url = new URL(rpc)
  } catch {
    return { kind: 'offline', reason: `VITE_RPC_URL is not a URL: ${rpc}` }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'offline', reason: `VITE_RPC_URL must be http(s), got ${url.protocol}` }
  }

  if (MAINNET.test(url.host)) {
    return {
      kind: 'offline',
      reason: `${url.host} looks like mainnet — this build never reads mainnet.`,
    }
  }

  let programId: PublicKey
  try {
    programId = program ? new PublicKey(program) : PROGRAM_ID
  } catch {
    return { kind: 'offline', reason: `VITE_PROGRAM_ID is not an address: ${program}` }
  }

  const { VITE_MARKET: marketInput } = parsed.data
  let market: PublicKey | null = null
  if (marketInput) {
    try {
      market = new PublicKey(marketInput)
    } catch {
      return { kind: 'offline', reason: `VITE_MARKET is not an address: ${marketInput}` }
    }
  }

  return {
    kind: 'live',
    endpoint: url.toString(),
    cluster: clusterOf(url.hostname),
    programId,
    market,
  }
}

/**
 * The configuration is read once per page load. The consequence is intentional:
 * switching networks is a reload with a different `.env`, not in-memory state
 * that can drift from where the numbers were already read.
 */
export const network: NetworkConfig = readNetworkConfig(import.meta.env)

/**
 * The same configuration in a shape that can be narrowed once and passed on
 * ready-made. Components and hooks take exactly this: `network.kind === 'live'`
 * inside a closure no longer narrows in TypeScript, and every consumer would write
 * its own check that checks nothing.
 */
export const liveNetwork: LiveNetwork | null = network.kind === 'live' ? network : null
