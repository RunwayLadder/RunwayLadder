import { PublicKey, SystemProgram } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { associatedTokenAddress } from '../src/pda.js'
import { buildCreateAssociatedTokenIdempotent } from '../src/token.js'

const payer = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
const owner = new PublicKey('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8')
const mint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

describe('buildCreateAssociatedTokenIdempotent', () => {
  const instruction = buildCreateAssociatedTokenIdempotent({ payer, owner, mint })

  it('is CreateIdempotent of the Associated Token Account program, not Create', () => {
    // `Create` (0) fails on an existing account — the treasurer's usual case.
    expect(instruction.programId.toBase58()).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
    expect([...instruction.data]).toEqual([1])
  })

  it('lists the six accounts in the order the program reads them', () => {
    expect(instruction.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [payer.toBase58(), true, true],
      [associatedTokenAddress(owner, mint).toBase58(), false, true],
      [owner.toBase58(), false, false],
      [mint.toBase58(), false, false],
      [SystemProgram.programId.toBase58(), false, false],
      ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', false, false],
    ])
  })
})
