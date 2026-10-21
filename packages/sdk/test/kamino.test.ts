import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ID } from '../src/accounts.js'
import {
  decodeKaminoReserve,
  KLEND_PROGRAM_ID,
  kaminoInitAccounts,
  kaminoSourceAccounts,
} from '../src/kamino.js'
import {
  buildLadderDeposit,
  buildLadderSetup,
  buildOpenLadder,
  MAX_RUNGS_PER_DEPOSIT,
  MAX_RUNGS_PER_KAMINO_DEPOSIT,
} from '../src/ladder.js'
import { collateralAddress, marketAddress } from '../src/pda.js'

/**
 * The reserve is read from the T045 snapshot — the real mainnet account — and the expected
 * keys come from the snapshot's own manifest, which `scripts/kamino-dump.ts` checked against
 * the chain when it took it. Neither side is this file's arithmetic.
 */
const snapshot = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../fixtures/kamino/${name}`, import.meta.url)),
      'utf8',
    ),
  )

const manifest = snapshot('manifest.json') as { accounts: { name: string; pubkey: string }[] }
const keyOf = (name: string) => {
  const entry = manifest.accounts.find((a) => a.name === name)
  if (!entry) throw new Error(`${name} in the manifest`)
  return new PublicKey(entry.pubkey)
}

const raw = snapshot('usdc-reserve.json') as {
  pubkey: string
  account: { owner: string; data: [string, 'base64'] }
}
const reserveAccount = {
  owner: new PublicKey(raw.account.owner),
  data: Buffer.from(raw.account.data[0], 'base64'),
}
const reserve = decodeKaminoReserve(new PublicKey(raw.pubkey), reserveAccount)

const usdc = keyOf('usdc-mint')
const market = marketAddress(PROGRAM_ID, usdc, 'kamino')

describe('decodeKaminoReserve', () => {
  it("finds the reserve's accounts where the snapshot found them", () => {
    expect(reserve.lendingMarket).toEqual(keyOf('lending-market'))
    expect(reserve.lendingMarketAuthority).toEqual(keyOf('lending-market-authority'))
    expect(reserve.liquidityMint).toEqual(usdc)
    expect(reserve.liquiditySupply).toEqual(keyOf('usdc-reserve-liquidity-supply'))
    expect(reserve.collateralMint).toEqual(keyOf('usdc-reserve-collateral-mint'))
  })

  it('refuses an account klend does not own', () => {
    expect(() =>
      decodeKaminoReserve(reserve.address, { ...reserveAccount, owner: PublicKey.unique() }),
    ).toThrow(/not a klend account/)
  })

  it('refuses an account too short to be a reserve', () => {
    const data = reserveAccount.data.subarray(0, 2560)
    expect(() => decodeKaminoReserve(reserve.address, { ...reserveAccount, data })).toThrow(
      /not a klend reserve/,
    )
  })
})

describe('kaminoSourceAccounts', () => {
  const accounts = kaminoSourceAccounts(market, reserve)

  it('lists the nine accounts in the order the program reads them', () => {
    expect(accounts.map((a) => a.pubkey)).toEqual([
      KLEND_PROGRAM_ID,
      reserve.lendingMarket,
      reserve.lendingMarketAuthority,
      reserve.address,
      usdc,
      reserve.liquiditySupply,
      reserve.collateralMint,
      collateralAddress(PROGRAM_ID, market),
      SYSVAR_INSTRUCTIONS_PUBKEY,
    ])
  })

  it('writes exactly what klend changes, and signs nothing', () => {
    // The reserve, its supply, its kToken mint and the market's kToken account; the market
    // PDA signs inside the program, never the client.
    expect(accounts.filter((a) => a.isWritable).map((a) => a.pubkey)).toEqual([
      reserve.address,
      reserve.liquiditySupply,
      reserve.collateralMint,
      collateralAddress(PROGRAM_ID, market),
    ])
    expect(accounts.some((a) => a.isSigner)).toBe(false)
  })

  it('hands init_market the reserve, its kToken mint and the account to create', () => {
    expect(kaminoInitAccounts(market, reserve).map((a) => a.pubkey)).toEqual([
      reserve.address,
      reserve.collateralMint,
      collateralAddress(PROGRAM_ID, market),
    ])
  })
})

describe('a deposit on a Kamino market', () => {
  const owner = PublicKey.unique()
  const deposit = (rungs: number) => ({
    owner,
    market,
    seed: 0n,
    sourceToken: PublicKey.unique(),
    amount: 1_000_000_000n * BigInt(rungs),
    distribution: { kind: 'even', rungs } as const,
    maturities: Array.from({ length: rungs }, (_, i) => 1_800_000_000n + BigInt(i) * 86_400n),
    firstRung: 0,
    sourceAccounts: kaminoSourceAccounts(market, reserve),
    rollPolicy: 'none' as const,
  })

  /** The signed size, priority fee included — what the treasurer actually sends. */
  const packetBytes = (instructions: TransactionInstruction[]) => {
    const tx = new Transaction()
    tx.add(...instructions, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }))
    tx.feePayer = owner
    tx.recentBlockhash = '11111111111111111111111111111111'
    return tx.compileMessage().serialize().length + 65
  }

  it("carries the source's accounts after the rung pairs", () => {
    const [, ix] = buildLadderDeposit(deposit(2))
    expect(ix?.keys.slice(8 + 2 * 2)).toEqual(kaminoSourceAccounts(market, reserve))
  })

  it('asks for the compute a Kamino deposit costs', () => {
    // Measured by `kamino_source.rs`: seven rungs ≈ 432k, two ≈ 140k.
    const units = (rungs: number) => buildLadderDeposit(deposit(rungs))[0]?.data.readUInt32LE(1)
    expect(units(2)).toBeGreaterThan(140_000)
    expect(units(MAX_RUNGS_PER_KAMINO_DEPOSIT.deposit)).toBeGreaterThan(432_000)
  })

  it('fits seven rungs in one packet, or six with the ladder opened alongside', () => {
    const { deposit: most, setup } = MAX_RUNGS_PER_KAMINO_DEPOSIT
    expect(packetBytes(buildLadderDeposit(deposit(most)))).toBeLessThanOrEqual(1232)
    expect(packetBytes(buildLadderSetup(deposit(setup)))).toBeLessThanOrEqual(1232)
    // And one more would not: the limits are the packet's, not a margin of ours. Seven rungs
    // with the ladder opened alongside, assembled by hand since `buildLadderSetup` refuses it.
    const [budget, seven] = buildLadderDeposit(deposit(setup + 1))
    if (!budget || !seven) throw new Error('two instructions')
    const opened = [budget, buildOpenLadder(deposit(setup + 1)), seven]
    expect(packetBytes(opened)).toBeGreaterThan(1232)
    expect(MAX_RUNGS_PER_KAMINO_DEPOSIT.deposit).toBeLessThan(MAX_RUNGS_PER_DEPOSIT)
  })

  it('refuses a ladder past those ceilings before anything is signed', () => {
    const { deposit: most, setup } = MAX_RUNGS_PER_KAMINO_DEPOSIT
    expect(() => buildLadderDeposit(deposit(most + 1))).toThrow(/limit is 7/)
    expect(() => buildLadderSetup(deposit(setup + 1))).toThrow(/limit is 6/)
  })
})
