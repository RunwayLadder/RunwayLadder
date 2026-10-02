import { buildSetRollPolicy, type LadderView, type RollPolicy } from '@runway-ladder/sdk'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { nextRollPolicy, rollPolicyAction } from '../src/lib/rollPolicy'

const owner = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
const stranger = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const programId = new PublicKey('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8')
// Not derivable from the owner and seed: if the action re-derived the address, the
// instruction would point elsewhere and the test would see it.
const ladderAddress = new PublicKey('So11111111111111111111111111111111111111112')

const viewOf = (rollPolicy: RollPolicy): LadderView => ({
  address: ladderAddress,
  ladder: {
    owner,
    market: programId,
    seed: 0n,
    rungCount: 0,
    rollPolicy,
    createdAt: 1_800_000_000n,
    bump: 255,
  },
  rungs: [],
})

describe('nextRollPolicy', () => {
  it('flips in both directions', () => {
    expect(nextRollPolicy('none')).toBe('roll')
    expect(nextRollPolicy('roll')).toBe('none')
  })
})

describe('rollPolicyAction', () => {
  it.each([
    ['none', 'roll'],
    ['roll', 'none'],
  ] as const)('flips %s on the network to %s', (current, next) => {
    const action = rollPolicyAction({ owner, view: viewOf(current), programId })

    expect(action.kind).toBe('ready')
    if (action.kind !== 'ready') return
    expect(action.next).toBe(next)
    expect(action.instruction.data).toEqual(
      buildSetRollPolicy({ owner, ladder: ladderAddress, rollPolicy: next, programId }).data,
    )
  })

  it('signs as the owner and writes to the ladder that was read', () => {
    const action = rollPolicyAction({ owner, view: viewOf('none'), programId })
    if (action.kind !== 'ready') throw new Error(`expected ready, got ${action.kind}`)

    expect(action.instruction.programId.equals(programId)).toBe(true)
    expect(
      action.instruction.keys.map((key) => ({
        pubkey: key.pubkey.toBase58(),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
    ).toEqual([
      { pubkey: owner.toBase58(), isSigner: true, isWritable: false },
      { pubkey: ladderAddress.toBase58(), isSigner: false, isWritable: true },
    ])
  })

  it('refuses without a wallet', () => {
    expect(rollPolicyAction({ owner: null, view: viewOf('none'), programId })).toEqual({
      kind: 'blocked',
      reason: 'Connect the owner wallet to change the policy.',
    })
  })

  it('refuses a wallet that is not the owner before it pays for the attempt', () => {
    expect(rollPolicyAction({ owner: stranger, view: viewOf('roll'), programId })).toEqual({
      kind: 'blocked',
      reason: 'Only the ladder owner can change the policy.',
    })
  })
})
