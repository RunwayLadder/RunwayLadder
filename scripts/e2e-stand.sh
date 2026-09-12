#!/usr/bin/env bash
# The end-to-end stand lives in WSL — that is where the onchain toolchain is. The entry point
# from Windows, as in program.sh: the command is handed over as a file rather than a string
# for `bash -c`, because WSL mixes Windows paths with parentheses into $PATH.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -- bash "/mnt${repo}/scripts/e2e-stand-wsl.sh"
