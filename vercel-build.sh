#!/usr/bin/env bash
set -euo pipefail

export HOME=/tmp
export CARGO_HOME=/tmp/cargo
export RUSTUP_HOME=/tmp/rustup
export PATH=/tmp/cargo/bin:$PATH

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --default-toolchain stable -t wasm32-unknown-unknown --no-modify-path

curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

pnpm build
