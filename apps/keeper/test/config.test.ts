import { PROGRAM_ID } from '@runway-ladder/sdk'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { ConfigError, parseConfig } from '../src/config.js'

const key = Keypair.generate()
const secret = JSON.stringify(Array.from(key.secretKey))
const market = Keypair.generate().publicKey.toBase58()

const base = { RPC_URL: 'http://127.0.0.1:8899', KEEPER_MARKET: market, KEEPER_KEYPAIR: secret }
const noFile = (): string => {
  throw new Error('no file should be read')
}

/** The problems a configuration is refused with — the message itself, as a log would show it. */
function refusal(env: Record<string, string | undefined>, readFile = noFile): string {
  try {
    parseConfig(env, readFile)
  } catch (error) {
    if (error instanceof ConfigError) return error.message
    throw error
  }
  throw new Error('the configuration was accepted')
}

describe('parseConfig', () => {
  it('takes an inline key and fills the defaults', () => {
    const config = parseConfig(base, noFile)

    expect(config.keeper.publicKey).toEqual(key.publicKey)
    expect(config.market.toBase58()).toBe(market)
    expect(config.programId).toEqual(PROGRAM_ID)
    expect(config.intervalMs).toBe(60_000)
    expect(config.minBalanceLamports).toBe(50_000_000n)
  })

  it('reads the key from a file when given a path', () => {
    const env = { ...base, KEEPER_KEYPAIR: undefined, KEEPER_KEYPAIR_PATH: 'keeper.json' }
    const config = parseConfig(env, (path) => (path === 'keeper.json' ? secret : ''))

    expect(config.keeper.publicKey).toEqual(key.publicKey)
  })

  it('treats an empty variable as unset, as .env.example leaves them', () => {
    const config = parseConfig({ ...base, PROGRAM_ID: '', KEEPER_KEYPAIR_PATH: '' }, noFile)

    expect(config.programId).toEqual(PROGRAM_ID)
  })

  it('refuses both key sources at once, and neither', () => {
    expect(refusal({ ...base, KEEPER_KEYPAIR_PATH: 'keeper.json' })).toMatch(/exactly one/)
    expect(refusal({ ...base, KEEPER_KEYPAIR: undefined })).toMatch(/exactly one/)
  })

  it('names every bad variable in one refusal', () => {
    const message = refusal({
      ...base,
      RPC_URL: 'ftp://node',
      KEEPER_MARKET: 'not-a-key',
      KEEPER_INTERVAL_SECONDS: '1',
    })

    expect(message).toMatch(/RPC_URL/)
    expect(message).toMatch(/KEEPER_MARKET/)
    expect(message).toMatch(/KEEPER_INTERVAL_SECONDS/)
  })

  it('takes the interval and the balance floor from the environment', () => {
    const config = parseConfig(
      { ...base, KEEPER_INTERVAL_SECONDS: '300', KEEPER_MIN_BALANCE_LAMPORTS: '10000000' },
      noFile,
    )

    expect(config.intervalMs).toBe(300_000)
    expect(config.minBalanceLamports).toBe(10_000_000n)
  })

  it('never echoes the secret of a damaged key', () => {
    // A key pasted into a CI secret together with its shell quotes. On an unexpected token
    // `JSON.parse` quotes the start of its input in its message, and a CI log is public.
    const quoted = `'${secret}'`
    const message = refusal({ ...base, KEEPER_KEYPAIR: quoted })

    expect(message).toMatch(/KEEPER_KEYPAIR: expected a solana-keygen key/)
    // V8 quotes about ten characters, so the check is on the first bytes of the key.
    expect(message).not.toContain(secret.slice(1, 8))
  })

  it('refuses a key whose public half does not match its secret', () => {
    const bytes = Array.from(key.secretKey)
    bytes[63] = (bytes[63] ?? 0) ^ 1

    expect(refusal({ ...base, KEEPER_KEYPAIR: JSON.stringify(bytes) })).toMatch(/does not match/)
  })

  it('refuses an array of the wrong length without quoting it', () => {
    const short = JSON.stringify(Array.from(key.secretKey.subarray(0, 32)))
    const message = refusal({ ...base, KEEPER_KEYPAIR: short })

    expect(message).toMatch(/64 bytes/)
    expect(message).not.toContain(short.slice(1, 20))
  })
})
