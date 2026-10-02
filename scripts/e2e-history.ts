/**
 * Real redemption and roll transactions for the history (T041, FR-015).
 *
 * The run produces what M1 never had: a rung redeemed at par by its owner and a rung rolled
 * by the crank with a marked deficit — on a local validator, with the program as deployed.
 * Their logs are written to `fixtures/events/` and become the input of the SDK decoder test:
 * a decoder checked only against bytes it encoded itself would be checking itself.
 *
 * How the two outcomes are made, without touching the program:
 *
 * - **Short epochs.** `create_epoch` only requires a maturity in the future, so two epochs
 *   mature within a minute. The third is a day away — the market's furthest, the roll target.
 * - **Deficit.** The market charges no fee, so the protocol buffer stays empty. The epoch whose
 *   source reserve is never topped up realizes principal only and cannot cover its promise:
 *   its rung is rolled `RolledWithDeficit`. The other epoch's reserve is topped up before
 *   settle, and its rung is redeemed at par.
 *
 * Needs a **fresh** stand (`bash scripts/e2e-stand.sh`): a market per mint is unique, and the
 * one US1 creates charges a fee.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  associatedTokenAddress,
  buildCreateEpoch,
  buildInitMarket,
  buildLadderSetup,
  buildRedeemRung,
  buildRollRung,
  buildSettleEpoch,
  epochAddress,
  fetchLadder,
  fetchRungClosure,
  marketAddress,
  rungAddress,
  sourceReserveAddress,
} from '@runway-ladder/sdk'
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'

/** Above the epochs' rate: with the reserve topped up, the source alone covers the promise. */
const SOURCE_RATE_BPS = 1_200
const MIN_RUNG = 10_000_000n
const AMOUNT = 750_000_000_000n
/** Seconds until the two short epochs mature, counted from the validator's clock. */
const SHORT_TERMS = [45, 50] as const
const LONG_TERM = 86_400
const RATE_BPS = 900
/** Enough to cover the par epoch's yield many times over; the rest goes to the buffer. */
const RESERVE_TOP_UP = 1_000_000_000n
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

type Stand = {
  rpc: string
  programId: string
  mint: string
  authority: string
  treasurer: string
  sourceToken: string
}

const standDir = fileURLToPath(new URL('../.e2e/', import.meta.url))
const fixturesDir = fileURLToPath(new URL('../fixtures/events/', import.meta.url))

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

/** Writes each transaction's logs next to what the test should find in them. */
async function captureLogs(
  connection: Connection,
  entries: { name: string; signature: string; fields: Record<string, string | null> }[],
): Promise<void> {
  console.log('\nLogs of the real transactions → fixtures/events/')
  mkdirSync(fixturesDir, { recursive: true })
  for (const { name, signature, fields } of entries) {
    const transaction = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    const logs = transaction?.meta?.logMessages
    if (!logs) throw new Error(`${name}: the validator returned no logs`)
    writeFileSync(`${fixturesDir}${name}.json`, `${JSON.stringify({ ...fields, logs }, null, 2)}\n`)
    console.log(`  ${name}.json · ${logs.length} lines`)
  }
}

/** The history read exactly as the dashboard reads it, against what the run did. */
async function verifyHistory(
  connection: Connection,
  programId: PublicKey,
  expected: {
    owner: PublicKey
    parRung: PublicKey
    deficitRung: PublicKey
    newRung: PublicKey
    destination: PublicKey
    redeemSignature: string
    rollSignature: string
  },
): Promise<void> {
  const par = await fetchRungClosure(connection, expected.parRung, programId)
  check(
    par.kind === 'found' &&
      par.closure.kind === 'redeemed' &&
      !par.closure.withDeficit &&
      par.closure.amount === par.closure.promised &&
      par.closure.destination.equals(expected.destination) &&
      par.signature === expected.redeemSignature,
    `rung 0 redeemed at par into the treasurer's account, found by its own signature`,
  )
  const rolled = await fetchRungClosure(connection, expected.deficitRung, programId)
  check(
    rolled.kind === 'found' &&
      rolled.closure.kind === 'rolled' &&
      rolled.closure.withDeficit &&
      rolled.closure.amount < rolled.closure.promised &&
      rolled.closure.into.equals(expected.newRung) &&
      rolled.signature === expected.rollSignature,
    'rung 1 rolled with a marked deficit into the new rung',
  )
  const after = await fetchLadder(connection, expected.owner, 0n, programId)
  const statuses = after.rungs.map((view) => `${view.rung.index}:${view.rung.status.kind}`)
  check(
    statuses.includes('0:redeemed') && statuses.includes('1:rolledWithDeficit'),
    `account statuses agree with the events: ${statuses.join(' ')}`,
  )
}

async function main(): Promise<void> {
  const stand = readStand()
  const connection = new Connection(stand.rpc, 'confirmed')
  const programId = new PublicKey(stand.programId)
  const assetMint = new PublicKey(stand.mint)
  const sourceToken = new PublicKey(stand.sourceToken)
  const authority = keypair(stand.authority)
  const treasurer = keypair(stand.treasurer)

  const send = async (label: string, signers: Keypair[], ...ixs: TransactionInstruction[]) => {
    const signature = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(...ixs),
      signers,
      {
        commitment: 'confirmed',
      },
    )
    console.log(`  ${label} · ${signature}`)

    return signature
  }
  const chainNow = async (): Promise<number> => {
    const time = await connection.getBlockTime(await connection.getSlot('confirmed'))
    if (time === null) throw new Error('the validator did not return the block time')
    return time
  }

  const market = marketAddress(programId, assetMint, 'deterministic')
  if (await connection.getAccountInfo(market)) {
    throw new Error('the market already exists — this run needs a fresh stand (no US1 before it)')
  }

  console.log('\nMarket without a fee, two short epochs and one far one')
  await send(
    'init_market',
    [authority],
    buildInitMarket({
      authority: authority.publicKey,
      assetMint,
      source: { kind: 'deterministic', rateBps: SOURCE_RATE_BPS },
      feeBps: 0,
      minRungAmount: MIN_RUNG,
      programId,
    }),
  )

  const now = await chainNow()
  const [parTs, deficitTs] = SHORT_TERMS.map((seconds) => BigInt(now + seconds))
  const longTs = BigInt(now + LONG_TERM)
  if (parTs === undefined || deficitTs === undefined) throw new Error('short epochs missing')
  for (const maturityTs of [parTs, deficitTs, longTs]) {
    await send(
      `create_epoch ${maturityTs}`,
      [authority],
      buildCreateEpoch({
        authority: authority.publicKey,
        market,
        maturityTs,
        rateBps: RATE_BPS,
        programId,
      }),
    )
  }

  console.log('\nThe treasurer ladders into all three, roll policy on')
  const latest = await connection.getLatestBlockhash('confirmed')
  const deposit = new Transaction({ feePayer: treasurer.publicKey, ...latest }).add(
    ...buildLadderSetup({
      owner: treasurer.publicKey,
      market,
      seed: 0n,
      sourceToken,
      amount: AMOUNT,
      distribution: { kind: 'even', rungs: 3 },
      maturities: [parTs, deficitTs, longTs],
      rollPolicy: 'roll',
      programId,
    }),
  )
  deposit.sign(treasurer)
  const depositSignature = await connection.sendRawTransaction(deposit.serialize())
  const landed = await connection.confirmTransaction(
    { signature: depositSignature, ...latest },
    'confirmed',
  )
  if (landed.value.err) throw new Error(`deposit failed: ${JSON.stringify(landed.value.err)}`)
  console.log(`  ladder_deposit · ${depositSignature}`)

  const until = Number(deficitTs) + 2
  process.stdout.write(`\nWaiting for the chain clock to pass ${until}`)
  while ((await chainNow()) < until) {
    process.stdout.write('.')
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  console.log()

  console.log(
    '\nSettle: the deficit epoch with an empty reserve, then top up and settle the par one',
  )
  await send(
    'settle_epoch (no reserve)',
    [authority],
    buildSettleEpoch({ market, maturityTs: deficitTs, programId }),
  )
  await send(
    'reserve top-up',
    [treasurer],
    tokenTransfer(
      sourceToken,
      sourceReserveAddress(programId, market),
      treasurer.publicKey,
      RESERVE_TOP_UP,
    ),
  )
  await send(
    'settle_epoch (reserve)',
    [authority],
    buildSettleEpoch({ market, maturityTs: parTs, programId }),
  )

  const ladder = await fetchLadder(connection, treasurer.publicKey, 0n, programId)
  const parRung = rungAddress(programId, ladder.address, 0)
  const deficitRung = rungAddress(programId, ladder.address, 1)
  const newRung = rungAddress(programId, ladder.address, ladder.ladder.rungCount)

  console.log('\nThe owner redeems rung 0, the crank rolls rung 1')
  const redeemSignature = await send(
    'redeem_rung',
    [treasurer],
    buildRedeemRung({
      owner: treasurer.publicKey,
      market,
      ladder: ladder.address,
      epoch: epochAddress(programId, market, parTs),
      rungIndex: 0,
      destination: associatedTokenAddress(treasurer.publicKey, assetMint),
      programId,
    }),
  )
  const rollSignature = await send(
    'roll_rung',
    [authority],
    buildRollRung({
      payer: authority.publicKey,
      market,
      ladder: ladder.address,
      epoch: epochAddress(programId, market, deficitTs),
      rungIndex: 1,
      target: epochAddress(programId, market, longTs),
      newRungIndex: ladder.ladder.rungCount,
      programId,
    }),
  )

  const base = { programId: programId.toBase58(), ladder: ladder.address.toBase58() }
  const none = { rung: null, into: null, destination: null }
  await captureLogs(connection, [
    { name: 'deposit', signature: depositSignature, fields: { ...base, ...none } },
    {
      name: 'redeem',
      signature: redeemSignature,
      fields: { ...base, ...none, rung: parRung.toBase58(), destination: sourceToken.toBase58() },
    },
    {
      name: 'roll',
      signature: rollSignature,
      fields: { ...base, ...none, rung: deficitRung.toBase58(), into: newRung.toBase58() },
    },
  ])

  console.log('\nThe history as the dashboard will read it — from each closed rung')
  await verifyHistory(connection, programId, {
    owner: treasurer.publicKey,
    parRung,
    deficitRung,
    newRung,
    destination: sourceToken,
    redeemSignature,
    rollSignature,
  })

  console.log(`\nVITE_RPC_URL=${stand.rpc} VITE_MARKET=${market.toBase58()}`)
  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed`)
    process.exitCode = 1
  } else {
    console.log('\nall checks passed')
  }
}

process.exitCode = await main().then(
  () => process.exitCode ?? 0,
  (error: unknown) => {
    console.error(error)
    return 1
  },
)
