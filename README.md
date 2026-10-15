# RunwayLadder

Fixed income for onchain treasuries on Solana. A treasury deposits stablecoins once
and gets a **dated schedule of guaranteed inflows** instead of a floating APY.

The novelty isn't splitting principal from yield — Exponent already does that — it's
the treasury layer on top: laddering one amount across several dates in a single
signature, a roll policy, and a runway report showing how far the inflows reach.

**Project page:** https://runwayladder.github.io/RunwayLadder/ — what the product does,
the terms it comes with, and the figures measured so far.
**Live prototype:** https://runwayladder.github.io/RunwayLadder/app/ — the dashboard on
mock data, deployed from `main` by GitHub Actions. It reads no network and says so in
its status bar: the program is not deployed anywhere public yet. Pointed at a validator
(see [Build and run](#build-and-run)), the same dashboard reads the chain and signs.

## How it works

The treasurer enters an amount and a horizon. The form shows the rate, the operator,
and when that rate was set — **before** signing, not after. One signature opens the
ladder and lays the amount across rungs, where each rung is a promise to pay a
specific amount on a specific date. The dashboard then reads the ladder back from
the chain and draws the inflow chart.

A protocol fee (`Market.fee_bps`) is taken from the principal at deposit time and
goes to the protocol buffer, so the promise on each rung is made on the working
amount, not the nominal — the form shows both.

When a date matures, the epoch is **settled once** (`settle_epoch`): what the yield
source actually returned is compared with what that date promised. A shortfall is
covered from the protocol buffer; whatever the buffer cannot cover becomes a
pro-rata haircut, recorded on the epoch as `SettledWithDeficit`. A surplus goes to
the same buffer. Then each rung of that date either:

- is **redeemed** by its owner (`redeem_rung`) — at par, or as
  `RedeemedWithDeficit { amount, promised }` with both numbers on the rung; or
- is **rolled** by anyone (`roll_rung`) into the market's furthest date, if the
  ladder's roll policy is `Roll`. Nothing is paid out; the amount goes to work again
  in a new rung of the same ladder.

The owner switches the roll policy from the dashboard (`set_roll_policy`); the switch
is read at the moment of a roll. A keeper (`apps/keeper`) settles matured dates and
rolls opted-in rungs on a timer. It holds no operator key and opens no dates: if the
operator has not opened a later date, the rung waits or its owner redeems it.

The dashboard shows a deficit before it is paid — in the forecast and on the ladder
screen, with the actual amount instead of the promised one — and builds the
redemption history from the closing transactions. Every state change emits an event
(`LadderOpened`, `RungIssued`, `LadderFunded`, `EpochSettled`, `RungRedeemed`,
`RungRolled`, `RollPolicySet`).

## Status: milestone M2 (`v0.2.0`)

The ladder lives on its own: rungs mature, get settled, and are either redeemed or
rolled forward without the treasurer — and a shortfall is visible on screen, not in
the logs. Measured on a local validator (`pnpm e2e:us1`, `pnpm e2e:us2`):

| Criterion | Budget | Measured |
|---|---|---|
| Ladder across 4 rungs, chart updated | ≤ 15 s | **1 signature, 0.04 s** |
| Ladder survives full cycles with no treasurer action | ≥ 2 cycles | **2 cycles, 8 rolls by the keeper, 0 treasurer signatures** |
| Network fees of a full cycle (4 rungs + 4 redemptions) | < $0.10 | **45,000 lamports = $0.011 at $250/SOL** |
| Charted total = sum of rungs actually redeemed | drift 0 | **0 base units** (399,000.169032 both) |
| Principal at par or the deficit marked, on simulated rate paths | 100% of ≥ 200 | **400/400: 303 at par, 97 marked** |
| Rungs that fit in one signature | — | **11** (1195 of 1232 bytes) |

Account rent is separate from the fee figure and is not returned today: 0.0093 SOL
per 4-date ladder, 0.0019 SOL per roll.

Tests: 341 TypeScript, 104 Rust.

**What's not here yet.** The yield source is a deterministic adapter, not Kamino
(M3), so the 400 rate paths above are simulated: they show the cover rule holds, not
that a real Kamino shortfall looks like this. There is no early exit — money is
locked until its date. Rent is not returned: closing a finished ladder is planned
for M3. No public network deployment yet: the devnet link arrives with M3, and until
then the hosted dashboard runs on mock data. Nothing has been audited.

## Rules the code is built around

- **A promise cannot change once issued.** None of the eight instructions has a path
  that overwrites `Rung.promised_amount`. This is the absence of a path, not a flag
  check.
- **A shortfall is never silent.** "Paid less than promised, unmarked" is an
  unrepresentable state: `RedeemedWithDeficit { amount, promised }` and
  `RolledWithDeficit { amount, promised, into }` are separate rung variants, and the
  epoch carries `SettledWithDeficit { paid, deficit }`.
- **One cover for a shortfall:** protocol buffer → pro-rata haircut. One function,
  one instruction (`settle_epoch`), one order. A surplus goes symmetrically into the
  same buffer: the rate risk sits with the protocol, not with a third party.
- **Income counts only in tokens that arrived.** `realized` is principal plus
  `min(accrued, source reserve)`, not a formula: the vault is shared by all dates, and
  income without tokens behind it would be paid out of someone else's principal.
- **Settlement counts to the maturity date, not to the moment of the call.**
  `settle_epoch` is permissionless; accruing up to `now` would let whoever picks the
  moment of sending decide what each rung gets.
- **The crank cannot divert funds:** a roll has no destination parameter — the new
  rung goes into the same ladder with the same owner, and that owner may be a
  multisig safe (the check does not depend on the account type). The tests send
  `roll_rung` from a stranger's signer and try to divert it into a rung, or a
  ladder, of the stranger's own.
- **Checked arithmetic only**, `u128` for intermediate products, `overflow-checks`
  enabled even in release: an overflow here is a wrong amount, not a panic.
- **The math is duplicated in Rust and TypeScript deliberately.** Drift is caught by
  the shared vectors in `fixtures/vectors.json`, read by both test suites — the
  settlement vectors included.

## Layout

```
programs/runway-ladder    Anchor: market, epochs, ladder, rungs, settlement
packages/math             ladder and settlement math — pure, no network, no Solana types
packages/sdk              PDAs, instruction builders, account and event decoders, IDL
apps/web                  treasurer dashboard (served at /app/)
apps/landing              project page — static, the Pages root
apps/keeper               permissionless settle-and-roll crank
scripts/                  WSL build, local validator stand, end-to-end runs
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
pnpm e2e:us2                     # two full roll cycles with the keeper (~11 min)

pnpm --filter @runway-ladder/keeper start [--once]   # the keeper on its own
```

Without `VITE_RPC_URL` and `VITE_MARKET` the dashboard stays a prototype on mock data
and says so in its status bar — it never shows invented numbers dressed up as onchain
ones. The keeper reads `RPC_URL`, `PROGRAM_ID`, `KEEPER_MARKET` and its own keypair;
it needs SOL for fees and for the rent of each rung it rolls, and no access to the
treasury's funds. All variables are documented in
`.env.example`.

**Rust only in WSL, TypeScript only on Windows:** a single `node_modules` cannot serve
both platforms, so `pnpm install` is never run inside WSL.

## Stack

anchor-cli / anchor-lang / `@coral-xyz/anchor` — all three 0.32.1 · rustc 1.97.1 ·
solana-cli 4.2.0 · mollusk-svm 0.15.0 · pnpm 9.15 + Turborepo 2.10.11 ·
TypeScript 7.0.2 strict · Biome 2.5.9 · Vitest 4.1.11 · Zod 4.4.3 ·
`@solana/web3.js` 1.98.4.

## Disclaimer

Work in progress. Nothing is deployed to mainnet and nothing has been audited. Demos
do not run against mainnet: today the stand is a plain local validator with the
program loaded; a mainnet fork arrives with the Kamino adapter (M3), devnet for a
public link.

## License

[Apache-2.0](LICENSE)
