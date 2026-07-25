#!/usr/bin/env bash
# Build the browser core: compile zed-sync-core to wasm32 and generate the JS
# glue into sdk/pkg/. The SDK's core.mjs loadWasmCore() imports it; the
# committed pure-JS mirror (core.mjs) is the always-works fallback, and
# sdk/test/wasm-parity.test.mjs proves the two agree on the shared conformance
# fixture whenever pkg/ is present.
#
# Requires a rustup toolchain with the wasm32 target and a matching
# wasm-bindgen. The preferred path is wasm-pack; if it is not installed we fall
# back to cargo + wasm-bindgen directly.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

WASM_BINDGEN_VERSION="0.2.126"

if command -v wasm-pack >/dev/null 2>&1; then
  exec wasm-pack build --release --target web --out-dir sdk/pkg --out-name zed_sync_core -- --features wasm
fi

echo "wasm-pack not found; using cargo + wasm-bindgen ($WASM_BINDGEN_VERSION)" >&2
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "install it: cargo install wasm-bindgen-cli --version $WASM_BINDGEN_VERSION" >&2
  exit 1
fi

cargo build --release --lib --target wasm32-unknown-unknown --features wasm
wasm-bindgen \
  --target web \
  --out-dir sdk/pkg \
  --out-name zed_sync_core \
  target/wasm32-unknown-unknown/release/zed_sync_core.wasm

echo "built sdk/pkg/ (zed_sync_core.js + .wasm)" >&2
