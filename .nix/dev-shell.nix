{
  pkgs,
  agentCheck,
  toolchain,
}:
pkgs.mkShell {
  packages = toolchain ++ [ agentCheck ];

  LANG = if pkgs.stdenv.hostPlatform.isDarwin then "en_US.UTF-8" else "C.UTF-8";
  LC_ALL = if pkgs.stdenv.hostPlatform.isDarwin then "en_US.UTF-8" else "C.UTF-8";

  shellHook = ''
    export NIX_DEV_SHELL=zed-sync
    export NIX_AGENT_CACHE_ROOT="''${NIX_AGENT_CACHE_ROOT:-$PWD/.cache/nix-agent}"
    export RUSTUP_HOME="''${RUSTUP_HOME:-$NIX_AGENT_CACHE_ROOT/rustup}"
    export CARGO_HOME="''${CARGO_HOME:-$NIX_AGENT_CACHE_ROOT/cargo}"
    export CARGO_TARGET_DIR="''${CARGO_TARGET_DIR:-$NIX_AGENT_CACHE_ROOT/target}"
    export npm_config_cache="''${npm_config_cache:-$NIX_AGENT_CACHE_ROOT/npm}"
    export PUB_CACHE="''${PUB_CACHE:-$NIX_AGENT_CACHE_ROOT/dart}"
    export XDG_CACHE_HOME="''${XDG_CACHE_HOME:-$NIX_AGENT_CACHE_ROOT/xdg}"
    mkdir -p \
      "$RUSTUP_HOME" \
      "$CARGO_HOME" \
      "$CARGO_TARGET_DIR" \
      "$npm_config_cache" \
      "$PUB_CACHE" \
      "$XDG_CACHE_HOME"
  '';
}
