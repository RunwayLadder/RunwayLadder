/**
 * Reading the program's events back from transaction logs (FR-015, FR-021).
 *
 * Events are log-based (`emit!`): each one is a `Program data: <base64>` line. A line like that
 * carries no author — any program in the transaction can print one — so it is attributed here
 * by the invoke stack the runtime logs around it, and only lines printed while this program
 * was on top are decoded. A foreign program emitting bytes that happen to decode would
 * otherwise write the treasurer's history.
 */

import { BN, BorshEventCoder, type Idl } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import idl from './idl/runway_ladder.json' with { type: 'json' }

const coder = new BorshEventCoder(idl as Idl)

const publicKey = z.custom<PublicKey>((v) => v instanceof PublicKey, 'expected a PublicKey')
const u64 = z
  .custom<BN>((v) => BN.isBN(v), 'expected an integer')
  .transform((v) => BigInt(v.toString()))

const rungRedeemedSchema = z
  .object({
    ladder: publicKey,
    rung: publicKey,
    epoch: publicKey,
    destination: publicKey,
    promised: u64,
    amount: u64,
    with_deficit: z.boolean(),
    redeemed_at: u64,
  })
  .transform((e) => ({
    kind: 'redeemed' as const,
    ladder: e.ladder,
    rung: e.rung,
    epoch: e.epoch,
    destination: e.destination,
    promised: e.promised,
    amount: e.amount,
    withDeficit: e.with_deficit,
    at: e.redeemed_at,
  }))

const rungRolledSchema = z
  .object({
    ladder: publicKey,
    rung: publicKey,
    epoch: publicKey,
    into: publicKey,
    promised: u64,
    amount: u64,
    with_deficit: z.boolean(),
    rolled_at: u64,
  })
  .transform((e) => ({
    kind: 'rolled' as const,
    ladder: e.ladder,
    rung: e.rung,
    epoch: e.epoch,
    into: e.into,
    promised: e.promised,
    amount: e.amount,
    withDeficit: e.with_deficit,
    at: e.rolled_at,
  }))

/**
 * How a rung left the `Active` state, as the transaction that did it recorded it. `at` is the
 * program's clock at execution — the same moment the account status was written.
 */
export type RungClosure = z.output<typeof rungRedeemedSchema> | z.output<typeof rungRolledSchema>

export type ProgramEvent = { readonly name: string; readonly data: unknown }

export type ProgramLogs = {
  readonly events: readonly ProgramEvent[]
  /**
   * The node cut the log short. Events after the cut are lost for good, so "not found"
   * in a truncated log is a different answer from "not there".
   */
  readonly truncated: boolean
}

const INVOKE = /^Program (\w+) invoke \[\d+\]$/
const EXIT = /^Program (\w+) (success|failed)/
const DATA = 'Program data: '

export function programEvents(logs: readonly string[], programId: PublicKey): ProgramLogs {
  const self = programId.toBase58()
  const stack: string[] = []
  const events: ProgramEvent[] = []
  let truncated = false

  for (const line of logs) {
    const invoke = INVOKE.exec(line)
    if (invoke?.[1]) {
      stack.push(invoke[1])
      continue
    }
    if (EXIT.test(line)) {
      stack.pop()
      continue
    }
    if (line === 'Log truncated') {
      truncated = true
      continue
    }
    if (line.startsWith(DATA) && stack.at(-1) === self) {
      const event = coder.decode(line.slice(DATA.length))
      if (event) events.push({ name: event.name, data: event.data })
    }
  }

  return { events, truncated }
}

/** Redemptions and rolls in a transaction's logs; every other event of the program is skipped. */
export function rungClosures(events: readonly ProgramEvent[]): RungClosure[] {
  return events.flatMap((event): RungClosure[] => {
    if (event.name === 'RungRedeemed') return [rungRedeemedSchema.parse(event.data)]
    if (event.name === 'RungRolled') return [rungRolledSchema.parse(event.data)]
    return []
  })
}
