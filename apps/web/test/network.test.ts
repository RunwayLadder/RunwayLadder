import { PublicKey } from '@solana/web3.js'
import { PROGRAM_ID } from '@treasury-runway/sdk'
import { describe, expect, it } from 'vitest'
import { readNetworkConfig } from '../src/lib/network'

/**
 * This is the only dashboard test that makes sense without a browser: the rest of T028 is
 * providers and rendering. `.env` parsing is tested because its failure is silent — the app
 * comes up, reads the wrong network or reads nothing.
 */
describe('readNetworkConfig', () => {
  it('without an RPC keeps the prototype on mocks and says why', () => {
    const config = readNetworkConfig({})

    expect(config.kind).toBe('offline')
    expect(config).toMatchObject({ reason: expect.stringContaining('VITE_RPC_URL') })
  })

  it('an empty string is not an address', () => {
    expect(readNetworkConfig({ VITE_RPC_URL: '   ' }).kind).toBe('offline')
  })

  it('a local validator reads as localnet', () => {
    const config = readNetworkConfig({ VITE_RPC_URL: 'http://127.0.0.1:8899' })

    expect(config).toMatchObject({ kind: 'live', cluster: 'localnet' })
  })

  it('devnet is recognised by the provider host', () => {
    const config = readNetworkConfig({ VITE_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=x' })

    expect(config).toMatchObject({ kind: 'live', cluster: 'devnet' })
  })

  it('the default program is the one in the IDL', () => {
    const config = readNetworkConfig({ VITE_RPC_URL: 'http://localhost:8899' })

    expect(config.kind === 'live' && config.programId.equals(PROGRAM_ID)).toBe(true)
  })

  it('the program can be overridden by address', () => {
    const other = new PublicKey('SysvarC1ock11111111111111111111111111111111')
    const config = readNetworkConfig({
      VITE_RPC_URL: 'http://localhost:8899',
      VITE_PROGRAM_ID: other.toBase58(),
    })

    expect(config.kind === 'live' && config.programId.equals(other)).toBe(true)
  })

  it('a non-address in VITE_PROGRAM_ID turns the network off rather than crashing', () => {
    const config = readNetworkConfig({
      VITE_RPC_URL: 'http://localhost:8899',
      VITE_PROGRAM_ID: 'not-a-key',
    })

    expect(config).toMatchObject({ kind: 'offline' })
  })

  /**
   * `docs/SPEC.md` keeps mainnet out of scope, and the guard sits in configuration,
   * not in the memory of whoever fills in `.env`.
   */
  it('a mainnet URL is rejected', () => {
    for (const url of [
      'https://api.mainnet-beta.solana.com',
      'https://mainnet.helius-rpc.com/?api-key=x',
      'https://example.solana-mainnet.quiknode.pro/abc/',
    ]) {
      const config = readNetworkConfig({ VITE_RPC_URL: url })

      expect(config).toMatchObject({ kind: 'offline', reason: expect.stringContaining('mainnet') })
    }
  })

  it('an unknown host stays live — the guard catches carelessness, not every mainnet', () => {
    const config = readNetworkConfig({ VITE_RPC_URL: 'https://rpc.internal.example/' })

    expect(config).toMatchObject({ kind: 'live', cluster: 'unknown' })
  })

  it('ws:// is not accepted — reads go over http', () => {
    expect(readNetworkConfig({ VITE_RPC_URL: 'ws://127.0.0.1:8900' }).kind).toBe('offline')
  })
})
