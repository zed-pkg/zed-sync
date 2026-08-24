#!/usr/bin/env bash
set -euo pipefail

export CI="${CI:-1}"
export NO_COLOR="${NO_COLOR:-1}"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

cache_root="${NIX_AGENT_CACHE_ROOT:-$repo_root/.cache/nix-agent}"
export RUSTUP_HOME="${RUSTUP_HOME:-$cache_root/rustup}"
export CARGO_HOME="${CARGO_HOME:-$cache_root/cargo}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$cache_root/target}"
export npm_config_cache="${npm_config_cache:-$cache_root/npm}"
export PUB_CACHE="${PUB_CACHE:-$cache_root/dart}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$cache_root/xdg}"
mkdir -p "$RUSTUP_HOME" "$CARGO_HOME" "$CARGO_TARGET_DIR" "$npm_config_cache" "$PUB_CACHE" "$XDG_CACHE_HOME"

rust_toolchain=1.89.0

ensure_rust() {
  rustup toolchain install "$rust_toolchain" \
    --profile minimal \
    --component rustfmt \
    --component clippy \
    --target wasm32-unknown-unknown
}

run_stage() {
  local stage="$1"
  printf '\n==> agent-check stage: %s\n' "$stage"

  case "$stage" in
    preflight)
      git diff --check
      nixfmt --check flake.nix .nix/dev-shell.nix
      shellcheck .nix/agent-check.sh sdk/build-wasm.sh
      shfmt -i 2 -ci -d .nix/agent-check.sh sdk/build-wasm.sh
      actionlint .github/workflows/*.yml
      nix flake check --no-update-lock-file --show-trace
      ;;
    rust)
      ensure_rust
      cargo "+$rust_toolchain" fmt --check
      cargo "+$rust_toolchain" clippy --workspace --all-targets -- -D warnings
      cargo "+$rust_toolchain" test --workspace
      ;;
    typescript)
      (
        cd sdk
        npm ci
        npm run typecheck
        npm test
      )
      ;;
    dart)
      (
        cd dart/zed_sync
        dart pub get
        dart format --output=none --set-exit-if-changed lib test
        dart analyze
        dart test
      )
      ;;
    formal)
      npx --yes --package=@informalsystems/quint@0.32.0 quint typecheck formal/write_lifecycle.qnt
      npx --yes --package=@informalsystems/quint@0.32.0 quint typecheck formal/app_lifecycle.qnt
      npx --yes --package=@informalsystems/quint@0.32.0 quint run \
        formal/write_lifecycle.qnt \
        --main=write_lifecycle \
        --init=init \
        --step=step \
        --backend=typescript \
        --max-samples=10000 \
        --max-steps=24 \
        --invariants write_lifecycle_safety \
        --witnesses late_ack_preserves_newest_write retry_after_disconnect_reached server_wins_conflict_reached duplicate_ack_reached
      npx --yes --package=@informalsystems/quint@0.32.0 quint verify \
        formal/write_lifecycle.qnt \
        --main=write_lifecycle \
        --init=init \
        --step=step \
        --backend=tlc \
        --invariants write_lifecycle_safety
      npx --yes --package=@informalsystems/quint@0.32.0 quint run \
        formal/app_lifecycle.qnt \
        --main=app_lifecycle \
        --init=init \
        --step=step \
        --backend=typescript \
        --max-samples=10000 \
        --max-steps=24 \
        --invariants app_lifecycle_safety \
        --witnesses online_reached offline_reached failed_reached stale_completion_reached rejected_transition_reached failure_reconciliation_reached
      npx --yes --package=@informalsystems/quint@0.32.0 quint verify \
        formal/app_lifecycle.qnt \
        --main=app_lifecycle \
        --init=init \
        --step=step \
        --backend=tlc \
        --invariants app_lifecycle_safety
      ;;
    wasm)
      ensure_rust
      ./sdk/build-wasm.sh
      node --test sdk/test/wasm-parity.test.mjs
      ;;
    all)
      local child
      for child in preflight rust typescript dart wasm formal; do
        run_stage "$child"
      done
      ;;
    *)
      printf 'unknown agent-check stage: %s\n' "$stage" >&2
      return 64
      ;;
  esac
}

case "${1:-all}" in
  all | preflight | rust | typescript | dart | wasm | formal)
    run_stage "${1:-all}"
    ;;
  *)
    printf 'usage: agent-check [all|preflight|rust|typescript|dart|wasm|formal]\n' >&2
    exit 64
    ;;
esac
