#!/usr/bin/env bash
# Model-checks Boat custody: the run ledger (BoatRunLedger.tla) and the full check's ledger
# (BoatKeyProof.tla). Each case in cases/ names its module, the verdict it must give and its group.
#
#   docs/verification/boat-custody/check.sh            the fast cases (about three minutes on 32 cores)
#   docs/verification/boat-custody/check.sh --deep     the fast and the deep cases (about 40 minutes)
#   docs/verification/boat-custody/check.sh ledger     the named cases only
#   ... --trace                                        also print the counterexample of expected failures
#
# Exit status 0: every case gave its expected verdict. 1: one did not; its counterexample is printed.
# The checker: $TLC if set (a command), else `tlc` on PATH, else the TLA+ tools pinned by this
# repository's flake.lock (`nix shell --inputs-from . nixpkgs#tlaplus`, TLC 2.19 / tools 1.7.4),
# else `java` with $TLA2TOOLS_JAR.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../../.." && pwd)
deep=0
trace=0
named=()
for arg in "$@"; do
  case "$arg" in
    --deep) deep=1 ;;
    --trace) trace=1 ;;
    -h | --help)
      sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
    *) named+=("${arg%.cfg}") ;;
  esac
done

if [[ -n "${TLC:-}" ]]; then
  read -r -a tlc <<<"$TLC"
elif command -v tlc >/dev/null 2>&1; then
  tlc=(tlc)
elif command -v nix >/dev/null 2>&1; then
  # The nixpkgs this repository's flake.lock pins: the same TLC for everyone, fetched once.
  tools=$(nix build --no-link --print-out-paths --inputs-from "$root" nixpkgs#tlaplus \
    2> >(grep -v "is dirty" >&2))
  tlc=("$tools/bin/tlc")
elif [[ -n "${TLA2TOOLS_JAR:-}" ]] && command -v java >/dev/null 2>&1; then
  tlc=(java -XX:+UseParallelGC -cp "$TLA2TOOLS_JAR" tlc2.TLC)
else
  echo "No TLA+ model checker found. Install Nix (the repository pins the tools), or set" >&2
  echo "TLA2TOOLS_JAR to tla2tools.jar 1.7.4 from github.com/tlaplus/tlaplus/releases." >&2
  exit 2
fi
command -v node >/dev/null 2>&1 || {
  echo "node is needed to print counterexamples (it is in the repository's dev shell)." >&2
  exit 2
}

scratch=$(mktemp -d -t boat-custody-check.XXXXXX)
keep=0
cleanup() { if [[ $keep -eq 0 ]]; then rm -rf -- "$scratch"; fi; }
trap cleanup EXIT
# TLC unpacks its standard modules into java.io.tmpdir: keep them in this run's scratch directory.
export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$scratch ${JAVA_TOOL_OPTIONS:-}"

header() { sed -n "s/^\\\\\\* $2: *//p" "$1" | head -n 1; }

cases=()
if [[ ${#named[@]} -gt 0 ]]; then
  for name in "${named[@]}"; do
    [[ -f "$here/cases/$name.cfg" ]] || {
      echo "no case $name (see $here/cases)" >&2
      exit 2
    }
    cases+=("$here/cases/$name.cfg")
  done
else
  for cfg in "$here"/cases/*.cfg; do
    group=$(header "$cfg" group)
    if [[ "$group" == fast || ($deep -eq 1 && "$group" == deep) ]]; then cases+=("$cfg"); fi
  done
fi

version_shown=0
unexpected=0
for cfg in "${cases[@]}"; do
  name=$(basename "$cfg" .cfg)
  module=$(header "$cfg" module)
  expect=$(header "$cfg" expect)
  out="$scratch/$name.out"
  started=$(date +%s)
  (cd "$here" && "${tlc[@]}" -workers auto -metadir "$scratch/meta-$name" -config "$cfg" "$module.tla") \
    >"$out" 2>&1 || true
  seconds=$(($(date +%s) - started))
  if [[ $version_shown -eq 0 ]]; then
    grep -m 1 '^TLC2 Version' "$out" || true
    version_shown=1
  fi
  if grep -q '^Model checking completed. No error has been found.' "$out"; then
    got=pass
  elif violated=$(sed -n 's/^Error: Invariant \([A-Za-z0-9_]*\) is violated\.$/\1/p' "$out" | head -n 1) &&
    [[ -n "$violated" ]]; then
    got=$violated
  elif grep -q '^Error: Temporal properties were violated' "$out"; then
    got=temporal
  else
    got=error
  fi
  states=$(sed -n 's/^.* states generated, \([0-9,]*\) distinct states found.*$/\1/p' "$out" | tail -n 1)
  if [[ "$got" == "$expect" ]]; then
    printf 'ok    %-36s %-24s %8s states  %4ss\n' "$name" "$got" "${states:-?}" "$seconds"
    if [[ $trace -eq 1 && "$got" != pass ]]; then node "$here/trace.mjs" <"$out" | sed 's/^/        /'; fi
  else
    unexpected=1
    keep=1
    printf 'FAIL  %-36s expected %s, got %s (%ss)\n' "$name" "$expect" "$got" "$seconds"
    if [[ "$got" == error ]]; then
      grep -E 'Error|error|Exception|line [0-9]+' "$out" | head -n 20 | sed 's/^/        /'
    else
      node "$here/trace.mjs" <"$out" | sed 's/^/        /'
    fi
    echo "        TLC's whole output: $out"
  fi
done

if [[ $unexpected -ne 0 ]]; then
  echo "Some cases did not give their expected verdict. See the boat-custody skill: a real break, or a model to update."
  exit 1
fi
echo "Every case gave its expected verdict."
