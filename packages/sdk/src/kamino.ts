import {
  type AccountMeta,
  type Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js'
import { PROGRAM_ID } from './accounts.js'
import { collateralAddress } from './pda.js'

/**
 * The accounts a Kamino market's instructions carry for the program's Kamino adapter
 * (`programs/runway-ladder/src/source/kamino.rs`).
 *
 * The program pins one reserve per market and checks every account it answers for; the rest
 * klend checks itself. This file only has to find them — from the reserve account, the one
 * address a Kamino market names.
 */

/** Kamino's lending program (klend) on mainnet. */
export const KLEND_PROGRAM_ID = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD')

/**
 * Field offsets inside klend's `Reserve` (discriminator included), release 1.25.0 — the same
 * table `scripts/kamino-dump.ts` and the program read.
 */
const RESERVE = {
  lendingMarket: 32,
  liquidityMint: 128,
  liquiditySupply: 160,
  collateralMint: 2560,
} as const

const LENDING_MARKET_AUTHORITY = Buffer.from('lma')

/** What a Kamino market's instructions need to know about its reserve. */
export type KaminoReserve = {
  readonly address: PublicKey
  readonly lendingMarket: PublicKey
  /** klend's PDA `["lma", lendingMarket]`: owns the reserve's supply and mints its kTokens. */
  readonly lendingMarketAuthority: PublicKey
  readonly liquidityMint: PublicKey
  readonly liquiditySupply: PublicKey
  readonly collateralMint: PublicKey
}

/**
 * Like every account from the network, the reserve is not trusted input: the owner is checked
 * before an offset is read, and an account too short to hold the fields is refused rather than
 * read past its end.
 */
export function decodeKaminoReserve(
  address: PublicKey,
  account: { readonly owner: PublicKey; readonly data: Buffer },
): KaminoReserve {
  if (!account.owner.equals(KLEND_PROGRAM_ID)) {
    throw new Error(`${address.toBase58()} is not a klend account`)
  }
  if (account.data.length < RESERVE.collateralMint + 32) {
    throw new Error(`${address.toBase58()} is not a klend reserve: ${account.data.length} bytes`)
  }

  const keyAt = (offset: number) => new PublicKey(account.data.subarray(offset, offset + 32))
  const lendingMarket = keyAt(RESERVE.lendingMarket)

  return {
    address,
    lendingMarket,
    lendingMarketAuthority: PublicKey.findProgramAddressSync(
      [LENDING_MARKET_AUTHORITY, lendingMarket.toBuffer()],
      KLEND_PROGRAM_ID,
    )[0],
    liquidityMint: keyAt(RESERVE.liquidityMint),
    liquiditySupply: keyAt(RESERVE.liquiditySupply),
    collateralMint: keyAt(RESERVE.collateralMint),
  }
}

export async function fetchKaminoReserve(
  connection: Pick<Connection, 'getAccountInfo'>,
  address: PublicKey,
): Promise<KaminoReserve> {
  const account = await connection.getAccountInfo(address)
  if (!account) {
    throw new Error(`reserve ${address.toBase58()} is not on the network`)
  }

  return decodeKaminoReserve(address, account)
}

/**
 * The nine accounts `ladder_deposit`, `settle_epoch` and `roll_rung` take after their own on a
 * Kamino market — in the order the program reads them.
 */
export function kaminoSourceAccounts(
  market: PublicKey,
  reserve: KaminoReserve,
  programId: PublicKey = PROGRAM_ID,
): AccountMeta[] {
  return [
    { pubkey: KLEND_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: reserve.lendingMarket, isSigner: false, isWritable: false },
    { pubkey: reserve.lendingMarketAuthority, isSigner: false, isWritable: false },
    { pubkey: reserve.address, isSigner: false, isWritable: true },
    { pubkey: reserve.liquidityMint, isSigner: false, isWritable: false },
    { pubkey: reserve.liquiditySupply, isSigner: false, isWritable: true },
    { pubkey: reserve.collateralMint, isSigner: false, isWritable: true },
    { pubkey: collateralAddress(programId, market), isSigner: false, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  ]
}

/** What `init_market` takes for Kamino: the reserve, its kToken mint, the account it creates. */
export function kaminoInitAccounts(
  market: PublicKey,
  reserve: KaminoReserve,
  programId: PublicKey = PROGRAM_ID,
): AccountMeta[] {
  return [
    { pubkey: reserve.address, isSigner: false, isWritable: false },
    { pubkey: reserve.collateralMint, isSigner: false, isWritable: false },
    { pubkey: collateralAddress(programId, market), isSigner: false, isWritable: true },
  ]
}
