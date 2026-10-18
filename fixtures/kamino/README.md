# Kamino mainnet snapshot

The accounts the fork needs to run Kamino Lending (klend) offline: the program and the
USDC reserve of Kamino's main market, all taken from one mainnet slot. `manifest.json`
names the slot, its block time, the program's provenance and a sha256 for every file.

| File | Account |
|---|---|
| `klend.so` | Kamino Lending, `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` |
| `lending-market.json` | main market, `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF` |
| `lending-market-authority.json` | the market's authority PDA (`["lma", market]`) |
| `usdc-reserve.json` | USDC reserve, `D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59` |
| `usdc-reserve-liquidity-supply.json` | the reserve's USDC vault |
| `usdc-reserve-collateral-mint.json` | the reserve's kToken mint |
| `usdc-mint.json` | USDC |

The set covers the reserve route only: `deposit_reserve_liquidity` and
`redeem_reserve_collateral`. Both refresh the reserve without a price, so the Scope oracle
and the farms are not part of the snapshot, and a price going stale on the fork breaks
nothing. Obligations, borrowing and farm rewards are out of scope.

## Using it

- The account files use the format of `solana account --output json`, so
  `solana-test-validator --account <pubkey> <file>` loads them as they are.
- **Start the clock at the snapshot's slot**, not at zero (`--warp-slot`; in mollusk,
  `warp_to_slot`). The reserve remembers the slot it was last refreshed at, and klend
  subtracts it from the current one.
- `programs/runway-ladder/tests/kamino_snapshot.rs` is the proof the set is complete: a
  deposit and a redemption on real klend, and interest accruing when the clock moves.

## Refreshing

```bash
KAMINO_RPC_URL=<mainnet RPC> pnpm kamino:dump   # without it, the public endpoint
```

A refresh is a deliberate change with its own commit. The script refuses to write a
snapshot whose program does not match Kamino's verified build (OtterSec), whose accounts do
not fit together, or during which klend was upgraded.

## License

`klend.so` is Kamino Lending, © StroudGlobal S.A., licensed under the Business Source
License 1.1 (`LICENSE-klend`), which permits redistribution and non-production use. It is
here only to run tests and a local fork; nothing in this repository uses it in production.
The build matches commit `a08760976f51a3a58c4a0c6ea27b4a0e565bca79` (release 1.25.0) of
[Kamino-Finance/klend](https://github.com/Kamino-Finance/klend). The rest of the repository
is Apache-2.0; this directory's binary is not.
