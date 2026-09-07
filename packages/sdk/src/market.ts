/**
 * Reading the market and its epochs.
 *
 * This is the deposit's input data: the fee and the minimum rung size live in
 * `Market`, while the rate, the operator and the moment it was set live in `Epoch`. The client
 * has no right to supply them itself: FR-010a promises the treasurer that they see
 * **whose** rates these are and **when** they were set, before they sign.
 */

import { utils } from '@coral-xyz/anchor'
import type { Connection, PublicKey } from '@solana/web3.js'
import {
  accountDiscriminator,
  decodeEpoch,
  decodeMarket,
  type Epoch,
  type Market,
  PROGRAM_ID,
} from './accounts.js'

/** Network methods for reading the market. Narrower than `Connection` — the test substitutes. */
export type MarketReader = Pick<Connection, 'getAccountInfo' | 'getProgramAccounts'>

export class MarketNotFoundError extends Error {
  constructor(readonly address: PublicKey) {
    super(`market ${address.toBase58()} is not on the network`)
    this.name = 'MarketNotFoundError'
  }
}

export async function fetchMarket(connection: MarketReader, address: PublicKey): Promise<Market> {
  const account = await connection.getAccountInfo(address)
  if (!account) {
    throw new MarketNotFoundError(address)
  }

  return decodeMarket(account.data)
}

/** An epoch together with its address: without the address it cannot go into an instruction. */
export type EpochView = {
  address: PublicKey
  epoch: Epoch
}

/**
 * All epochs of the market, by maturity date.
 *
 * Selection goes by the `market` field inside the account, not by iterating possible dates:
 * the client does not know which dates the operator published — that is the whole question.
 * Offset 8 — right after the discriminator, the first field of `Epoch`.
 */
export async function fetchEpochs(
  connection: MarketReader,
  market: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): Promise<EpochView[]> {
  const raw = await connection.getProgramAccounts(programId, {
    filters: [
      { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(accountDiscriminator('Epoch')) } },
      { memcmp: { offset: 8, bytes: market.toBase58() } },
    ],
  })

  return raw
    .map((item) => ({ address: item.pubkey, epoch: decodeEpoch(item.account.data) }))
    .sort((a, b) => Number(a.epoch.maturityTs - b.epoch.maturityTs))
}

/**
 * The number of decimals of the mint.
 *
 * Byte 44 of the SPL Mint layout is all the parsing we need, and a decoder of our own
 * is cheaper here than `@solana/spl-token` with its dependency tree. The reason this is
 * read from the network at all rather than hard-coded: FR-001 forbids relying on
 * a specific mint, and "six decimals" is a property of USDC, not of the product.
 */
const MINT_SIZE = 82
const DECIMALS_OFFSET = 44

export async function fetchMintDecimals(
  connection: Pick<Connection, 'getAccountInfo'>,
  mint: PublicKey,
): Promise<number> {
  const account = await connection.getAccountInfo(mint)
  if (!account) {
    throw new Error(`mint ${mint.toBase58()} is not on the network`)
  }

  // Token-2022 appends extensions after the base 82 bytes, hence the check is
  // "at least" rather than "exactly": the first 82 bytes are the same in both programs.
  if (account.data.length < MINT_SIZE) {
    throw new Error(`account ${mint.toBase58()} is not a mint: ${account.data.length} bytes`)
  }

  const decimals = account.data[DECIMALS_OFFSET]
  if (decimals === undefined) {
    throw new Error(`mint ${mint.toBase58()} has no decimals byte`)
  }

  return decimals
}
