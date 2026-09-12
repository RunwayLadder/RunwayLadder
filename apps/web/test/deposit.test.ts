import { PublicKey } from '@solana/web3.js'
import {
  associatedTokenAddress,
  epochAddress,
  ladderAddress,
  PROGRAM_ID,
  rungAddress,
} from '@treasury-runway/sdk'
import { describe, expect, it } from 'vitest'
import {
  type DepositContext,
  depositAction,
  type LadderState,
  type MarketState,
} from '../src/lib/deposit'
import { buildPlan, type MarketParams, type Plan, type PublishedEpoch } from '../src/lib/plan'

const owner = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
const market = new PublicKey('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8')
const assetMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

const marketParams: MarketParams = {
  symbol: 'USDC',
  source: 'Deterministic Adapter · demo',
  decimals: 6,
  feeBps: 25,
  minRungAmount: 10_000_000n,
}

const operator = { operator: '9fRe…Lq2b', ratesSetAt: 999_000_000n }

const calendar: PublishedEpoch[] = [
  { termDays: 30, rateBps: 480, maturityTs: 1_800_000_000n, ...operator },
  { termDays: 90, rateBps: 560, maturityTs: 1_805_184_000n, ...operator },
  { termDays: 180, rateBps: 620, maturityTs: 1_812_960_000n, ...operator },
]

/** The plan is built by the same code as on screen: one invented here would drift. */
function planOf(rungCount = 2): Plan {
  const result = buildPlan(
    {
      amount: '1000',
      horizonDays: 180,
      rungCount,
      distribution: 'even',
      weights: [],
    },
    marketParams,
    calendar,
  )
  if (!result.ok) throw new Error(`plan was not built: ${JSON.stringify(result.problems)}`)

  return result.plan
}

const read: MarketState = { kind: 'read', address: market, assetMint }

const context = (over: Partial<DepositContext> = {}): DepositContext => ({
  owner,
  market: read,
  pricedFromChain: true,
  ladder: { kind: 'absent' },
  programId: PROGRAM_ID,
  seed: 0n,
  rollPolicy: 'none',
  ...over,
})

const blocked = (over: Partial<DepositContext>): string => {
  const action = depositAction(planOf(), context(over))
  if (action.kind !== 'blocked') throw new Error('expected a refusal')

  return action.reason
}

const ready = (over: Partial<DepositContext> = {}) => {
  const action = depositAction(planOf(), context(over))
  if (action.kind !== 'ready') throw new Error(`expected instructions: ${action.reason}`)

  return action
}

describe('depositAction · why there will be no signature', () => {
  it('says what to do first, not what is wrong deepest', () => {
    // The order of refusals is the order in which the treasurer can act on them.
    // A disconnected wallet hears about the wallet, not about an unread ladder.
    expect(
      blocked({
        owner: null,
        market: { kind: 'absent' },
        ladder: { kind: 'unknown', reason: 'x' },
      }),
    ).toMatch(/Connect a wallet/)
  })

  it('refuses to sign against prototype prices', () => {
    // The most expensive refusal here. Prototype dates are counted from "now", epochs at
    // such addresses do not exist — the transaction would fail after signing, and the treasurer
    // would pay for it with the fee.
    expect(blocked({ pricedFromChain: false })).toMatch(/do not exist on chain/)
  })

  it('passes the reason the market could not be read through', () => {
    // Without the mint the account the funds leave from is unknown, and "still reading"
    // is not the same as "there is no market".
    expect(blocked({ market: { kind: 'unknown', reason: 'Reading the market…' } })).toBe(
      'Reading the market…',
    )
    expect(blocked({ market: { kind: 'absent' } })).toMatch(/VITE_MARKET is not set/)
  })

  it('refuses while the ladder is unread instead of guessing', () => {
    // Both guesses cost a signature: "none" on an open ladder runs into
    // an occupied address, "exists" on an empty one into an uninitialised account.
    const reason = 'Your ladder could not be read: 429 Too Many Requests'
    expect(blocked({ ladder: { kind: 'unknown', reason } })).toBe(reason)
  })

  it('names the maturity the ladder already holds', () => {
    // A rung is addressed by the pair "ladder, epoch": a second one in the same epoch cannot
    // exist. Onchain this is a refusal after signing, here — a date in the explanation.
    const plan = planOf()
    const taken = plan.rungs[0]?.epoch.maturityTs
    if (taken === undefined) throw new Error('plan without rungs')

    const ladder: LadderState = {
      kind: 'open',
      rungEpochs: [epochAddress(PROGRAM_ID, market, taken)],
    }

    expect(blocked({ ladder })).toMatch(/already holds a rung maturing on 2027-01-15/)
  })
})

describe('depositAction · what goes to the network', () => {
  it('opens the ladder in the same signature when there is none', () => {
    const action = ready()

    expect(action.opensLadder).toBe(true)
    // Budget, open, deposit — three instructions in one signature.
    expect(action.instructions).toHaveLength(3)
    expect(action.instructions[1]?.keys).toHaveLength(4)
  })

  it('only deposits when the ladder is already open', () => {
    // The ladder exists, and none of its rungs sits on the dates of this deposit.
    const ladder: LadderState = {
      kind: 'open',
      rungEpochs: [epochAddress(PROGRAM_ID, market, 1_999_000_000n)],
    }
    const action = ready({ ladder })

    expect(action.opensLadder).toBe(false)
    expect(action.instructions).toHaveLength(2)
  })

  it('spends from the owner’s associated account, not from an address of ours', () => {
    expect(ready().sourceToken.toBase58()).toBe(associatedTokenAddress(owner, assetMint).toBase58())
  })

  it('carries the maturities the treasurer saw in the preview', () => {
    // The quietest possible bug: signed dates that differ from the shown ones. The
    // "epoch, rung" pairs are checked against the plan, not against what is convenient.
    const plan = planOf(3)
    const action = depositAction(plan, context())
    if (action.kind !== 'ready') throw new Error('expected instructions')

    const deposit = action.instructions.at(-1)
    const ladder = ladderAddress(PROGRAM_ID, owner, 0n)
    const tail = deposit?.keys.slice(8) ?? []

    expect(tail).toHaveLength(plan.rungs.length * 2)
    plan.rungs.forEach((rung, index) => {
      const epoch = epochAddress(PROGRAM_ID, market, rung.epoch.maturityTs)
      expect(tail[index * 2]?.pubkey.toBase58()).toBe(epoch.toBase58())
      expect(tail[index * 2 + 1]?.pubkey.toBase58()).toBe(
        rungAddress(PROGRAM_ID, ladder, epoch).toBase58(),
      )
    })
  })

  it('signs with the owner and with nobody else', () => {
    for (const instruction of ready().instructions) {
      for (const key of instruction.keys) {
        if (key.isSigner) expect(key.pubkey.toBase58()).toBe(owner.toBase58())
      }
    }
  })
})
