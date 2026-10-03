import {
  associatedTokenAddress,
  buildSettleEpoch,
  type Epoch,
  epochAddress,
  type LadderView,
  type Rung,
  type RungView,
  rungAddress,
} from '@runway-ladder/sdk'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { NO_PREVIEWS, type SettlementPreview } from '../src/lib/arrival'
import { redeemAction } from '../src/lib/redeem'

const owner = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
const stranger = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const programId = new PublicKey('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8')
const market = new PublicKey('Stake11111111111111111111111111111111111111')
const assetMint = new PublicKey('Vote111111111111111111111111111111111111111')
// Not derivable from the owner and seed: if the action re-derived the address, the
// instruction would point elsewhere and the test would see it.
const ladderAddress = new PublicKey('So11111111111111111111111111111111111111112')

const MATURITY = 1_800_000_000n
const epochKey = epochAddress(programId, market, MATURITY)

const epochOf = (status: Epoch['status']): Epoch => ({
  market,
  maturityTs: MATURITY,
  rateBps: 900,
  createdBy: owner,
  createdAt: MATURITY - 86_400n,
  totalDeposited: 300_000_000n,
  totalPromised: 300_000_000n,
  depositSeconds: 0n,
  redeemed: 0n,
  status,
  bump: 254,
})

const rungOf = (status: Rung['status'] = { kind: 'active' }): Rung => ({
  ladder: ladderAddress,
  epoch: epochKey,
  index: 3,
  deposited: 99_000_000n,
  promised: 100_000_000n,
  feePaid: 1_000_000n,
  status,
  bump: 253,
})

const entryOf = (rung: Rung, epoch: Epoch): RungView => ({
  address: rungAddress(programId, ladderAddress, rung.index),
  rung,
  epoch,
})

const view: LadderView = {
  address: ladderAddress,
  ladder: {
    owner,
    market,
    seed: 0n,
    rungCount: 4,
    rollPolicy: 'roll',
    createdAt: MATURITY - 86_400n,
    bump: 255,
  },
  rungs: [],
}

const context = (entry: RungView, overrides: Partial<Parameters<typeof redeemAction>[0]> = {}) => ({
  owner,
  view,
  entry,
  assetMint,
  nowSeconds: MATURITY + 60n,
  programId,
  previews: NO_PREVIEWS,
  ...overrides,
})

const ready = (action: ReturnType<typeof redeemAction>) => {
  if (action.kind !== 'ready') throw new Error(`expected ready, got: ${action.reason}`)
  return action
}

const keysOf = (action: ReturnType<typeof ready>, position: number) =>
  action.instructions[position]?.keys.map((key) => key.pubkey.toBase58())

describe('redeemAction', () => {
  it('redeems a rung of a settled epoch into the owner ATA, without settling again', () => {
    const action = ready(
      redeemAction(context(entryOf(rungOf(), epochOf({ kind: 'settled', paid: 300_000_000n })))),
    )

    expect(action.settlesEpoch).toBe(false)
    expect(action.instructions.map((ix) => ix.programId.toBase58())).toEqual([
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      programId.toBase58(),
    ])
    expect(action.destination.equals(associatedTokenAddress(owner, assetMint))).toBe(true)
    expect(action.outcome).toEqual({ kind: 'exact', amount: 100_000_000n, promised: 100_000_000n })
  })

  it('addresses the redemption by the read ladder, the rung epoch and the rung number', () => {
    const action = ready(
      redeemAction(context(entryOf(rungOf(), epochOf({ kind: 'settled', paid: 300_000_000n })))),
    )

    expect(keysOf(action, 1)).toEqual([
      owner.toBase58(),
      market.toBase58(),
      ladderAddress.toBase58(),
      epochKey.toBase58(),
      rungAddress(programId, ladderAddress, 3).toBase58(),
      expect.any(String), // the vault — derived by the SDK builder, covered by its own test
      associatedTokenAddress(owner, assetMint).toBase58(),
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ])
  })

  it('settles a matured epoch in the same signature, before the redemption', () => {
    const action = ready(redeemAction(context(entryOf(rungOf(), epochOf({ kind: 'active' })))))

    expect(action.settlesEpoch).toBe(true)
    expect(action.instructions).toHaveLength(3)
    expect(action.instructions[1]).toEqual(
      buildSettleEpoch({ market, maturityTs: MATURITY, programId }),
    )
    // Without a preview only the promise is known: the screen must not show it as the payout.
    expect(action.outcome).toEqual({ kind: 'atSettlement', promised: 100_000_000n })
  })

  /**
   * FR-011a on the one-signature path: the settlement happens inside the redemption, so the
   * program's answer for settling now is the only moment the treasurer can see a shortfall
   * before receiving it.
   */
  it('shows what settling now pays for an unsettled epoch, at the epoch ratio', () => {
    const previews = new Map<string, SettlementPreview>([
      [
        epochKey.toBase58(),
        {
          kind: 'previewed',
          status: { kind: 'settledWithDeficit', paid: 240_000_000n, deficit: 60_000_000n },
        },
      ],
    ])
    const action = ready(
      redeemAction(context(entryOf(rungOf(), epochOf({ kind: 'active' })), { previews })),
    )

    expect(action.settlesEpoch).toBe(true)
    expect(action.outcome).toEqual({
      kind: 'ifSettledNow',
      amount: 80_000_000n,
      promised: 100_000_000n,
    })
  })

  it('says why the amount is unknown when the settlement could not be previewed', () => {
    const previews = new Map<string, SettlementPreview>([
      [epochKey.toBase58(), { kind: 'failed', reason: 'the node is down' }],
    ])
    const action = ready(
      redeemAction(context(entryOf(rungOf(), epochOf({ kind: 'active' })), { previews })),
    )

    expect(action.outcome).toEqual({
      kind: 'atSettlement',
      promised: 100_000_000n,
      reason: 'the node is down',
    })
  })

  it('shows the epoch ratio, not the promise, for an epoch settled with a deficit', () => {
    const action = ready(
      redeemAction(
        context(
          entryOf(
            rungOf(),
            epochOf({ kind: 'settledWithDeficit', paid: 270_000_000n, deficit: 30_000_000n }),
          ),
        ),
      ),
    )

    expect(action.outcome).toEqual({ kind: 'exact', amount: 90_000_000n, promised: 100_000_000n })
  })

  it('opens exactly at the maturity second, as the program does', () => {
    const entry = entryOf(rungOf(), epochOf({ kind: 'active' }))

    expect(redeemAction(context(entry, { nowSeconds: MATURITY })).kind).toBe('ready')
    expect(redeemAction(context(entry, { nowSeconds: MATURITY - 1n }))).toEqual({
      kind: 'blocked',
      reason: 'The rung matures on 2027-01-15 — redemption opens then.',
    })
  })

  it.each([
    ['no wallet', { owner: null }, 'Connect the owner wallet to redeem this rung.'],
    [
      'a wallet that is not the owner',
      { owner: stranger },
      'Only the ladder owner can redeem its rungs.',
    ],
  ] as const)('refuses %s before signing', (_, overrides, reason) => {
    const entry = entryOf(rungOf(), epochOf({ kind: 'settled', paid: 300_000_000n }))

    expect(redeemAction(context(entry, overrides))).toEqual({ kind: 'blocked', reason })
  })

  it('refuses a rung that is already closed', () => {
    const entry = entryOf(
      rungOf({ kind: 'redeemed', amount: 100_000_000n }),
      epochOf({ kind: 'settled', paid: 300_000_000n }),
    )

    expect(redeemAction(context(entry))).toEqual({
      kind: 'blocked',
      reason: 'This rung is already closed.',
    })
  })
})
