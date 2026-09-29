import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { utils } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ID } from '../src/accounts.js'
import {
  associatedTokenAddress,
  bufferVaultAddress,
  epochAddress,
  ladderAddress,
  marketAddress,
  rungAddress,
  sourceReserveAddress,
  vaultAddress,
} from '../src/pda.js'

type Fixture = {
  program_id: string
  asset_mint: string
  market: string
  vault: string
  buffer_vault: string
  source_reserve: string
  epochs: { maturity_ts: number; address: string }[]
  ladder_owner: string
  ladder_seed: number
  ladder: string
  rungs: { index: number; address: string }[]
}

const path = fileURLToPath(new URL('../../../fixtures/pdas.json', import.meta.url))
const fixture = JSON.parse(readFileSync(path, 'utf8')) as Fixture

const assetMint = new PublicKey(fixture.asset_mint)
const market = marketAddress(PROGRAM_ID, assetMint, 'deterministic')

describe('addresses', () => {
  it('uses the program id from the IDL', () => {
    expect(PROGRAM_ID.toBase58()).toBe(fixture.program_id)
  })

  it('derives the market, its vault, its buffer and its source reserve', () => {
    expect(market.toBase58()).toBe(fixture.market)
    expect(vaultAddress(PROGRAM_ID, market).toBase58()).toBe(fixture.vault)
    expect(bufferVaultAddress(PROGRAM_ID, market).toBase58()).toBe(fixture.buffer_vault)
    expect(sourceReserveAddress(PROGRAM_ID, market).toBase58()).toBe(fixture.source_reserve)
  })

  it.each(fixture.epochs)('derives the epoch maturing at $maturity_ts', (c) => {
    expect(epochAddress(PROGRAM_ID, market, BigInt(c.maturity_ts)).toBase58()).toBe(c.address)
  })

  // A date before 1970 in the seeds is not exotic but a sign check: as unsigned it would give
  // different bytes and a different address, and the client would look for the account in the wrong place.
  it('treats a maturity before the epoch as signed', () => {
    const negative = fixture.epochs.find((c) => c.maturity_ts < 0)
    expect(negative, 'the fixture must contain a negative date').toBeDefined()
  })

  it('gives a different address to every maturity', () => {
    const seen = new Set(fixture.epochs.map((c) => c.address))
    expect(seen.size).toBe(fixture.epochs.length)
  })

  const ladder = ladderAddress(
    PROGRAM_ID,
    new PublicKey(fixture.ladder_owner),
    BigInt(fixture.ladder_seed),
  )

  it('derives the ladder', () => {
    expect(ladder.toBase58()).toBe(fixture.ladder)
  })

  it.each(fixture.rungs)('derives rung number $index', (c) => {
    expect(rungAddress(PROGRAM_ID, ladder, c.index).toBase58()).toBe(c.address)
  })

  // The number is four bytes in the seeds. A case past 65 535 tells a u32 from a u16: written
  // as two bytes it would give a valid address with no rung behind it.
  it('writes the rung number as a u32', () => {
    expect(fixture.rungs.some((c) => c.index > 0xffff)).toBe(true)
  })

  it('refuses a rung number the program could not have issued', () => {
    for (const index of [-1, 1.5, 2 ** 32]) {
      expect(() => rungAddress(PROGRAM_ID, ladder, index)).toThrow(RangeError)
    }
  })
})

describe('associatedTokenAddress', () => {
  const owner = new PublicKey(fixture.market)

  it('reads the owner as the owner and the mint as the mint', () => {
    // The derivation is done by anchor, so there is nothing to check here except one thing —
    // that this wrapper call did not swap the arguments. Swapped, they would
    // give a perfectly valid address with nothing behind it.
    expect(associatedTokenAddress(owner, assetMint).toBase58()).toBe(
      utils.token.associatedAddress({ owner, mint: assetMint }).toBase58(),
    )
    expect(associatedTokenAddress(owner, assetMint).toBase58()).not.toBe(
      associatedTokenAddress(assetMint, owner).toBase58(),
    )
  })
})
