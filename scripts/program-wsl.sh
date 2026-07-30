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
    mkdir -p target/deploy
    cp "$CARGO_TARGET_DIR/deploy/treasury_runway.so" target/deploy/
    ;;
  test)
    cargo test --manifest-path programs/treasury-runway/Cargo.toml
    ;;
  *)
    echo "unknown command: ${1:-}" >&2
    exit 2
    ;;
esac
