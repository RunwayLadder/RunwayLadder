# RunwayLadder

Fixed income for onchain treasuries on Solana. A treasury deposits stablecoins once
and gets a **dated schedule of guaranteed inflows** instead of a floating APY.

The novelty isn't splitting principal from yield — Exponent already does that — it's
the treasury layer on top: laddering one amount across several dates in a single
signature, a roll policy, and a runway report showing how far the inflows reach.

## How it works

The treasurer enters an amount and a horizon. The form shows the rate, the operator,
and when that rate was set — **before** signing, not after. One signature opens the
ladder and lays the amount across rungs, where each rung is a promise to pay a
specific amount in a specific epoch. The dashboard then reads the ladder back from
the chain and draws the inflow chart.

## Status: milestone M1 (`v0.1.0`)

The ladder works end to end — from the form to the chain and back into the chart.
Measured on a local validator (`pnpm e2e:us1`):

| Criterion | Budget | Measured |
|---|---|---|
| Ladder across 4 rungs, chart updated | ≤ 15 s | **1 signature, 0.04 s** |
| Charted total = sum of onchain rungs | drift 0 | **0 base units** |
| Rungs that fit in one signature | — | **11** (1195 of 1232 bytes) |

Tests: 193 TypeScript, 50 Rust.

**What's not here yet.** Redemption does not exist at all: a ladder is created and
lives, but no rung can be redeemed, rolled, or settled — that's M2. The yield source
is a deterministic stub adapter, not Kamino (M3). Half of the sum-matching criterion
stays open on purpose: "rungs actually redeemed" arrives together with redemption.

## Rules enforced by the types

- **A promise cannot change once issued.** No instruction has a path that overwrites
  `Rung.promised_amount`.
- **A shortfall is never silent.** "Paid less than promised, unmarked" is an
  unrepresentable state: `RedeemedWithDeficit` is a separate variant.
- **One waterfall:** yield pool → protocol buffer → proportional haircut. One
  function, one instruction, one order.
- **The crank cannot divert funds:** the destination is not a parameter of a roll —
  the new rung goes into the same ladder with the same owner, and that owner may be
  a multisig safe.
- **Checked arithmetic only**, `u128` for intermediate products, `overflow-checks`
  enabled even in release: an overflow here is a wrong amount, not a panic.
- **The math is duplicated in Rust and TypeScript deliberately.** Drift is caught by
  the shared vectors in `fixtures/vectors.json`, read by both test suites.

## Layout

```
programs/runway-ladder    Anchor: market, epochs, ladder, rungs, waterfall
packages/math             ladder math — pure, no network, no Solana types
packages/sdk              PDAs, instruction builders, account decoders
apps/web                  treasurer dashboard
apps/keeper               permissionless roll crank (from M2)
```

## Build and run

Requires pnpm 9.15 and the Node version in `.nvmrc`; the program additionally needs a
Rust toolchain inside WSL (anchor-cli 0.32.1, solana-cli 4.2.0).

```bash
pnpm install
pnpm gate                        # lint + typecheck + test

bash scripts/program.sh build    # anchor build in WSL, .so copied to target/deploy
bash scripts/program.sh test     # program tests on mollusk-svm

pnpm e2e:stand                   # local validator with the program, a mint, a treasury
pnpm e2e:us1                     # end-to-end ladder run, with numbers
```

Without `VITE_RPC_URL` and `VITE_MARKET` the dashboard stays an M0 prototype on mock
data and says so in its status bar — it never shows invented numbers dressed up as
onchain ones. The variables are documented in `.env.example`.

**Rust only in WSL, TypeScript only on Windows:** a single `node_modules` cannot serve
both platforms, so `pnpm install` is never run inside WSL.

## Stack

anchor-cli / anchor-lang / `@coral-xyz/anchor` — all three 0.32.1 · rustc 1.97.1 ·
solana-cli 4.2.0 · mollusk-svm 0.15.0 · pnpm 9.15 + Turborepo 2.10.11 ·
TypeScript 7.0.2 strict · Biome 2.5.9 · Vitest 4.1.11 · Zod 4.4.3 ·
`@solana/web3.js` 1.98.4.

## Disclaimer

Work in progress. Nothing is deployed to mainnet and nothing has been audited. Demos
do not run against mainnet: a fork for the local stand, devnet for a public link.
