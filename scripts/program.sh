#!/usr/bin/env bash
# Anchor does not build on Windows, so all Rust commands go through WSL.
#
# The command is not embedded in a string for `wsl -- bash -c`: WSL mixes Windows paths
# with parentheses (`Program Files (x86)`) into $PATH, and an embedded string breaks
# on them in a way that looks like a syntax error in our own code. Instead,
# WSL runs a file that sits next to this one.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -- bash "/mnt${repo}/scripts/program-wsl.sh" "${1:-build}"
