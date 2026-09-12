/**
 * The US1 end-to-end run on a local validator: SC-001 and SC-005 with numbers.
 *
 * What exactly is measured here — and what is not:
 *
 * - **SC-001** — "a deposit across 4 rungs in one confirmation, and the chart
 *   updates in < 15 s". The signature is measured exactly: one transaction, one signature
 *   in it. The time is up to the moment the network **returns** the ladder with all four
 *   rungs, i.e. until the data the chart is drawn from is ready. Browser
 *   rendering time is not included here, and one must not be passed off as the other.
 * - **SC-005** — "the charted total matches the redeemed rungs, 0 units of
 *   drift". There are no redemptions in M1 at all (`redeem_rung` is US2), so what is
 *   measured is the half that exists: the projection computed by `packages/math` from
 *   the ladder read back, against the promises recorded by the program. The other half is
 *   on T044, and until then SC-005 cannot be considered closed.
 *
 * One more check without which the previous two are worth little: the promises recorded
 * by the program are compared with what `packages/math` gives for **the same term**.
 * The two mirrors (`math.rs` and TS) must agree to the unit — a discrepancy between
 * them is exactly what the dashboard has no right to show.
 *
 * The term here is not "30 days" but seconds from the block the deposit landed in: the program
 * computes the promise from precisely that. The form preview measures in whole days from the
 * moment the treasurer looks at it, so it is always slightly higher — the run does not
 * hide that difference but names it as a number.
 *
 * The stand is brought up by `scripts/e2e-stand.sh` (validator, mint, a funded treasurer).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js'
import { fee, projectCashflow, promise, splitLadder } from '@treasury-runway/math'
import {
  associatedTokenAddress,
  buildCreateEpoch,
  buildInitMarket,
  buildLadderSetup,
  fetchLadder,
  type LadderView,
  marketAddress,
} from '@treasury-runway/sdk'

const DAY = 86_400

/** Stand parameters. The same numbers as in the prototype: fee 25 bps, minimum 10. */
const FEE_BPS = 25
const MIN_RUNG = 10_000_000n
const SOURCE_RATE_BPS = 600
const DECIMALS = 6
const AMOUNT = 1_000_000_000_000n
const TERMS = [30, 90, 180, 365] as const
const RATES_BPS = [480, 560, 620, 680] as const
/** SC-001 names the limit in seconds; here it stands as a number, not as "fast". */
const CHART_DEADLINE_MS = 15_000

type Stand = {
  rpc: string
  programId: string
  mint: string
  authority: string
  treasurer: string
  sourceToken: string
}

const standDir = fileURLToPath(new URL('../.e2e/', import.meta.url))

function readStand(): Stand {
  try {
    return JSON.parse(readFileSync(`${standDir}stand.json`, 'utf8')) as Stand
  } catch {
    throw new Error('no stand — run `pnpm e2e:stand` first (validator in WSL)')
  }
}

function keypair(file: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${standDir}${file}`, 'utf8')) as number[]),
  )
}

const units = (value: bigint): string => {
  const scale = 10n ** BigInt(DECIMALS)
  const rest = (value % scale).toString().padStart(DECIMALS, '0')

  return `${(value / scale).toLocaleString('en-US')}.${rest}`
}

const failures: string[] = []

function check(passed: boolean, line: string): void {
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${line}`)
  if (!passed) failures.push(line)
}

async function main(): Promise<void> {
  const stand = readStand()
  const connection = new Connection(stand.rpc, 'confirmed')
  const programId = new PublicKey(stand.programId)
  const assetMint = new PublicKey(stand.mint)
  const sourceToken = new PublicKey(stand.sourceToken)
  const authority = keypair(stand.authority)
  const treasurer = keypair(stand.treasurer)

  // The account the stand funded and the account the dashboard derives must be
  // one and the same: otherwise the button would sign a transfer from an empty address.
  check(
    associatedTokenAddress(treasurer.publicKey, assetMint).equals(sourceToken),
    `  treasurer ATA: ${sourceToken.toBase58()}`,
  )

  console.log(`\nMarket and epochs — from operator ${authority.publicKey.toBase58()}`)

  const market = marketAddress(programId, assetMint, 'deterministic')
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      buildInitMarket({
        authority: authority.publicKey,
        assetMint,
        source: { kind: 'deterministic', rateBps: SOURCE_RATE_BPS },
        feeBps: FEE_BPS,
        minRungAmount: MIN_RUNG,
        programId,
      }),
    ),
    [authority],
    { commitment: 'confirmed' },
  )

  // Dates are counted from the validator's time, not the Windows clock: an epoch that
  // has "already matured" by the chain's account is not created at all.
  const chainNow = await connection.getBlockTime(await connection.getSlot('confirmed'))
  if (chainNow === null) throw new Error('the validator did not return the block time')

  const maturities = TERMS.map((days) => BigInt(chainNow + days * DAY))
  for (const [index, maturityTs] of maturities.entries()) {
    const rateBps = RATES_BPS[index]
    if (rateBps === undefined) throw new Error('rate without an epoch')

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        buildCreateEpoch({
          authority: authority.publicKey,
          market,
          maturityTs,
          rateBps,
          programId,
        }),
      ),
      [authority],
      { commitment: 'confirmed' },
    )
    console.log(`  epoch +${TERMS[index]} d · ${rateBps} bps · ${maturityTs}`)
  }

  // The same preview the treasurer sees in the form: `packages/math` and nothing else.
  const distribution = { kind: 'even', rungs: TERMS.length } as const
  const parts = splitLadder(AMOUNT, distribution)
  const preview = parts.map((part, index) => {
    const rateBps = RATES_BPS[index]
    const term = TERMS[index]
    if (rateBps === undefined || term === undefined) throw new Error('rung without an epoch')

    const split = fee(part, FEE_BPS)

    return { working: split.working, promised: promise(split.working, rateBps, term * DAY) }
  })

  console.log(`\nDeposit of ${units(AMOUNT)} across ${TERMS.length} rungs — the treasurer signs`)

  const instructions = buildLadderSetup({
    owner: treasurer.publicKey,
    market,
    seed: 0n,
    sourceToken,
    amount: AMOUNT,
    distribution,
    maturities,
    rollPolicy: 'none',
    programId,
  })

  const latest = await connection.getLatestBlockhash('confirmed')
  const transaction = new Transaction({ feePayer: treasurer.publicKey, ...latest })
  transaction.add(...instructions)
  transaction.sign(treasurer)

  const signature = await connection.sendRawTransaction(transaction.serialize())
  const outcome = await connection.confirmTransaction({ signature, ...latest }, 'confirmed')
  if (outcome.value.err) {
    throw new Error(`deposit failed: ${JSON.stringify(outcome.value.err)}`)
  }
  const confirmedAt = Date.now()

  console.log(`  signature ${signature}`)
  console.log(`  transaction size ${transaction.serialize().length} bytes of 1232`)

  // SC-001: one user confirmation. One transaction, one signature in it —
  // and the ladder is opened by the same signature that funds it.
  check(
    transaction.signatures.length === 1,
    `SC-001 · signatures in the transaction: ${transaction.signatures.length} (need 1)`,
  )

  let view: LadderView | null = null
  let readAt = 0
  while (Date.now() - confirmedAt < CHART_DEADLINE_MS) {
    const attempt = await fetchLadder(connection, treasurer.publicKey, 0n, programId)
    if (attempt.rungs.length === TERMS.length) {
      view = attempt
      readAt = Date.now()
      break
    }
  }

  if (!view) {
    check(false, `SC-001 · the ladder did not assemble within ${CHART_DEADLINE_MS / 1000} s`)
    report()
    return
  }

  const elapsed = readAt - confirmedAt
  check(
    elapsed < CHART_DEADLINE_MS,
    `SC-001 · chart data ready in ${(elapsed / 1000).toFixed(2)} s (limit ${CHART_DEADLINE_MS / 1000} s)`,
  )

  // The program measures the term from the block the deposit landed in, not in whole days.
  // Without that time the two mirrors cannot be compared honestly: the difference between
  // them would turn out to be a difference of moments, not of arithmetic.
  const landed = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })
  const landedAt = landed?.blockTime
  if (landedAt === undefined || landedAt === null) {
    throw new Error('the validator did not return the deposit block time')
  }

  console.log('\nRungs on chain versus the math — on the same term')
  view.rungs.forEach((rung, index) => {
    const rateBps = RATES_BPS[index]
    const expected = preview[index]
    if (rateBps === undefined || expected === undefined) throw new Error('rung outside the preview')

    const mirrored = promise(rung.rung.deposited, rateBps, Number(rung.epoch.maturityTs) - landedAt)
    const same = rung.rung.promised === mirrored && rung.rung.deposited === expected.working

    check(
      same,
      `  +${TERMS[index]} d · at work ${units(rung.rung.deposited)} · promised ${units(rung.rung.promised)}` +
        (same ? '' : ` ≠ ${units(mirrored)} per packages/math`),
    )
  })

  // The form preview counts in whole days from the moment the treasurer looks
  // at it; the program in seconds from the block. The discrepancy is not an error on
  // either side, but it exists, and it is better known as a number.
  const drift = preview.reduce((sum, expected, index) => {
    const rung = view?.rungs[index]

    return rung ? sum + (expected.promised - rung.rung.promised) : sum
  }, 0n)

  console.log(
    `  form preview is above the chain by ${units(drift)} — that much accrues over ${landedAt - chainNow} s` +
      ' between looking at the preview and confirming',
  )

  // SC-005: the same thing the chart reads, folded into months — against the promises on
  // chain. The projection horizon is 12 months (FR-008), and a 365-day rung does not
  // fit in it: it lands in `outsideHorizon`. That is why two equalities are checked
  // rather than one — otherwise "the total matched" would mean "the total matched
  // what we ourselves decided to show".
  const forecast = projectCashflow({
    fromTs: chainNow,
    months: 12,
    rungs: view.rungs.map(({ rung, epoch }) => ({
      maturityTs: Number(epoch.maturityTs),
      promised: rung.promised,
      settled: null,
    })),
    // The script does not read the floating part — just like the dashboard in network mode:
    // the treasury wallet balance is not the same state.
    floating: { amount: 0n, rateBps: 0 },
  })

  const horizonEnds = forecast.months.at(-1)?.endTs ?? 0
  const charted = forecast.months.reduce((sum, month) => sum + month.guaranteed, 0n)
  const outside = forecast.outsideHorizon.guaranteed
  const onChain = view.rungs.reduce((sum, rung) => sum + rung.rung.promised, 0n)
  const gap =
    charted + outside > onChain ? charted + outside - onChain : onChain - charted - outside

  console.log('\nSC-005 · chart versus chain')
  check(
    gap === 0n,
    `  on the chart ${units(charted)} + beyond the horizon ${units(outside)} = ${units(charted + outside)} versus ${units(onChain)} on chain · drift ${units(gap)}`,
  )
  check(
    charted ===
      view.rungs
        .filter(({ epoch }) => Number(epoch.maturityTs) < horizonEnds)
        .reduce((sum, rung) => sum + rung.rung.promised, 0n),
    '  the chart months hold exactly the rungs that mature inside the horizon',
  )

  const totalWorking = view.rungs.reduce((sum, rung) => sum + rung.rung.deposited, 0n)
  const totalFee = view.rungs.reduce((sum, rung) => sum + rung.rung.feePaid, 0n)
  check(
    totalWorking + totalFee === AMOUNT,
    `  at work ${units(totalWorking)} + fee ${units(totalFee)} = ${units(totalWorking + totalFee)} of ${units(AMOUNT)}`,
  )

  console.log(
    `\nLadder yield: ${units(onChain - totalWorking)} earned on ${units(totalWorking)} at work`,
  )
  console.log(`Market ${market.toBase58()} · ladder ${view.address.toBase58()}`)
  console.log(
    `\nTo make the dashboard show exactly this state: VITE_RPC_URL=${stand.rpc} VITE_MARKET=${market.toBase58()}`,
  )

  report()
}

function report(): void {
  console.log(
    '\nSC-005 is deliberately half-closed: there are no redemptions in M1, and "rungs actually redeemed"' +
      ' arrive together with redeem_rung (US2, T044).',
  )

  if (failures.length > 0) {
    console.error(`\nchecks failed: ${failures.length}`)
    process.exitCode = 1
    return
  }

  console.log('\nall checks passed')
}

main().catch((error: unknown) => {
  console.error(`\nthe run did not finish: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
