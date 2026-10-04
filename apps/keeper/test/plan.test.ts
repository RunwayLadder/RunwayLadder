import { describe, expect, it } from 'vitest'
import { epochsToSettle, rollTarget, rungsToRoll } from '../src/plan.js'
import { epochAt, marketWithLatest, NOW, rungIn, settled } from './accounts.js'

describe('epochsToSettle', () => {
  it('takes active epochs matured by the chain time, the boundary included', () => {
    // `<=`, as `settle_epoch` checks: an epoch maturing at exactly `now` is due now.
    const atNow = epochAt(NOW)
    const past = epochAt(NOW - 60n)
    const ahead = epochAt(NOW + 1n)

    expect(epochsToSettle([ahead, atNow, past], NOW)).toEqual([atNow, past])
  })

  it('leaves settled epochs alone, a deficit included', () => {
    const done = epochAt(NOW - 60n, settled)
    const short = epochAt(NOW - 120n, { kind: 'settledWithDeficit', paid: 900n, deficit: 110n })

    expect(epochsToSettle([done, short], NOW)).toEqual([])
  })
})

describe('rollTarget', () => {
  it('is the market latest maturity while it is ahead', () => {
    const near = epochAt(NOW + 60n)
    const far = epochAt(NOW + 600n)

    expect(rollTarget(marketWithLatest(far.epoch.maturityTs), [near, far], NOW)).toBe(far)
  })

  it('is absent once the latest epoch has matured — the keeper opens none itself', () => {
    // `>` as in `roll_rung`: an epoch maturing at exactly `now` is no longer ahead.
    const last = epochAt(NOW)

    expect(rollTarget(marketWithLatest(NOW), [last], NOW)).toBeNull()
  })

  it('is absent when the market names an epoch the node did not return', () => {
    expect(rollTarget(marketWithLatest(NOW + 600n), [epochAt(NOW + 60n)], NOW)).toBeNull()
  })
})

describe('rungsToRoll', () => {
  it('takes active rungs of settled epochs, a deficit included, in the ladder order', () => {
    const done = epochAt(NOW - 120n, settled)
    const short = epochAt(NOW - 60n, { kind: 'settledWithDeficit', paid: 900n, deficit: 110n })
    const first = rungIn(done, 1)
    const second = rungIn(short, 4)
    const third = rungIn(done, 2)

    expect(rungsToRoll([second, first, third], [done, short])).toEqual([first, third, second])
  })

  it('leaves a rung whose epoch is matured but not settled', () => {
    // Its payout does not exist yet; the tick settles first and reads the epochs again.
    const unsettled = epochAt(NOW - 60n)

    expect(rungsToRoll([rungIn(unsettled, 0)], [unsettled])).toEqual([])
  })

  it('leaves closed rungs and rungs of epochs it was not given', () => {
    const done = epochAt(NOW - 60n, settled)
    const redeemed = rungIn(done, 0, undefined, { kind: 'redeemed', amount: 1_010n })
    const foreign = rungIn(epochAt(NOW - 90n, settled), 1)

    expect(rungsToRoll([redeemed, foreign], [done])).toEqual([])
  })
})
