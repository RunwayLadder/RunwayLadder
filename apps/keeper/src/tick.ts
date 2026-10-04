/**
 * One pass of the crank: settle what has matured, then roll what the owners asked to roll.
 *
 * In that order, because a roll takes its amount from the settled epoch — and the epochs are
 * read again in between, so a rung whose epoch this very tick settled is rolled in the same
 * tick, not one interval later.
 *
 * Every transaction is the keeper's alone and moves nothing of its own: `settle_epoch` has no
 * signer among its accounts, and `roll_rung` takes no destination. One instruction per
 * transaction, so a refusal names exactly the rung or epoch it is about.
 */

import { buildRollRung, buildSettleEpoch } from '@runway-ladder/sdk'
import type { PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { Chain } from './chain.js'
import { refusalOf } from './outcome.js'
import { epochsToSettle, rollTarget, rungsToRoll } from './plan.js'

export type KeeperContext = {
  readonly chain: Chain
  /** The keeper's address: the payer of every roll. */
  readonly keeper: PublicKey
  readonly market: PublicKey
  readonly programId: PublicKey
  readonly minBalanceLamports: bigint
  readonly log: (line: string) => void
}

export type TickReport = {
  /** The chain's time the tick decided by. */
  readonly now: bigint
  readonly settled: string[]
  readonly rolled: string[]
  /** Refusals the keeper expects (see `outcome.ts`), and rungs with nowhere to roll. */
  readonly skipped: string[]
  /** Everything else. A non-empty list makes a one-shot run exit non-zero. */
  readonly failed: string[]
}

export async function tick(ctx: KeeperContext): Promise<TickReport> {
  const { chain, keeper, market, programId, log } = ctx
  const now = await chain.time()
  const report: TickReport = { now, settled: [], rolled: [], skipped: [], failed: [] }

  const skip = (line: string): void => {
    report.skipped.push(line)
    log(`skip ${line}`)
  }
  const fail = (line: string): void => {
    report.failed.push(line)
    log(`FAIL ${line}`)
  }

  const balance = await chain.balance()
  if (balance < ctx.minBalanceLamports) {
    fail(
      `keeper ${keeper.toBase58()} holds ${balance} lamports, below ` +
        `${ctx.minBalanceLamports}: top it up — nothing was sent`,
    )
    return report
  }

  const send = async (what: string, instruction: TransactionInstruction): Promise<boolean> => {
    try {
      log(`${what}: ${await chain.send(instruction)}`)
      return true
    } catch (error) {
      const refusal = refusalOf(error)
      if (refusal.expected) skip(`${what}: ${refusal.reason}`)
      else fail(`${what}: ${refusal.reason}`)
      return false
    }
  }

  const marketAccount = await chain.market()

  for (const due of epochsToSettle(await chain.epochs(), now)) {
    const what = `settle epoch ${due.address.toBase58()} (matured ${due.epoch.maturityTs})`
    if (
      await send(what, buildSettleEpoch({ market, maturityTs: due.epoch.maturityTs, programId }))
    ) {
      report.settled.push(due.address.toBase58())
    }
  }

  const epochs = await chain.epochs()
  const target = rollTarget(marketAccount, epochs, now)

  for (const { address: ladder, ladder: account } of await chain.rollLadders()) {
    const ready = rungsToRoll(await chain.activeRungs(ladder), epochs)
    if (ready.length === 0) continue

    if (!target) {
      skip(
        `ladder ${ladder.toBase58()}: ${ready.length} rung(s) ready, no epoch ahead to roll into`,
      )
      continue
    }

    // Each roll takes the ladder's next number, so the count advances only on success.
    let next = account.rungCount
    for (const { rung } of ready) {
      const instruction = buildRollRung({
        payer: keeper,
        market,
        ladder,
        epoch: rung.epoch,
        rungIndex: rung.index,
        target: target.address,
        newRungIndex: next,
        programId,
      })
      if (
        await send(
          `roll rung ${rung.index} of ladder ${ladder.toBase58()} into rung ${next}`,
          instruction,
        )
      ) {
        report.rolled.push(`${ladder.toBase58()}#${rung.index}`)
        next += 1
      }
    }
  }

  return report
}
