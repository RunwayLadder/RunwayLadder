/**
 * What a crank needs to find on its own: the ladders that opted into rolling, and the rungs
 * still at work in them.
 *
 * A keeper serves every ladder of a market whose owner switched the policy on — nobody
 * registers with it, which is what "permissionless" means for the treasurer. So the search
 * goes by fields inside the accounts, not by a list of known owners: a list would silently
 * skip the ladder opened after it was written.
 *
 * The offsets are the Borsh layout of the accounts, checked against the independently encoded
 * references in `fixtures/accounts.json`, not only against our own decoder.
 */

import { utils } from '@coral-xyz/anchor'
import type { Connection, PublicKey } from '@solana/web3.js'
import {
  accountDiscriminator,
  decodeLadder,
  decodeRung,
  type Ladder,
  PROGRAM_ID,
  type Rung,
} from './accounts.js'

/** `Ladder.market`: discriminator 8 + owner 32. */
export const LADDER_MARKET_OFFSET = 40
/** `Ladder.roll_policy`: + market 32 + seed 8 + rung_count 4. */
export const LADDER_ROLL_POLICY_OFFSET = 84
/** `Rung.ladder`: right after the discriminator. */
export const RUNG_LADDER_OFFSET = 8
/** `Rung.status` tag: + ladder 32 + epoch 32 + index 4 + deposited, promised, fee_paid 8 each. */
export const RUNG_STATUS_OFFSET = 100

/** Borsh enum tags, in the order of the Rust declarations. */
const ROLL_POLICY_ROLL = 1
const RUNG_STATUS_ACTIVE = 0

/** Network methods for the search. Narrower than `Connection` — the test substitutes. */
export type CrankReader = Pick<Connection, 'getProgramAccounts'>

export type LadderEntry = {
  address: PublicKey
  ladder: Ladder
}

export type RungEntry = {
  address: PublicKey
  rung: Rung
}

const bytes = (value: number): string => utils.bytes.bs58.encode([value])

/**
 * The market's ladders with `policy=Roll`, as the chain has them now.
 *
 * Decoded and checked again after the filter: the node is not a trusted party either, and a
 * ladder of another market or with the policy off would be a roll the program refuses anyway —
 * better not to send it.
 */
export async function fetchRollLadders(
  connection: CrankReader,
  market: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): Promise<LadderEntry[]> {
  const raw = await connection.getProgramAccounts(programId, {
    filters: [
      { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(accountDiscriminator('Ladder')) } },
      { memcmp: { offset: LADDER_MARKET_OFFSET, bytes: market.toBase58() } },
      { memcmp: { offset: LADDER_ROLL_POLICY_OFFSET, bytes: bytes(ROLL_POLICY_ROLL) } },
    ],
  })

  return raw
    .map((item) => ({ address: item.pubkey, ladder: decodeLadder(item.account.data) }))
    .filter((entry) => entry.ladder.market.equals(market) && entry.ladder.rollPolicy === 'roll')
}

/**
 * The ladder's rungs still `Active`, by number.
 *
 * By number, because that is the order the ladder issued them in, and a crank that rolls them
 * in that order gives the new rungs numbers a reader can follow back.
 */
export async function fetchActiveRungs(
  connection: CrankReader,
  ladder: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): Promise<RungEntry[]> {
  const raw = await connection.getProgramAccounts(programId, {
    filters: [
      { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(accountDiscriminator('Rung')) } },
      { memcmp: { offset: RUNG_LADDER_OFFSET, bytes: ladder.toBase58() } },
      { memcmp: { offset: RUNG_STATUS_OFFSET, bytes: bytes(RUNG_STATUS_ACTIVE) } },
    ],
  })

  return raw
    .map((item) => ({ address: item.pubkey, rung: decodeRung(item.account.data) }))
    .filter((entry) => entry.rung.ladder.equals(ladder) && entry.rung.status.kind === 'active')
    .sort((a, b) => a.rung.index - b.rung.index)
}
