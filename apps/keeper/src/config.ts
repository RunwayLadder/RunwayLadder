/**
 * The keeper's configuration — the one input it takes from outside, so it goes through a
 * schema like every other boundary in the project.
 *
 * The key is the keeper's own and pays only for gas and the rent of rolled rungs: neither
 * instruction it sends takes a destination, so the key has nothing to divert funds with. It
 * still never appears in an error message — a CI log is public on a public repository.
 */

import { PROGRAM_ID } from '@runway-ladder/sdk'
import { Keypair, PublicKey } from '@solana/web3.js'
import { z } from 'zod'

/** One minute: an epoch matures to the second, and a minute late is what the treasurer sees. */
const DEFAULT_INTERVAL_SECONDS = 60
/**
 * 0.05 SOL — some twenty rolls of rent plus fees. Below it the keeper refuses to work rather
 * than fail halfway through a ladder, which would look like a program error in the log.
 */
const DEFAULT_MIN_BALANCE_LAMPORTS = 50_000_000n

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(['keeper configuration is invalid:', ...problems.map((p) => `  - ${p}`)].join('\n'))
    this.name = 'ConfigError'
  }
}

const publicKey = z.string().transform((value, ctx) => {
  try {
    return new PublicKey(value)
  } catch {
    ctx.issues.push({ code: 'custom', message: 'not a base58 public key', input: value })
    return z.NEVER
  }
})

const envSchema = z.object({
  RPC_URL: z.url({ protocol: /^https?$/ }),
  PROGRAM_ID: publicKey.optional(),
  KEEPER_MARKET: publicKey,
  KEEPER_KEYPAIR: z.string().optional(),
  KEEPER_KEYPAIR_PATH: z.string().optional(),
  KEEPER_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).optional(),
  KEEPER_MIN_BALANCE_LAMPORTS: z.coerce.bigint().min(0n).optional(),
})

/** The `solana-keygen` file format: the 64-byte secret key as a JSON array of bytes. */
const secretKeySchema = z.array(z.number().int().min(0).max(255)).length(64)

export type KeeperConfig = {
  readonly rpcUrl: string
  readonly programId: PublicKey
  readonly market: PublicKey
  readonly keeper: Keypair
  readonly intervalMs: number
  readonly minBalanceLamports: bigint
}

/**
 * The configuration from the environment.
 *
 * The key comes either inline (`KEEPER_KEYPAIR` — the form a CI secret takes) or from a file
 * (`KEEPER_KEYPAIR_PATH`), and exactly one of the two: with both set, which one signs would be
 * a guess. An empty variable counts as unset, as `.env.example` leaves them.
 */
export function parseConfig(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string,
): KeeperConfig {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''))
  const parsed = envSchema.safeParse(present)
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    )
  }

  const vars = parsed.data
  const inline = vars.KEEPER_KEYPAIR
  const path = vars.KEEPER_KEYPAIR_PATH
  if ((inline === undefined) === (path === undefined)) {
    throw new ConfigError(['set exactly one of KEEPER_KEYPAIR and KEEPER_KEYPAIR_PATH'])
  }

  const source = inline === undefined ? `KEEPER_KEYPAIR_PATH (${path})` : 'KEEPER_KEYPAIR'
  const text = inline ?? readFile(path ?? '')

  return {
    rpcUrl: vars.RPC_URL,
    programId: vars.PROGRAM_ID ?? PROGRAM_ID,
    market: vars.KEEPER_MARKET,
    keeper: keypairOf(text, source),
    intervalMs: (vars.KEEPER_INTERVAL_SECONDS ?? DEFAULT_INTERVAL_SECONDS) * 1000,
    minBalanceLamports: vars.KEEPER_MIN_BALANCE_LAMPORTS ?? DEFAULT_MIN_BALANCE_LAMPORTS,
  }
}

/**
 * The secret is never echoed: `JSON.parse` quotes the start of its input in its own message,
 * and so would a schema reporting the value it rejected — so neither message is passed on.
 */
function keypairOf(text: string, source: string): Keypair {
  const problem = `${source}: expected a solana-keygen key, a JSON array of 64 bytes`

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new ConfigError([problem])
  }

  const bytes = secretKeySchema.safeParse(json)
  if (!bytes.success) throw new ConfigError([problem])

  try {
    return Keypair.fromSecretKey(Uint8Array.from(bytes.data))
  } catch {
    // The second half of the 64 bytes is the public key; a mismatch is a damaged file.
    throw new ConfigError([`${source}: the public half of the key does not match its secret`])
  }
}
