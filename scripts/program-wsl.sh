#!/usr/bin/env bash
# Runs inside WSL; invoked from outside through scripts/program.sh.
#
# CARGO_TARGET_DIR stays in the WSL file system: building through 9p is many times
# slower, and the target directory is where all the traffic is. The consequence: the .so does
# not land in ./target/deploy, where `anchor deploy` looks for it, so we copy it back.
set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export CARGO_TARGET_DIR="$HOME/.cache/treasury-runway-target"

cd "$(dirname "$0")/.."

case "${1:-build}" in
  build)
    anchor build
    mkdir -p target/deploy packages/sdk/src/idl
    cp "$CARGO_TARGET_DIR/deploy/treasury_runway.so" target/deploy/
    # The IDL goes into the SDK because target/ is outside the index. Otherwise TypeScript
    # would get a third, hand-written copy of the account layout — and it would drift silently.
    cp target/idl/treasury_runway.json packages/sdk/src/idl/
    ;;
  test)
    # Instruction tests run the real .so in mollusk, so the build always precedes
    # them: otherwise a green test could describe the previous version of the program.
    # SBF_OUT_DIR is needed because cargo test works from the crate folder, not the repository.
    "$0" build
    SBF_OUT_DIR="$PWD/target/deploy"       cargo test --manifest-path programs/treasury-runway/Cargo.toml
    ;;
  *)
    echo "unknown command: ${1:-}" >&2
    exit 2
    ;;
esac
