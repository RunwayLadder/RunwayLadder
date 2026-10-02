import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor'
import { PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ID } from '../src/accounts.js'
import idl from '../src/idl/runway_ladder.json' with { type: 'json' }
import { buildSettleEpoch } from '../src/market.js'
import {
  bufferVaultAddress,
  epochAddress,
  rungAddress,
  sourceReserveAddress,
  vaultAddress,
} from '../src/pda.js'
import { buildRedeemRung, buildRollRung } from '../src/rung.js'

const owner = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
const market = new PublicKey('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8')
const ladder = new PublicKey('So11111111111111111111111111111111111111112')
const destination = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const maturity = 1_800_000_000n
const epoch = epochAddress(PROGRAM_ID, market, maturity)
const target = epochAddress(PROGRAM_ID, market, 1_900_000_000n)

/**
 * The keys are listed by hand, so only a comparison with the IDL notices when the program
 * changes an account's flags — or a fixed program address.
 */
function expectMatchesIdl(name: string, instruction: TransactionInstruction): void {
  const accounts = idl.instructions.find((ix) => ix.name === name)?.accounts
  if (!accounts) throw new Error(`${name} is not in the IDL`)

  expect(instruction.keys.map((k) => ({ signer: k.isSigner, writable: k.isWritable }))).toEqual(
    accounts.map((account) => ({
      signer: 'signer' in account && account.signer === true,
      writable: 'writable' in account && account.writable === true,
    })),
  )
  for (const [position, account] of accounts.entries()) {
    if ('address' in account && typeof account.address === 'string') {
      expect(instruction.keys[position]?.pubkey.toBase58()).toBe(account.address)
    }
  }
  expect(new BorshInstructionCoder(idl as Idl).decode(instruction.data)?.name).toBe(name)
}

describe('buildSettleEpoch', () => {
  const settle = buildSettleEpoch({ market, maturityTs: maturity })

  it('matches the IDL and has no signer — settling is permissionless', () => {
    expectMatchesIdl('settle_epoch', settle)
    expect(settle.keys.some((k) => k.isSigner)).toBe(false)
  })

  it('takes every account from the market and the date', () => {
    expect(settle.keys.slice(0, 5).map((k) => k.pubkey.toBase58())).toEqual(
      [
        market,
        epoch,
        vaultAddress(PROGRAM_ID, market),
        bufferVaultAddress(PROGRAM_ID, market),
        sourceReserveAddress(PROGRAM_ID, market),
      ].map((key) => key.toBase58()),
    )
  })
})

describe('buildRedeemRung', () => {
  const redeem = buildRedeemRung({ owner, market, ladder, epoch, rungIndex: 2, destination })

  it('matches the IDL: the owner signs, the funds leave the vault', () => {
    expectMatchesIdl('redeem_rung', redeem)
  })

  it('addresses the rung by its number and pays into the given account', () => {
    expect(redeem.keys.map((k) => k.pubkey.toBase58()).slice(0, 7)).toEqual(
      [
        owner,
        market,
        ladder,
        epoch,
        rungAddress(PROGRAM_ID, ladder, 2),
        vaultAddress(PROGRAM_ID, market),
        destination,
      ].map((key) => key.toBase58()),
    )
  })
})

describe('buildRollRung', () => {
  const roll = buildRollRung({
    payer: owner,
    market,
    ladder,
    epoch,
    rungIndex: 1,
    target,
    newRungIndex: 4,
  })

  it('matches the IDL', () => {
    expectMatchesIdl('roll_rung', roll)
  })

  it('creates the new rung at the ladder count and names no destination', () => {
    expect(roll.keys.map((k) => k.pubkey.toBase58()).slice(0, 9)).toEqual(
      [
        owner,
        market,
        ladder,
        epoch,
        rungAddress(PROGRAM_ID, ladder, 1),
        target,
        rungAddress(PROGRAM_ID, ladder, 4),
        vaultAddress(PROGRAM_ID, market),
        bufferVaultAddress(PROGRAM_ID, market),
      ].map((key) => key.toBase58()),
    )
  })
})
