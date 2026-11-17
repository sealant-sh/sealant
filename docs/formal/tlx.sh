#!/usr/bin/env bash
# Prints the path of tlx, the TLA+ model checker that every docs/formal/<area>/check.sh runs, built
# from github.com/tlaplus-x/tlx at the one commit this file pins. When this machine has no build of
# that commit it builds one first: a shallow fetch of the commit and `cargo build --release`, about
# 3 minutes on a hosted runner's four cores. It needs git, a C compiler as `cc`, and cargo (rustup reads
# tlx's rust-toolchain.toml) or, without cargo, Nix, whose Rust comes from this repository's
# flake.lock.
#
#   docs/formal/tlx.sh            the path, building tlx first when it is missing
#   docs/formal/tlx.sh --built    the path only if it is already built; exit 1 otherwise
#   docs/formal/tlx.sh --commit   the pinned commit
#
# The build is kept in ${TLX_CACHE:-$XDG_CACHE_HOME/sealant/tlx}/<commit>/tlx ($XDG_CACHE_HOME
# defaults to ~/.cache). CI caches that directory under a key made from this file, so moving the pin
# rebuilds it. CARGO_BUILD_JOBS caps the build's jobs; on a shared machine set it.
#
# Exit status 0: the path is on stdout (the build's output goes to stderr). 1: --built and no build.
# 2: tlx is not built and cannot be (no git, cc, cargo or Nix, or the build failed).
set -euo pipefail

# The tlx commit every model is checked with. tlx is version 0.1 with no releases; this is the commit
# the cases' pinned state counts were last compared against TLC's at (SLNT-1081).
commit=8d5f082b0f0d922bf5999d9a8db00c70a4c1d261

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
dir=${TLX_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/sealant/tlx}/$commit
bin=$dir/tlx

case "${1:-}" in
  --commit)
    echo "$commit"
    exit 0
    ;;
  --built | "") ;;
  *)
    echo "usage: docs/formal/tlx.sh [--built | --commit]" >&2
    exit 2
    ;;
esac
if [[ -x "$bin" ]]; then
  echo "$bin"
  exit 0
fi
[[ "${1:-}" != --built ]] || exit 1

for tool in git cc; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "tlx is not built, and building it needs $tool." >&2
    exit 2
  }
done
if command -v cargo >/dev/null 2>&1; then
  cargo=(cargo)
elif command -v nix >/dev/null 2>&1; then
  # The Rust of the nixpkgs this repository's flake.lock pins.
  cargo=(nix shell --inputs-from "$root" nixpkgs#cargo nixpkgs#rustc -c cargo)
else
  echo "tlx is not built, and building it needs cargo (rustup.rs) or Nix." >&2
  exit 2
fi

src=$(mktemp -d -t tlx-src.XXXXXX)
trap 'rm -rf -- "$src"' EXIT
echo "Building tlx at $commit into $dir (once per commit; about 3 minutes on four cores)." >&2
{
  git init -q "$src"
  git -C "$src" fetch -q --depth 1 https://github.com/tlaplus-x/tlx "$commit"
  git -C "$src" checkout -q FETCH_HEAD
  (cd "$src" && "${cargo[@]}" build --release --locked --bin tlx)
} >&2 || {
  echo "Building tlx failed; nothing was installed." >&2
  exit 2
}
mkdir -p "$dir"
cp "$src/target/release/tlx" "$bin.partial"
mv "$bin.partial" "$bin"
echo "$bin"
