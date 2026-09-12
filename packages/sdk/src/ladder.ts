import { BN, BorshInstructionCoder, type Idl, utils } from '@coral-xyz/anchor'
import {
  ComputeBudgetProgram,
  type Connection,
  type PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import type { Distribution } from '@treasury-runway/math'
import {
  decodeEpoch,
  decodeLadder,
  decodeRung,
  type Epoch,
  type Ladder,
  PROGRAM_ID,
  type RollPolicy,
  type Rung,
  rungDiscriminator,
} from './accounts.js'
import idl from './idl/treasury_runway.json' with { type: 'json' }
import {
  bufferVaultAddress,
  epochAddress,
  ladderAddress,
  rungAddress,
  vaultAddress,
} from './pda.js'

const coder = new BorshInstructionCoder(idl as Idl)

/**
 * How many rungs fit in one signature. Measured, not estimated:
 * `programs/treasury-runway/tests/deposit_limits.rs` pins this number with a test.
 * The twelfth rung pushes the transaction past 1232 bytes.
 *
 * The same number holds together with `open_ladder` too: the added instruction costs
 * 24 bytes, because all four of its accounts are already in the deposit message. At the
 * ceiling that is 1209 bytes of 1232 — enough headroom for a priority fee as well (12 more).
 * Both numbers are measured by `test/ladder.test.ts`, not computed by this formula.
 */
export const MAX_RUNGS_PER_DEPOSIT = 11

/**
 * The deposit no longer fits in the default 200k compute units by the fifth rung, so
 * the budget request is not an optimisation but a condition of execution. The margin over
 * the measured (~20k per rung) is deliberate: unused units are not charged, while
 * running short costs the transaction.
 *
 * Opening the ladder is a separate term because it also spends compute from
 * the same ceiling: the limit applies to the transaction, not the instruction.
 */
function computeUnitLimit(rungs: number, opensLadder: boolean): number {
  return 50_000 + 25_000 * rungs + (opensLadder ? 25_000 : 0)
}

export type LadderDepositParams = {
  owner: PublicKey
  market: PublicKey
  /** The ladder's sequence number for the owner — the same one as in the seeds. */
  seed: bigint
  /** The treasury account the funds leave from. */
  sourceToken: PublicKey
  amount: bigint
  distribution: Distribution
  /** Maturity dates, one per rung, in deposit order. */
  maturities: readonly bigint[]
  programId?: PublicKey
}

/**
 * The deposit instructions: the budget request and the deposit itself (FR-005).
 *
 * The ladder must already exist. If the treasurer is depositing for the first time —
 * `buildLadderSetup`: opening and depositing in one signature.
 */
export function buildLadderDeposit(params: LadderDepositParams): TransactionInstruction[] {
  const rungs = checkedRungCount(params)

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit(rungs, false) }),
    depositInstruction(params),
  ]
}

export type OpenLadderParams = {
  owner: PublicKey
  market: PublicKey
  seed: bigint
  /** What happens to the funds once the rung is redeemed (FR-013, FR-014). */
  rollPolicy: RollPolicy
  programId?: PublicKey
}

/**
 * Opening the ladder is a separate instruction without a budget request: initialising
 * one account stays well within the default 200k, and an extra request
 * would cost bytes in a packet where they are counted.
 */
export function buildOpenLadder(params: OpenLadderParams): TransactionInstruction {
  const programId = params.programId ?? PROGRAM_ID

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.owner, isSigner: true, isWritable: true },
      { pubkey: params.market, isSigner: false, isWritable: false },
      {
        pubkey: ladderAddress(programId, params.owner, params.seed),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: coder.encode('open_ladder', {
      seed: new BN(params.seed.toString()),
      roll_policy: encodeRollPolicy(params.rollPolicy),
    }),
  })
}

export type LadderSetupParams = LadderDepositParams & Pick<OpenLadderParams, 'rollPolicy'>

/**
 * The treasurer's first deposit: open the ladder and put funds into it —
 * **in one signature**.
 *
 * With two signatures this would be more than inconvenient. `ladder_deposit` requires an
 * already created ladder (`Account<'info, Ladder>`), so between two signatures there is
 * a state "ladder exists, no funds in it": the treasurer paid the account rent and
 * saw an empty dashboard if the second signature never landed. FR-005 promises
 * the deposit as a single action, and the boundary of that action is the transaction, not a click.
 *
 * The rung ceiling here is the same as for the deposit alone: `open_ladder` adds
 * no new account to the message — only its own 24 bytes.
 */
export function buildLadderSetup(params: LadderSetupParams): TransactionInstruction[] {
  const rungs = checkedRungCount(params)

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit(rungs, true) }),
    buildOpenLadder(params),
    depositInstruction(params),
  ]
}

/** The deposit instruction itself, without the budget: its size depends on its neighbours. */
function depositInstruction(params: LadderDepositParams): TransactionInstruction {
  const programId = params.programId ?? PROGRAM_ID
  const ladder = ladderAddress(programId, params.owner, params.seed)

  const keys = [
    { pubkey: params.owner, isSigner: true, isWritable: true },
    { pubkey: params.market, isSigner: false, isWritable: false },
    { pubkey: ladder, isSigner: false, isWritable: true },
    { pubkey: vaultAddress(programId, params.market), isSigner: false, isWritable: true },
    { pubkey: bufferVaultAddress(programId, params.market), isSigner: false, isWritable: true },
    { pubkey: params.sourceToken, isSigner: false, isWritable: true },
    { pubkey: utils.token.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]

  // An "epoch, rung" pair for every date, in the same order as the deposit
  // parts: the program reads them by index, not by name.
  for (const maturity of params.maturities) {
    const epoch = epochAddress(programId, params.market, maturity)
    keys.push({ pubkey: epoch, isSigner: false, isWritable: true })
    keys.push({ pubkey: rungAddress(programId, ladder, epoch), isSigner: false, isWritable: true })
  }

  const data = coder.encode('ladder_deposit', {
    amount: new BN(params.amount.toString()),
    distribution: encodeDistribution(params.distribution),
  })

  return new TransactionInstruction({ programId, keys, data })
}

/**
 * How many rungs are in the deposit — and whether it is allowed to go out at all.
 *
 * The checks here duplicate the onchain refusals on purpose. The program would say the
 * same, but after signing — and the treasurer must see the error before it.
 */
function checkedRungCount(params: LadderDepositParams): number {
  const rungs = rungCount(params.distribution)

  if (params.amount <= 0n) {
    throw new RangeError('deposit amount must be greater than zero')
  }
  if (rungs !== params.maturities.length) {
    throw new RangeError(
      `deposit has ${rungs} rungs but ${params.maturities.length} maturity dates`,
    )
  }
  if (rungs > MAX_RUNGS_PER_DEPOSIT) {
    throw new RangeError(
      `${rungs} rungs do not fit in one signature: the limit is ${MAX_RUNGS_PER_DEPOSIT}`,
    )
  }

  return rungs
}

function rungCount(distribution: Distribution): number {
  return distribution.kind === 'even' ? distribution.rungs : distribution.weightsBps.length
}

/** The same `Distribution` the preview computes with — in the shape the IDL expects. */
function encodeDistribution(distribution: Distribution): Record<string, unknown> {
  return distribution.kind === 'even'
    ? { Even: { rungs: distribution.rungs } }
    : { Weighted: { weights_bps: [...distribution.weightsBps] } }
}

/** Outward the policy is a string (`decodeLadder`), in the IDL a variant without fields. */
function encodeRollPolicy(policy: RollPolicy): Record<string, unknown> {
  return policy === 'roll' ? { Roll: {} } : { None: {} }
}

/** A rung together with its epoch: apart they mean nothing. */
export type RungView = {
  address: PublicKey
  rung: Rung
  epoch: Epoch
}

export type LadderView = {
  address: PublicKey
  ladder: Ladder
  /** By maturity date — in the order the treasurer sees them. */
  rungs: RungView[]
}

/**
 * There is no ladder at the address. A separate type rather than a plain `Error`: "the
 * treasurer has not laddered anything yet" is a normal dashboard state, not a read failure,
 * and telling them apart by message text would mean comparing strings.
 */
export class LadderNotFoundError extends Error {
  constructor(readonly address: PublicKey) {
    super(`ladder ${address.toBase58()} is not on the network`)
    this.name = 'LadderNotFoundError'
  }
}

/**
 * The network methods needed to read a ladder. Narrower than `Connection`
 * on purpose: the test substitutes responses here rather than running a validator.
 */
export type LadderReader = Pick<
  Connection,
  'getAccountInfo' | 'getProgramAccounts' | 'getMultipleAccountsInfo'
>

/**
 * The ladder with all its rungs and epochs — the single structure consumed
 * by both the dashboard and the keeper.
 *
 * Rungs are looked up by the owning ladder inside the account itself, not by iterating
 * epochs: iteration would only know the epochs the client guessed, and would silently
 * lose a rung created by a roll.
 */
export async function fetchLadder(
  connection: LadderReader,
  owner: PublicKey,
  seed: bigint,
  programId: PublicKey = PROGRAM_ID,
): Promise<LadderView> {
  const address = ladderAddress(programId, owner, seed)

  const account = await connection.getAccountInfo(address)
  if (!account) {
    throw new LadderNotFoundError(address)
  }

  const ladder = decodeLadder(account.data)

  const raw = await connection.getProgramAccounts(programId, {
    filters: [
      { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(rungDiscriminator()) } },
      { memcmp: { offset: 8, bytes: address.toBase58() } },
    ],
  })

  const rungs = raw.map((item) => ({
    address: item.pubkey,
    rung: decodeRung(item.account.data),
  }))

  const epochs = await connection.getMultipleAccountsInfo(rungs.map((r) => r.rung.epoch))

  const view = rungs.map((entry, index) => {
    const epoch = epochs[index]
    if (!epoch) {
      throw new Error(`epoch of rung ${entry.address.toBase58()} is not on the network`)
    }

    return { ...entry, epoch: decodeEpoch(epoch.data) }
  })

  view.sort((a, b) => Number(a.epoch.maturityTs - b.epoch.maturityTs))

  return { address, ladder, rungs: view }
}
