/**
 * Prices for the form: from the network when the market is set, from the prototype when not.
 *
 * The switch is built so the screen never shows a mix. Either all numbers
 * are read (fee, minimum, mint decimals, rates, operators), or all are
 * the prototype's — and in both cases it says which.
 */

import { useMemo } from 'react'
import { useEpochs, useMarketParams } from '@/lib/chain'
import { liveNetwork } from '@/lib/network'
import type { PublishedEpoch } from '@/lib/plan'
import { type Pricing, upcoming } from '@/lib/pricing'
import { sourceLabel } from '@/lib/rungRecord'
import {
  PROTOTYPE_OPERATOR,
  PROTOTYPE_RATES_SET_AT,
  prototypeMarket,
  publishedEpochs,
} from '@/lib/treasuryMock'

/**
 * "Now" is fixed at page load: epoch terms are counted from it,
 * and the numbers on screen must not shift by themselves while the treasurer looks at them.
 */
const NOW_SECONDS = BigInt(Math.floor(Date.now() / 1000))

const PROTOTYPE_CALENDAR: PublishedEpoch[] = publishedEpochs.map((entry) => ({
  ...entry,
  maturityTs: NOW_SECONDS + BigInt(entry.termDays) * 86_400n,
  operator: PROTOTYPE_OPERATOR,
  ratesSetAt: PROTOTYPE_RATES_SET_AT,
}))

const PROTOTYPE: Pricing = {
  kind: 'prototype',
  market: prototypeMarket,
  calendar: PROTOTYPE_CALENDAR,
}

type MarketQuery = ReturnType<typeof useMarketParams>
type EpochsQuery = ReturnType<typeof useEpochs>

/**
 * Why this is not inside `useMemo`: two queries have more state branches than
 * can be read at a glance, and each has its own reason. A separate function
 * leaves the hook with just the switching, not the state parsing.
 */
function fromChain(market: MarketQuery, epochs: EpochsQuery): Pricing {
  if (market.isPending || epochs.isPending) {
    return { kind: 'unavailable', reason: 'Reading the market and its epochs…' }
  }
  if (market.isError) {
    return { kind: 'unavailable', reason: `Market unreadable: ${message(market.error)}` }
  }
  if (epochs.isError) {
    return { kind: 'unavailable', reason: `Epochs unreadable: ${message(epochs.error)}` }
  }
  if (!market.data || !epochs.data) {
    return { kind: 'unavailable', reason: 'The market has not been read yet.' }
  }

  const calendar = upcoming(epochs.data, NOW_SECONDS)
  if (calendar.length === 0) {
    return {
      kind: 'unavailable',
      reason: 'The operator has published no epoch that has not matured yet.',
    }
  }

  return {
    kind: 'chain',
    market: {
      // There is no ticker on the network: it lives in the mint metadata, which we do not read.
      // A short form of the address invents nothing — unlike "USDC"
      // written under an arbitrary mint.
      symbol: shortMint(market.data.market.assetMint.toBase58()),
      source: sourceLabel(market.data.market),
      decimals: market.data.decimals,
      feeBps: market.data.market.feeBps,
      minRungAmount: market.data.market.minRungAmount,
    },
    calendar,
  }
}

export function usePricing(): Pricing {
  const market = useMarketParams()
  const epochs = useEpochs()
  const configured = liveNetwork?.market ?? null

  return useMemo(() => {
    if (!liveNetwork) return PROTOTYPE
    if (!configured) {
      return {
        kind: 'unavailable',
        reason: 'VITE_MARKET is not set — no market to read rates from.',
      }
    }

    return fromChain(market, epochs)
  }, [configured, market, epochs])
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error'

const shortMint = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`
