/**
 * The keeper: a permissionless crank for `settle_epoch` and `roll_rung` (FR-011, FR-013).
 *
 *   pnpm --filter @runway-ladder/keeper start           # a loop, one tick per interval
 *   pnpm --filter @runway-ladder/keeper start --once    # one tick — for a scheduled CI job
 *
 * Both modes run the same `tick()`; where it is hosted is a separate decision (T050). The
 * keeper going down blocks nobody: the dashboard sends the same instructions by hand.
 */

import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { Connection } from '@solana/web3.js'
import { chainOf } from './chain.js'
import { ConfigError, type KeeperConfig, parseConfig } from './config.js'
import { type KeeperContext, type TickReport, tick } from './tick.js'

const log = (line: string): void => {
  console.log(`${new Date().toISOString()} ${line}`)
}

function summary(report: TickReport): string {
  return (
    `tick at chain time ${report.now}: settled ${report.settled.length}, ` +
    `rolled ${report.rolled.length}, skipped ${report.skipped.length}, ` +
    `failed ${report.failed.length}`
  )
}

async function runOnce(ctx: KeeperContext): Promise<number> {
  const report = await tick(ctx)
  log(summary(report))

  return report.failed.length > 0 ? 1 : 0
}

/**
 * Ticks until SIGINT or SIGTERM. A failed tick — a node timing out, a refused transaction — is
 * logged and the loop goes on: the next tick reads the chain afresh, and a crank that stops on
 * the first network error is a crank nobody notices has stopped.
 */
async function runLoop(ctx: KeeperContext, config: KeeperConfig): Promise<number> {
  const stop = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => stop.abort())
  }

  while (!stop.signal.aborted) {
    try {
      log(summary(await tick(ctx)))
    } catch (error) {
      log(`FAIL tick: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      await sleep(config.intervalMs, undefined, { signal: stop.signal })
    } catch {
      // Aborted: the loop condition ends it.
    }
  }

  log('stopped')
  return 0
}

async function main(): Promise<number> {
  let config: KeeperConfig
  try {
    config = parseConfig(process.env, (path) => readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : error)
    return 2
  }

  const once = process.argv.includes('--once')
  const connection = new Connection(config.rpcUrl, 'confirmed')
  const ctx: KeeperContext = {
    chain: chainOf(connection, config.keeper, config.market, config.programId),
    keeper: config.keeper.publicKey,
    market: config.market,
    programId: config.programId,
    minBalanceLamports: config.minBalanceLamports,
    log,
  }

  log(
    `keeper ${config.keeper.publicKey.toBase58()} for market ${config.market.toBase58()} ` +
      `(program ${config.programId.toBase58()}), ${once ? 'one tick' : `every ${config.intervalMs / 1000} s`}`,
  )

  if (!once) return runLoop(ctx, config)

  try {
    return await runOnce(ctx)
  } catch (error) {
    log(`FAIL tick: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

// Not `process.exit()`: on Windows it trips a libuv assertion after open sockets and turns the
// exit code into 127.
process.exitCode = await main()
