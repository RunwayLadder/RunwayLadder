#!/usr/bin/env bash
# The stand for the US1 end-to-end run: a validator with the program, a mint and a treasurer.
#
# Runs inside WSL; invoked from outside through scripts/e2e-stand.sh.
# The reason is the same as in program.sh: the onchain toolchain lives only there. Keys and
# the stand description land in `.e2e/` inside the repository — the only folder visible
# from both sides of the boundary, and the run on Windows must sign with them.
#
# The stand is disposable: `--reset` wipes the ledger every time. A run that depends on
# what was left over from last time measures history, not the program.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
out="$repo/.e2e"
ledger="/tmp/runway-ladder-e2e-ledger"
rpc="http://127.0.0.1:8899"
program_id="HShAvvN6icFTUAs2hiKTHr7nGomyrcKz66wPB6CNhewe"

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

so="$repo/target/deploy/runway_ladder.so"
if [ ! -f "$so" ]; then
  echo "no $so — run scripts/program.sh build first" >&2
  exit 2
fi

pkill -f 'solana-test-validator' >/dev/null 2>&1 || true
sleep 1
rm -rf "$ledger" "$out"
mkdir -p "$out"

# The ledger stays in the WSL file system: through 9p the validator writes many times
# slower, and the SC-001 measurement would show disk speed, not the program.
# `setsid` and `nohup`: the validator must outlive this WSL session — otherwise
# it would die with the script, and the run on Windows would have nothing to talk to.
setsid nohup solana-test-validator --reset --quiet --ledger "$ledger" \
  --bpf-program "$program_id" "$so" >"$out/validator.log" 2>&1 &
disown || true

for _ in $(seq 1 60); do
  if solana cluster-version --url "$rpc" >/dev/null 2>&1; then break; fi
  sleep 1
done
solana cluster-version --url "$rpc" >/dev/null

solana-keygen new --no-bip39-passphrase --silent --force -o "$out/authority.json" >/dev/null
solana-keygen new --no-bip39-passphrase --silent --force -o "$out/treasurer.json" >/dev/null

authority="$(solana-keygen pubkey "$out/authority.json")"
treasurer="$(solana-keygen pubkey "$out/treasurer.json")"

solana airdrop 100 "$authority" --url "$rpc" >/dev/null
solana airdrop 100 "$treasurer" --url "$rpc" >/dev/null

# Six decimals — like USDC, but precisely as a mint parameter: the program does not rely
# on a specific asset (FR-001), and the stand has no right to hint otherwise.
json_field() { python3 -c "import json,sys; print(json.load(sys.stdin)['commandOutput']['$1'])"; }

mint="$(
  spl-token --url "$rpc" --fee-payer "$out/authority.json" --output json \
    create-token --decimals 6 --mint-authority "$authority" | json_field address
)"

# The treasurer's account is an associated one: the owner's signature is not needed to
# create it, the stand operator pays. The same address is derived by
# `associatedTokenAddress()` in the SDK, and the run checks that.
spl-token --url "$rpc" --fee-payer "$out/authority.json" \
  create-account "$mint" --owner "$treasurer" >/dev/null

source_token="$(
  spl-token --url "$rpc" --output json address --token "$mint" --owner "$treasurer" --verbose \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['associatedTokenAddress'])"
)"

spl-token --url "$rpc" --fee-payer "$out/authority.json" \
  mint "$mint" 2000000 "$source_token" --mint-authority "$out/authority.json" >/dev/null

python3 - "$out/stand.json" <<PY
import json, sys
json.dump({
    "rpc": "$rpc",
    "programId": "$program_id",
    "mint": "$mint",
    "authority": "authority.json",
    "treasurer": "treasurer.json",
    "sourceToken": "$source_token",
}, open(sys.argv[1], "w"), indent=2)
PY

echo "stand is up: mint $mint, treasurer $treasurer, 2 000 000 units at $source_token"
