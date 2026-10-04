/**
 * Decoded accounts for the keeper's tests, at the addresses the program would give them: the
 * tick builds instructions from seeds, so an epoch at a random address would never be found.
 */

import {
  type Epoch,
  type EpochView,
  epochAddress,
  type LadderEntry,
  type Market,
  PROGRAM_ID,
  type Rung,
  type RungEntry,
  rungAddress,
} from '@runway-ladder/sdk'
import { PublicKey } from '@solana/web3.js'

export const NOW = 1_800_000_000n
export const marketKey = PublicKey.unique()

export const settled: Epoch['status'] = { kind: 'settled', paid: 1_010n }

export function epochAt(
  maturityTs: bigint,
  status: Epoch['status'] = { kind: 'active' },
): EpochView {
  return {
    address: epochAddress(PROGRAM_ID, marketKey, maturityTs),
    epoch: {
      market: marketKey,
      maturityTs,
      rateBps: 500,
      createdBy: PublicKey.unique(),
      createdAt: 0n,
      totalDeposited: 1_000n,
      totalPromised: 1_010n,
      depositSeconds: 0n,
      redeemed: 0n,
      status,
      bump: 255,
    },
  }
}

export function ladderWith(rungCount: number): LadderEntry {
  return {
    address: PublicKey.unique(),
    ladder: {
      owner: PublicKey.unique(),
      market: marketKey,
      seed: 0n,
      rungCount,
      rollPolicy: 'roll',
      createdAt: 0n,
      bump: 255,
    },
  }
}

export function rungIn(
  epoch: EpochView,
  index: number,
  ladder: PublicKey = PublicKey.default,
  status: Rung['status'] = { kind: 'active' },
): RungEntry {
  return {
    address: rungAddress(PROGRAM_ID, ladder, index),
    rung: {
      ladder,
      epoch: epoch.address,
      index,
      deposited: 1_000n,
      promised: 1_010n,
      feePaid: 0n,
      status,
      bump: 255,
    },
  }
}

export function marketWithLatest(latestMaturity: bigint): Market {
  return {
    authority: PublicKey.unique(),
    assetMint: PublicKey.unique(),
    vault: PublicKey.unique(),
    bufferVault: PublicKey.unique(),
    source: { kind: 'deterministic', rateBps: 600 },
    feeBps: 0,
    minRungAmount: 1n,
    latestMaturity,
    bump: 255,
  }
}
