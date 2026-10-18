/**
 * Snapshot of the Kamino accounts the fork needs — `fixtures/kamino/` (T045).
 *
 * The route is the reserve itself, not an obligation: `deposit_reserve_liquidity` gives
 * kTokens for USDC and `redeem_reserve_collateral` gives the USDC back at the current
 * exchange rate. Both refresh the reserve **without a price** (`refresh_reserve(…, None, …)`
 * in klend), so neither the Scope oracle nor the farms are part of the snapshot: a price
 * that goes stale on a fork would break nothing here.
 *
 * What gets written, and why each piece:
 *
 * - `klend.so` — the program, trimmed to its ELF. Kamino ships a new version every month or
 *   two, and after an upgrade the pinned one can no longer be fetched from the chain, so it
 *   lives in git. Its hash must equal the one of Kamino's verified build (OtterSec), or the
 *   snapshot is refused: a trimmed binary that differs from what is deployed would test
 *   something nobody runs.
 * - six state accounts — lending market, its authority, USDC reserve, its liquidity supply,
 *   its collateral mint, the USDC mint. They come from **one** `getMultipleAccounts`, i.e. from
 *   one slot:
 *   a reserve from one slot and its supply vault from another disagree about the balance,
 *   and klend checks exactly that after every transfer.
 * - `manifest.json` — slot, block time, the program's provenance and a sha256 per file.
 *   A harness starts its clock at that slot: the reserve's `last_update.slot` is the
 *   snapshot's, and on slot 0 the elapsed-slots subtraction fails.
 *
 * The RPC comes from `KAMINO_RPC_URL` (mainnet); without it the public endpoint is used —
 * the whole snapshot is a handful of reads. The URL itself is never written anywhere: a
 * provider key lives in it.
 *
 * Refreshing the snapshot is a deliberate act with its own commit, not a step of a run.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PublicKey } from '@solana/web3.js'

const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD')
const LENDING_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF')
const USDC_RESERVE = new PublicKey('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59')
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const LOADER_V3 = 'BPFLoaderUpgradeab1e11111111111111111111111'
const VERIFY_URL = `https://verify.osec.io/status/${KLEND.toBase58()}`

/**
 * Field offsets inside klend's `Reserve` (8-byte discriminator included), release/v1.25.0.
 * They are not trusted blindly: every key read through them is checked against what the
 * account behind it must be (owner, mint, authority) before anything is written.
 */
const RESERVE = {
  lendingMarket: 32,
  liquidityMint: 128,
  liquiditySupply: 160,
  collateralMint: 2560,
} as const

/** `u64::MAX`, the rent epoch of a rent-exempt account; exceeds a JS number. */
const RENT_EPOCH_EXEMPT = '18446744073709551615'

const outDir = fileURLToPath(new URL('../fixtures/kamino/', import.meta.url))
// biome-ignore lint/suspicious/noUndeclaredEnvVars: run by hand, not a Turborepo task
const rpc = process.env.KAMINO_RPC_URL ?? 'https://api.mainnet-beta.solana.com'

type RpcAccount = {
  lamports: number
  owner: string
  data: [string, 'base64']
  executable: boolean
  space: number
}

async function call<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: T; error?: { message: string } }
  if (body.error || body.result === undefined) {
    throw new Error(`${method}: ${body.error?.message ?? `HTTP ${response.status}`}`)
  }
  return body.result
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const keyAt = (data: Buffer, offset: number) => new PublicKey(data.subarray(offset, offset + 32))

function check(condition: boolean, what: string): asserts condition {
  if (!condition) throw new Error(`snapshot refused: ${what}`)
}

/**
 * The executable inside a programdata account ends long before the account does: the
 * account is allocated for future upgrades and the rest is zeros. The ELF's own extent is
 * the furthest of its section header table and its segments — the same bytes the verified
 * build hashes.
 */
function trimElf(elf: Buffer): Buffer {
  check(elf.subarray(0, 4).toString('latin1') === '\x7fELF', 'programdata holds no ELF')
  let end = Number(elf.readBigUInt64LE(0x28)) + elf.readUInt16LE(0x3a) * elf.readUInt16LE(0x3c)
  const phoff = Number(elf.readBigUInt64LE(0x20))
  for (let i = 0; i < elf.readUInt16LE(0x38); i++) {
    const ph = phoff + i * elf.readUInt16LE(0x36)
    end = Math.max(end, Number(elf.readBigUInt64LE(ph + 0x08) + elf.readBigUInt64LE(ph + 0x20)))
  }
  return elf.subarray(0, end)
}

/** The format `solana account --output json` writes and `solana-test-validator --account` reads. */
function accountFile(pubkey: PublicKey, account: RpcAccount): string {
  const json = JSON.stringify(
    {
      pubkey: pubkey.toBase58(),
      account: {
        lamports: account.lamports,
        data: account.data,
        owner: account.owner,
        executable: account.executable,
        rentEpoch: 0,
        space: account.space,
      },
    },
    null,
    2,
  )
  return `${json.replace('"rentEpoch": 0', `"rentEpoch": ${RENT_EPOCH_EXEMPT}`)}\n`
}

async function programData(): Promise<{ address: PublicKey; deploySlot: bigint; elf: Buffer }> {
  const program = await call<{ value: RpcAccount | null }>('getAccountInfo', [
    KLEND.toBase58(),
    { encoding: 'base64' },
  ])
  check(program.value?.owner === LOADER_V3, 'klend is not an upgradeable program')
  const address = keyAt(Buffer.from(program.value.data[0], 'base64'), 4)
  const data = await call<{ value: RpcAccount | null }>('getAccountInfo', [
    address.toBase58(),
    { encoding: 'base64' },
  ])
  check(data.value !== null, 'klend programdata is missing')
  const bytes = Buffer.from(data.value.data[0], 'base64')
  // UpgradeableLoaderState::ProgramData: tag u32, slot u64, Option<Pubkey> authority — 45 bytes.
  return { address, deploySlot: bytes.readBigUInt64LE(4), elf: trimElf(bytes.subarray(45)) }
}

async function main(): Promise<void> {
  const before = await programData()

  const head = await call<{ context: { slot: number }; value: (RpcAccount | null)[] }>(
    'getMultipleAccounts',
    [[LENDING_MARKET.toBase58(), USDC_RESERVE.toBase58()], { encoding: 'base64' }],
  )
  const reserveData = Buffer.from(head.value[1]?.data[0] ?? '', 'base64')
  check(keyAt(reserveData, RESERVE.lendingMarket).equals(LENDING_MARKET), 'reserve market')
  check(keyAt(reserveData, RESERVE.liquidityMint).equals(USDC_MINT), 'reserve is not USDC')
  const supply = keyAt(reserveData, RESERVE.liquiditySupply)
  const collateralMint = keyAt(reserveData, RESERVE.collateralMint)

  // The market authority is a PDA, but on mainnet it is also a funded system account, and a
  // harness that insists on every account it is handed (mollusk does) needs it present.
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from('lma'), LENDING_MARKET.toBuffer()],
    KLEND,
  )

  // All six in one call: the two above only told us which keys to ask for.
  const keys = [LENDING_MARKET, authority, USDC_RESERVE, supply, collateralMint, USDC_MINT]
  const snap = await call<{ context: { slot: number }; value: (RpcAccount | null)[] }>(
    'getMultipleAccounts',
    [keys.map((k) => k.toBase58()), { encoding: 'base64' }],
  )
  const accounts = snap.value.map((a, i) => {
    check(a !== null, `${keys[i]?.toBase58()} is missing`)
    return a
  })
  const [market, authorityAcc, reserve, supplyAcc, collMint, usdcMint] = accounts as [
    RpcAccount,
    RpcAccount,
    RpcAccount,
    RpcAccount,
    RpcAccount,
    RpcAccount,
  ]
  const after = await programData()
  check(before.deploySlot === after.deploySlot, 'klend was upgraded during the snapshot')

  check(market.owner === KLEND.toBase58() && reserve.owner === KLEND.toBase58(), 'klend owner')
  check(authorityAcc.owner === SYSTEM_PROGRAM && authorityAcc.space === 0, 'authority is bare')
  const supplyBytes = Buffer.from(supplyAcc.data[0], 'base64')
  check(
    supplyAcc.owner === TOKEN_PROGRAM && supplyBytes.length === 165,
    'supply is a token account',
  )
  check(keyAt(supplyBytes, 0).equals(USDC_MINT), 'supply holds USDC')
  check(keyAt(supplyBytes, 32).equals(authority), 'supply belongs to the market authority')
  const collBytes = Buffer.from(collMint.data[0], 'base64')
  check(collMint.owner === TOKEN_PROGRAM && collBytes.length === 82, 'collateral is a mint')
  // Mint: COption<Pubkey> mint_authority = tag u32 at 0, key at 4.
  check(collBytes.readUInt32LE(0) === 1 && keyAt(collBytes, 4).equals(authority), 'kToken auth')
  check(usdcMint.owner === TOKEN_PROGRAM, 'USDC mint owner')

  const verified = (await (await fetch(VERIFY_URL)).json()) as {
    is_verified: boolean
    on_chain_hash: string
    commit: string
    repo_url: string
  }
  // solana-verify hashes the bytes up to the last non-zero one. The ELF itself is longer —
  // its section header table ends in zeros — and a binary cut at the last non-zero byte is
  // one the loader refuses. So the file keeps the ELF's extent, and the comparison drops
  // the zero tail the same way the verifier does.
  let nonZero = after.elf.length
  while (nonZero > 0 && after.elf[nonZero - 1] === 0) nonZero--
  const verifiedHash = sha256(after.elf.subarray(0, nonZero))
  check(verified.is_verified && verified.on_chain_hash === verifiedHash, 'ELF ≠ verified build')
  const elfHash = sha256(after.elf)

  const blockTime = await call<number | null>('getBlockTime', [snap.context.slot])
  mkdirSync(outDir, { recursive: true })
  writeFileSync(`${outDir}klend.so`, after.elf)

  const files = [
    ['lending-market', LENDING_MARKET, market],
    ['lending-market-authority', authority, authorityAcc],
    ['usdc-reserve', USDC_RESERVE, reserve],
    ['usdc-reserve-liquidity-supply', supply, supplyAcc],
    ['usdc-reserve-collateral-mint', collateralMint, collMint],
    ['usdc-mint', USDC_MINT, usdcMint],
  ] as const
  const written = files.map(([name, pubkey, account]) => {
    const text = accountFile(pubkey, account)
    writeFileSync(`${outDir}${name}.json`, text)
    return {
      name,
      file: `${name}.json`,
      pubkey: pubkey.toBase58(),
      sha256: sha256(Buffer.from(text)),
    }
  })

  const manifest = {
    note: 'Mainnet snapshot for the fork. Written by scripts/kamino-dump.ts; do not edit by hand.',
    cluster: 'mainnet-beta',
    slot: snap.context.slot,
    blockTime,
    klend: {
      programId: KLEND.toBase58(),
      programData: after.address.toBase58(),
      deploySlot: Number(after.deploySlot),
      file: 'klend.so',
      sha256: elfHash,
      verifiedHash,
      verifiedCommit: verified.commit,
      repo: 'https://github.com/Kamino-Finance/klend',
    },
    accounts: written,
  }
  writeFileSync(`${outDir}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`snapshot at slot ${snap.context.slot}, klend ${verified.commit.slice(0, 8)}`)
  for (const w of written) console.log(`  ${w.name.padEnd(30)} ${w.pubkey}`)
}

await main()
