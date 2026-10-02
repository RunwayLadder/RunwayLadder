import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { programEvents, rungClosures } from '../src/events.js'

/**
 * Logs of real transactions, captured by `scripts/e2e-history.ts` on a local validator: a
 * deposit, a redemption at par and a roll with a deficit. A decoder tested only on bytes
 * our own coder produced would agree with itself.
 */
type Captured = {
  programId: string
  ladder: string
  rung: string | null
  into: string | null
  destination: string | null
  logs: string[]
}

const captured = (name: string): Captured =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../fixtures/events/${name}.json`, import.meta.url)),
      'utf8',
    ),
  ) as Captured

const deposit = captured('deposit')
const redeem = captured('redeem')
const roll = captured('roll')
const programId = new PublicKey(redeem.programId)

describe('programEvents on real logs', () => {
  it('reads every event a deposit emits and finds no closure in it', () => {
    const { events, truncated } = programEvents(deposit.logs, programId)

    expect(truncated).toBe(false)
    expect(events.map((event) => event.name)).toEqual([
      'LadderOpened',
      'RungIssued',
      'RungIssued',
      'RungIssued',
      'LadderFunded',
    ])
    expect(rungClosures(events)).toEqual([])
  })

  it('reads a redemption at par: when, how much, and into which account', () => {
    const closures = rungClosures(programEvents(redeem.logs, programId).events)

    expect(closures).toHaveLength(1)
    const [closure] = closures
    if (closure?.kind !== 'redeemed') throw new Error(`expected a redemption, got ${closure?.kind}`)
    expect(closure.rung.toBase58()).toBe(redeem.rung)
    expect(closure.ladder.toBase58()).toBe(redeem.ladder)
    expect(closure.destination.toBase58()).toBe(redeem.destination)
    expect(closure.withDeficit).toBe(false)
    expect(closure.amount).toBe(closure.promised)
    expect(closure.at).toBeGreaterThan(0n)
  })

  it('reads a roll with the deficit marked and the new rung named', () => {
    const { events } = programEvents(roll.logs, programId)
    const closures = rungClosures(events)

    // The new rung's `RungIssued` sits in the same transaction and is not a closure.
    expect(events.map((event) => event.name)).toEqual(['RungRolled', 'RungIssued'])
    expect(closures).toHaveLength(1)
    const [closure] = closures
    if (closure?.kind !== 'rolled') throw new Error(`expected a roll, got ${closure?.kind}`)
    expect(closure.rung.toBase58()).toBe(roll.rung)
    expect(closure.into.toBase58()).toBe(roll.into)
    expect(closure.withDeficit).toBe(true)
    expect(closure.amount).toBeLessThan(closure.promised)
  })
})

describe('programEvents attribution', () => {
  const dataLine = redeem.logs.find((line) => line.startsWith('Program data: '))
  if (!dataLine) throw new Error('the redemption fixture has no event line')
  const foreign = 'Fore1gnProgram1111111111111111111111111111'

  it('ignores an event line printed while another program is on top of the stack', () => {
    const logs = [
      `Program ${programId.toBase58()} invoke [1]`,
      `Program ${foreign} invoke [2]`,
      dataLine,
      `Program ${foreign} success`,
      `Program ${programId.toBase58()} success`,
    ]

    expect(programEvents(logs, programId).events).toEqual([])
  })

  it('ignores the same line in a transaction this program never entered', () => {
    const logs = [`Program ${foreign} invoke [1]`, dataLine, `Program ${foreign} success`]

    expect(programEvents(logs, programId).events).toEqual([])
  })

  it('returns to this program after an inner call and reads its line again', () => {
    const logs = [
      `Program ${programId.toBase58()} invoke [1]`,
      `Program ${foreign} invoke [2]`,
      `Program ${foreign} success`,
      dataLine,
      `Program ${programId.toBase58()} success`,
    ]

    expect(rungClosures(programEvents(logs, programId).events)).toHaveLength(1)
  })

  it('reports a truncated log, so "not found" is not mistaken for "not there"', () => {
    const cut = [...redeem.logs.slice(0, 2), 'Log truncated']
    const parsed = programEvents(cut, programId)

    expect(parsed.truncated).toBe(true)
    expect(parsed.events).toEqual([])
  })
})
