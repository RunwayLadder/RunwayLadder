/**
 * The US2 end-to-end run on a local validator: SC-006 and SC-003 with numbers, and the second
 * half of SC-005 that T033 could not measure without redemptions.
 *
 * Who does what — the point of the run is that the treasurer's ladder needs no one:
 *
 * - **The keeper** runs as its own process (`apps/keeper`, loop mode), exactly as it would be
 *   hosted. The run never calls the crank itself; it only watches the chain.
 * - **The operator** (the stand's authority) opens one date per period, half a period before the
 *   next maturity: `roll_rung` puts funds into the market's furthest epoch, so a calendar opened
 *   all at once would pull every rolled rung onto its last date and the ladder would stop being
 *   a ladder. Opening the dates is the operator's word on the rate, not the treasurer's action.
 * - **The treasurer** signs two deposits and then, for ladder N only, four redemptions.
 *
 * Two ladders on the same calendar:
 *
 * - **R** — 4 rungs with `policy=Roll`. SC-006: two full cycles (every rung rolled twice) with no
 *   signature of the treasurer after the deposit, and after each cycle still 4 open rungs on
 *   4 distinct dates one period apart.
 * - **N** — 4 rungs without the policy, redeemed by the owner. SC-003 is the cycle the spec names:
 *   "a deposit across 4 rungs + 4 redemptions". Fees are summed from `meta.fee` of every
 *   transaction in it, whoever paid — the keeper's settlements of those four epochs included.
 *   Rent is printed apart, as what it is: no instruction closes a rung or a ladder, so today it
 *   does not come back. It is not a fee and is not hidden either.
 *
 * The stand is brought up by `scripts/e2e-stand.sh`. The run takes about ten minutes of chain
 * time: the validator's clock cannot be moved forward, so the periods are real seconds.
 *
 * Every fee and every signer is read **as the run goes**, not at its end: the test validator
 * keeps a short ledger, and a transaction ten minutes old is no longer there to read. A read
 * that comes too late fails the run with that reason rather than counting fewer transactions.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { projectCashflow } from '@runway-ladder/math'
import {
  buildCreateEpoch,
  buildInitMarket,
  buildLadderSetup,
  buildRedeemRung,
  epochAddress,
  fetchEpochs,
  fetchLadder,
  type LadderView,
  marketAddress,
  sourceReserveAddress,
} from '@runway-ladder/sdk'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'

/** One period between dates. Long next to the keeper's tick, short enough for a ten-minute run. */
const PERIOD = 60
/** Seconds from setup to the first period's start: room for the market and both deposits. */
const LEAD = 20
const RUNGS = 4
const CYCLES = 2
const KEEPER_INTERVAL_SECONDS = 5

const FEE_BPS = 25
const MIN_RUNG = 10_000_000n
/** Above the epochs' rate: with the reserve topped up, the source alone covers each promise. */
const SOURCE_RATE_BPS = 1_200
const EPOCH_RATE_BPS = 800
const DECIMALS = 6
const AMOUNT = 400_000_000_000n
const RESERVE_TOP_UP = 1_000_000_000n

/**
 * The SOL price the dollar verdict is stated at — deliberately above the market, so a pass
 * here is not an artefact of a cheap SOL. The run also prints the price at which it would fail.
 */
const SOL_USD = 250
const SC003_LIMIT_USD = 0.1

/** The base fee per signature on mainnet — what SC-003 is about. */
const LAMPORTS_PER_SIGNATURE = 5_000
/** How long a fresh validator may take before it starts charging fees. */
const FEE_WARM_UP_MS = 120_000

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

type Stand = {
  rpc: string
  programId: string
  mint: string
  authority: string
  treasurer: string
  sourceToken: string
}

const repoDir = fileURLToPath(new URL('../', import.meta.url))
const standDir = fileURLToPath(new URL('../.e2e/', import.meta.url))

function readStand(): Stand {
  try {
    return JSON.parse(readFileSync(`${standDir}stand.json`, 'utf8')) as Stand
  } catch {
    throw new Error('no stand — run `bash scripts/e2e-stand.sh` first (validator in WSL)')
  }
}

function keypair(file: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${standDir}${file}`, 'utf8')) as number[]),
  )
}

const units = (value: bigint): string => {
  const scale = 10n ** BigInt(DECIMALS)
  const sign = value < 0n ? '-' : ''
  const abs = value < 0n ? -value : value
  const rest = (abs % scale).toString().padStart(DECIMALS, '0')

  return `${sign}${(abs / scale).toLocaleString('en-US')}.${rest}`
}

const sol = (lamports: number): string => (lamports / LAMPORTS_PER_SOL).toFixed(9)

/** SPL Token `Transfer` (instruction 3): the stand needs nothing else from the token program. */
function tokenTransfer(
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9)
  data.writeUInt8(3, 0)
  data.writeBigUInt64LE(amount, 1)

  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  })
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

  const send = (signers: Keypair[], ...instructions: TransactionInstruction[]) =>
    sendAndConfirmTransaction(connection, new Transaction().add(...instructions), signers, {
      commitment: 'confirmed',
    })

  /** The validator's clock, as the program reads it — not the Windows one. */
  const chainNow = async (): Promise<number> => {
    const time = await connection.getBlockTime(await connection.getSlot('confirmed'))
    if (time === null) throw new Error('the validator did not return the block time')
    return time
  }
  const until = async (ts: number): Promise<void> => {
    while ((await chainNow()) < ts) await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  // A fresh test validator charges nothing for its first ~80 slots: a deposit landing there
  // would enter SC-003 at zero. The run starts measuring only once the chain charges what
  // mainnet does — and still checks every fee it counts.
  await feesCharged(connection, authority)

  const market = marketAddress(programId, assetMint, 'deterministic')
  if (await connection.getAccountInfo(market)) {
    throw new Error('the market already exists — this run needs a fresh stand')
  }

  console.log(`Market, ${RUNGS} dates one period (${PERIOD} s) apart — operator signs`)
  await send(
    [authority],
    buildInitMarket({
      authority: authority.publicKey,
      assetMint,
      source: { kind: 'deterministic', rateBps: SOURCE_RATE_BPS },
      feeBps: FEE_BPS,
      minRungAmount: MIN_RUNG,
      programId,
    }),
  )

  const base = (await chainNow()) + LEAD
  const dateOf = (k: number): bigint => BigInt(base + k * PERIOD)
  const openDate = (k: number) =>
    send(
      [authority],
      buildCreateEpoch({
        authority: authority.publicKey,
        market,
        maturityTs: dateOf(k),
        rateBps: EPOCH_RATE_BPS,
        programId,
      }),
    )
  for (let k = 1; k <= RUNGS; k += 1) await openDate(k)

  // The source's yield arrives before anything else: it is the stand playing the source, and it
  // touches neither ladder.
  await send(
    [treasurer],
    tokenTransfer(
      sourceToken,
      sourceReserveAddress(programId, market),
      treasurer.publicKey,
      RESERVE_TOP_UP,
    ),
  )

  console.log('\nTwo deposits — the treasurer signs')
  const firstDates = Array.from({ length: RUNGS }, (_, i) => dateOf(i + 1))
  const deposit = (seed: bigint, rollPolicy: 'roll' | 'none') =>
    send(
      [treasurer],
      ...buildLadderSetup({
        owner: treasurer.publicKey,
        market,
        seed,
        sourceToken,
        amount: AMOUNT,
        distribution: { kind: 'even', rungs: RUNGS },
        maturities: firstDates,
        rollPolicy,
        programId,
      }),
    )
  const depositR = await deposit(1n, 'roll')
  const depositN = await deposit(2n, 'none')
  console.log(`  R (roll) ${depositR}\n  N (none) ${depositN}`)

  const ladderR = (await fetchLadder(connection, treasurer.publicKey, 1n, programId)).address
  const viewN = await fetchLadder(connection, treasurer.publicKey, 2n, programId)

  /** Fees of N's cycle, by signature — read right after each transaction lands. */
  const cycleFees = new Map<string, number>([
    [depositN, (await transactionOf(connection, depositN)).fee],
  ])
  const settlements: string[] = []
  /** Every transaction on ladder R after the deposit: who signed it, and what a roll paid. */
  const seenOnR = new Set([depositR])
  const onR = { transactions: 0, byTreasurer: 0, rollFees: [] as number[] }

  // SC-005, the half T033 could not have: what the chart shows for N now, before anything is
  // paid, against what the owner's account actually receives at the end.
  const forecast = projectCashflow({
    fromTs: await chainNow(),
    months: 12,
    rungs: viewN.rungs.map(({ rung, epoch }) => ({
      maturityTs: Number(epoch.maturityTs),
      promised: rung.promised,
      settled: null,
    })),
    floating: { amount: 0n, rateBps: 0 },
  })
  const charted =
    forecast.months.reduce((sum, month) => sum + month.guaranteed, 0n) +
    forecast.outsideHorizon.guaranteed

  const keeperKey = Keypair.generate()
  await connection.confirmTransaction(
    await connection.requestAirdrop(keeperKey.publicKey, 2 * LAMPORTS_PER_SOL),
    'confirmed',
  )
  const keeper = startKeeper(stand, market, keeperKey)

  const redemptions: { signature: string; received: bigint; promised: bigint }[] = []
  try {
    console.log(`\nKeeper ${keeperKey.publicKey.toBase58()} runs on its own; the run only watches`)

    // Half a period before date k the previous date has matured, been settled and rolled by the
    // keeper, and date k has not matured yet: the one moment to open date k + RUNGS so that the
    // rung maturing at k goes exactly one horizon forward.
    for (let k = 1; k <= RUNGS * CYCLES; k += 1) {
      await until(Number(dateOf(k)) - PERIOD / 2)

      if (k > 1) {
        await afterMaturity(k - 1)
      }
      await openDate(k + RUNGS)
      console.log(`  date ${k + RUNGS} opened (${dateOf(k + RUNGS)})`)
      if (k === RUNGS + 1) await cycleShape(1)
    }

    await until(Number(dateOf(RUNGS * CYCLES)) + PERIOD / 2)
    await afterMaturity(RUNGS * CYCLES)
    await cycleShape(2)
  } finally {
    keeper.child.kill()
    await keeper.exited
  }

  /** Date k matured: the keeper settled it and rolled R's rung; N's rung is redeemed by hand. */
  async function afterMaturity(k: number): Promise<void> {
    const address = epochAddress(programId, market, dateOf(k))
    const epoch = (await fetchEpochs(connection, market, programId)).find((e) =>
      e.address.equals(address),
    )
    const settledBy = await settlementOf(address)
    check(
      epoch?.epoch.status.kind === 'settled' && settledBy !== null,
      `date ${k}: settled by the keeper (${epoch?.epoch.status.kind ?? 'missing'})`,
    )
    if (settledBy && k <= RUNGS) {
      settlements.push(settledBy.signature)
      cycleFees.set(settledBy.signature, settledBy.fee)
    }
    await watchR()

    const r = await fetchLadder(connection, treasurer.publicKey, 1n, programId)
    const left = r.rungs.filter(
      (entry) => entry.epoch.maturityTs === dateOf(k) && entry.rung.status.kind === 'active',
    )
    check(left.length === 0, `date ${k}: R has no rung left there — rolled forward`)

    if (k > RUNGS) return

    const rung = viewN.rungs.find((entry) => entry.epoch.maturityTs === dateOf(k))
    if (!rung) throw new Error(`ladder N has no rung on date ${k}`)

    const before = BigInt((await connection.getTokenAccountBalance(sourceToken)).value.amount)
    const signature = await send(
      [treasurer],
      buildRedeemRung({
        owner: treasurer.publicKey,
        market,
        ladder: viewN.address,
        epoch: rung.rung.epoch,
        rungIndex: rung.rung.index,
        destination: sourceToken,
        programId,
      }),
    )
    const after = BigInt((await connection.getTokenAccountBalance(sourceToken)).value.amount)
    cycleFees.set(signature, (await transactionOf(connection, signature)).fee)
    redemptions.push({ signature, received: after - before, promised: rung.rung.promised })
    check(
      after - before === rung.rung.promised,
      `date ${k}: N rung ${rung.rung.index} redeemed for ${units(after - before)} of ${units(rung.rung.promised)} promised`,
    )
  }

  /** The keeper's `settle_epoch` on this epoch, if it is the keeper that settled it. */
  async function settlementOf(
    epoch: PublicKey,
  ): Promise<{ signature: string; fee: number } | null> {
    for (const { signature } of await connection.getSignaturesForAddress(
      epoch,
      undefined,
      'confirmed',
    )) {
      const tx = await transactionOf(connection, signature)
      if (tx.instruction === 'SettleEpoch' && tx.signers[0]?.equals(keeperKey.publicKey)) {
        return { signature, fee: tx.fee }
      }
    }
    return null
  }

  /** New transactions on ladder R since the last look. */
  async function watchR(): Promise<void> {
    for (const { signature } of await connection.getSignaturesForAddress(
      ladderR,
      undefined,
      'confirmed',
    )) {
      if (seenOnR.has(signature)) continue
      seenOnR.add(signature)
      const tx = await transactionOf(connection, signature)
      onR.transactions += 1
      if (tx.signers.some((key) => key.equals(treasurer.publicKey))) onR.byTreasurer += 1
      if (tx.instruction === 'RollRung' && tx.signers[0]?.equals(keeperKey.publicKey)) {
        onR.rollFees.push(tx.fee)
      }
    }
  }

  /** After cycle c: still a ladder — 4 open rungs on the next 4 dates, one period apart. */
  async function cycleShape(c: number): Promise<void> {
    const r = await fetchLadder(connection, treasurer.publicKey, 1n, programId)
    const open = r.rungs.filter((entry) => entry.rung.status.kind === 'active')
    const dates = open.map((entry) => entry.epoch.maturityTs).sort((a, b) => Number(a - b))
    const expected = Array.from({ length: RUNGS }, (_, i) => dateOf(c * RUNGS + i + 1))
    const rolled = r.rungs.filter((entry) => entry.rung.status.kind === 'rolled').length

    console.log(`\nSC-006 · after cycle ${c}`)
    check(
      dates.length === RUNGS && dates.every((date, i) => date === expected[i]),
      `  open rungs on dates ${c * RUNGS + 1}…${c * RUNGS + RUNGS}: ${dates.join(', ')}`,
    )
    check(rolled === c * RUNGS, `  rolled ${rolled} of ${c * RUNGS} (none with a deficit)`)
  }

  const finalR = await fetchLadder(connection, treasurer.publicKey, 1n, programId)
  console.log('\nSC-006 · lineage and authorship')
  checkLineage(finalR)
  check(
    onR.rollFees.length === RUNGS * CYCLES && onR.byTreasurer === 0,
    `  ${onR.transactions} transactions on R after the deposit: ${onR.rollFees.length} rolls by the keeper, ` +
      `${onR.byTreasurer} signed by the treasurer`,
  )

  const keeperLog = keeper.lines.join('')
  writeFileSync(`${standDir}keeper.log`, keeperLog)
  const keeperFailures = keeper.lines.filter((line) => line.includes(' FAIL '))
  check(keeperFailures.length === 0, `  keeper log: ${keeperFailures.length} FAIL line(s)`)

  // SC-003: every transaction of N's cycle, whoever paid for it.
  const cycle = [depositN, ...settlements, ...redemptions.map((r) => r.signature)]
  const fees = cycle.map((signature) => cycleFees.get(signature) ?? 0)
  const totalFee = fees.reduce((sum, fee) => sum + fee, 0)
  const usd = (totalFee / LAMPORTS_PER_SOL) * SOL_USD
  const breakEven = (SC003_LIMIT_USD * LAMPORTS_PER_SOL) / totalFee

  const rentAccounts = [viewN.address, ...viewN.rungs.map((entry) => entry.address)]
  const rent = (await connection.getMultipleAccountsInfo(rentAccounts)).reduce(
    (sum, account) => sum + (account?.lamports ?? 0),
    0,
  )

  console.log('\nSC-003 · network fees of the cycle "deposit across 4 rungs + 4 redemptions"')
  console.log(
    `  ${cycle.length} transactions: 1 deposit, ${settlements.length} settlements (keeper), ` +
      `${redemptions.length} redemptions — fees ${fees.join(' + ')} lamports`,
  )
  check(
    settlements.length === RUNGS && redemptions.length === RUNGS,
    `  the cycle is complete: ${settlements.length} settlements, ${redemptions.length} redemptions`,
  )
  check(
    fees.every((fee) => fee >= LAMPORTS_PER_SIGNATURE),
    `  every transaction paid at least ${LAMPORTS_PER_SIGNATURE} lamports — none landed fee-free`,
  )
  check(
    usd < SC003_LIMIT_USD,
    `  fees ${totalFee} lamports = ${sol(totalFee)} SOL = $${usd.toFixed(5)} at $${SOL_USD}/SOL ` +
      `(limit $${SC003_LIMIT_USD}; fails only above $${breakEven.toFixed(0)}/SOL)`,
  )
  console.log(
    `  rent, not a fee and not returned today (no instruction closes a rung or a ladder): ` +
      `${rent} lamports = ${sol(rent)} SOL = $${((rent / LAMPORTS_PER_SOL) * SOL_USD).toFixed(4)} ` +
      `at $${SOL_USD}/SOL — ladder + ${viewN.rungs.length} rungs`,
  )

  const created = finalR.rungs.filter((entry) => entry.rung.index >= RUNGS)
  const rollRent = (await connection.getMultipleAccountsInfo(created.map((e) => e.address))).map(
    (account) => account?.lamports ?? 0,
  )
  console.log(
    `  for reference — ${onR.rollFees.length} rolls cost the keeper ${onR.rollFees.join(' + ')} lamports ` +
      `in fees and ${rollRent[0] ?? 0} lamports of rent per new rung (${created.length} rungs, ` +
      `${rollRent.reduce((sum, r) => sum + r, 0)} in all)`,
  )

  console.log('\nSC-005 · chart versus what was actually redeemed (ladder N)')
  const received = redemptions.reduce((sum, r) => sum + r.received, 0n)
  const gap = charted > received ? charted - received : received - charted
  check(
    redemptions.length === RUNGS && gap === 0n,
    `  charted before redemption ${units(charted)} versus received ${units(received)} · drift ${units(gap)}`,
  )

  console.log(
    `\nMarket ${market.toBase58()} · ladder R ${ladderR.toBase58()} · N ${viewN.address.toBase58()}`,
  )

  if (failures.length > 0) {
    console.error(`\nchecks failed: ${failures.length}`)
    process.exitCode = 1
    return
  }
  console.log('\nall checks passed')
}

/**
 * The keeper as it is hosted: its own process, loop mode, its own key. Started through
 * `node --import tsx` rather than `pnpm start`, so that killing it kills it and not a wrapper.
 */
function startKeeper(
  stand: Stand,
  market: PublicKey,
  key: Keypair,
): { child: ChildProcess; lines: string[]; exited: Promise<void> } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RPC_URL: stand.rpc,
    PROGRAM_ID: stand.programId,
    KEEPER_MARKET: market.toBase58(),
    KEEPER_KEYPAIR: JSON.stringify(Array.from(key.secretKey)),
    KEEPER_INTERVAL_SECONDS: String(KEEPER_INTERVAL_SECONDS),
  }
  delete env.KEEPER_KEYPAIR_PATH

  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/keeper/src/index.ts'], {
    cwd: repoDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  child.stdout?.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')))
  child.stderr?.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')))
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))

  return { child, lines, exited }
}

/** Every original rung of R rolled exactly twice: original → first roll → second roll, open. */
function checkLineage(view: LadderView): void {
  const byAddress = new Map(view.rungs.map((entry) => [entry.address.toBase58(), entry]))
  for (const origin of view.rungs.filter((entry) => entry.rung.index < RUNGS)) {
    let entry = origin
    let depth = 0
    let carried = true
    while (entry.rung.status.kind === 'rolled') {
      const next = byAddress.get(entry.rung.status.into.toBase58())
      if (!next) break
      // The whole payout went on: the new rung works with it minus the issuance fee.
      carried &&= next.rung.deposited + next.rung.feePaid === entry.rung.status.amount
      carried &&= entry.rung.status.amount === entry.rung.promised
      entry = next
      depth += 1
    }
    check(
      depth === CYCLES && entry.rung.status.kind === 'active' && carried,
      `  rung ${origin.rung.index}: rolled ${depth} times, each time for its full promise, now ` +
        `${units(entry.rung.promised)} promised on ${entry.epoch.maturityTs}`,
    )
  }
}

/**
 * Waits until the validator actually charges a fee. Asked of a landed transaction, not of
 * `getFeeForMessage`: on a fresh validator that already quotes 5000 while blocks still land
 * fee-free, and a deposit trusted to it entered SC-003 at zero.
 */
async function feesCharged(connection: Connection, payer: Keypair): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < FEE_WARM_UP_MS) {
    const probe = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: payer.publicKey,
          lamports: 0,
        }),
      ),
      [payer],
      { commitment: 'confirmed' },
    )
    if ((await transactionOf(connection, probe)).fee >= LAMPORTS_PER_SIGNATURE) return
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`the validator charged no fees for ${FEE_WARM_UP_MS / 1000} s`)
}

/**
 * What the run needs from one landed transaction. A missing transaction is not skipped: the
 * test validator prunes its ledger, and a silent skip would count fewer fees than were paid.
 */
async function transactionOf(
  connection: Connection,
  signature: string,
): Promise<{ fee: number; signers: PublicKey[]; instruction: string | null }> {
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })
  if (!tx?.meta) {
    throw new Error(`transaction ${signature} is no longer in the validator's ledger`)
  }
  const message = tx.transaction.message
  const instruction =
    tx.meta.logMessages
      ?.map((line) => /^Program log: Instruction: (\w+)$/.exec(line)?.[1])
      .find((name) => name !== undefined) ?? null

  return {
    fee: tx.meta.fee,
    signers: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures),
    instruction: tx.meta.err ? null : instruction,
  }
}

main().catch((error: unknown) => {
  console.error(`\nthe run did not finish: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
