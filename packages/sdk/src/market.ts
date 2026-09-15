/**
 * Reading the market and its epochs.
 *
 * This is the deposit's input data: the fee and the minimum rung size live in
 * `Market`, while the rate, the operator and the moment it was set live in `Epoch`. The client
 * has no right to supply them itself: FR-010a promises the treasurer that they see
 * **whose** rates these are and **when** they were set, before they sign.
 */

import { BN, BorshInstructionCoder, type Idl, utils } from '@coral-xyz/anchor'
import {
  type Connection,
  type PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import {
  accountDiscriminator,
  decodeEpoch,
  decodeMarket,
  type Epoch,
  type Market,
  PROGRAM_ID,
} from './accounts.js'
import idl from './idl/runway_ladder.json' with { type: 'json' }
import { bufferVaultAddress, epochAddress, marketAddress, vaultAddress } from './pda.js'

const coder = new BorshInstructionCoder(idl as Idl)

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

/**
 * Market operator instructions.
 *
 * The market and its epochs are set up not by the treasurer but by whoever publishes the
 * rates — so they sit apart from the ladder builders. They live here rather than in the
 * stand script for the same reason as everything else in this package: a second place
 * where instructions are encoded would drift from the first silently.
 */

/** The base yield source. Only one for now — the boundary is narrowed on purpose (T014). */
export type YieldSourceInput = { readonly kind: 'deterministic'; readonly rateBps: number }

export type InitMarketParams = {
  readonly authority: PublicKey
  readonly assetMint: PublicKey
  readonly source: YieldSourceInput
  readonly feeBps: number
  /** The rung minimum in the mint's base units — a market field, not a constant. */
  readonly minRungAmount: bigint
  readonly programId?: PublicKey
}

export function buildInitMarket(params: InitMarketParams): TransactionInstruction {
  const programId = params.programId ?? PROGRAM_ID
  const market = marketAddress(programId, params.assetMint, params.source.kind)

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: params.assetMint, isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: vaultAddress(programId, market), isSigner: false, isWritable: true },
      { pubkey: bufferVaultAddress(programId, market), isSigner: false, isWritable: true },
      { pubkey: utils.token.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: coder.encode('init_market', {
      source: { Deterministic: { rate_bps: params.source.rateBps } },
      fee_bps: params.feeBps,
      min_rung_amount: new BN(params.minRungAmount.toString()),
    }),
  })
}

export type CreateEpochParams = {
  readonly authority: PublicKey
  readonly market: PublicKey
  /** Maturity date in Unix seconds. Signed: it also goes into the epoch seeds. */
  readonly maturityTs: bigint
  readonly rateBps: number
  readonly programId?: PublicKey
}

export function buildCreateEpoch(params: CreateEpochParams): TransactionInstruction {
  const programId = params.programId ?? PROGRAM_ID

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: params.market, isSigner: false, isWritable: false },
      {
        pubkey: epochAddress(programId, params.market, params.maturityTs),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: coder.encode('create_epoch', {
      maturity_ts: new BN(params.maturityTs.toString()),
      rate_bps: params.rateBps,
    }),
  })
}
