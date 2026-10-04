import { SendTransactionError } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { programErrorOf, refusalOf } from '../src/outcome.js'

/** Logs as the node returns them for an Anchor `require!` that failed. */
function logsOf(code: string, number: number): string[] {
  return [
    'Program HShAvvN6icFTUAs2hiKTHr7nGomyrcKz66wPB6CNhewe invoke [1]',
    'Program log: Instruction: RollRung',
    `Program log: AnchorError thrown in programs/runway-ladder/src/state/roll.rs:91. Error Code: ${code}. Error Number: ${number}. Error Message: refused.`,
    `Program HShAvvN6icFTUAs2hiKTHr7nGomyrcKz66wPB6CNhewe failed: custom program error: 0x${number.toString(16)}`,
  ]
}

const sendError = (logs: string[]): SendTransactionError =>
  new SendTransactionError({
    action: 'simulate',
    signature: '',
    transactionMessage: 'Transaction simulation failed',
    logs,
  })

describe('programErrorOf', () => {
  it('reads the Anchor error name from the logs', () => {
    expect(programErrorOf(logsOf('RungNotActive', 6013))).toBe('RungNotActive')
  })

  it('reads an account constraint the same way', () => {
    const logs = [
      'Program log: AnchorError caused by account: new_rung. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated.',
    ]

    expect(programErrorOf(logs)).toBe('ConstraintSeeds')
  })

  it('finds nothing in logs without an Anchor error', () => {
    expect(programErrorOf(['Program log: Instruction: SettleEpoch'])).toBeNull()
  })
})

describe('refusalOf', () => {
  it('treats someone else getting there first as expected', () => {
    // The treasurer's Redeem button settles the epoch too; the owner may redeem in between.
    expect(refusalOf(sendError(logsOf('EpochAlreadySettled', 6009)))).toEqual({
      expected: true,
      reason: 'EpochAlreadySettled',
    })
    expect(refusalOf(sendError(logsOf('RungNotActive', 6013))).expected).toBe(true)
    expect(refusalOf(sendError(logsOf('RungBelowMinimum', 6000))).expected).toBe(true)
  })

  it('is loud about a refusal that means something is wrong', () => {
    expect(refusalOf(sendError(logsOf('EpochOverpaid', 6017)))).toEqual({
      expected: false,
      reason: 'EpochOverpaid',
    })
  })

  it('is loud about a failure that is not the program’s answer', () => {
    expect(refusalOf(new Error('fetch failed'))).toEqual({
      expected: false,
      reason: 'fetch failed',
    })
  })
})
