#!/usr/bin/env bash
# Model-checks Boat custody with TLC or tlx: the run ledger (BoatRunLedger.tla) and the full
# check's ledger (BoatKeyProof.tla). Each case in cases/ names its module, the verdict it must give,
# its group and, if it must pass, the distinct states it must reach.
#
#   docs/verification/boat-custody/check.sh                the fast cases (about three minutes on 32 cores)
#   docs/verification/boat-custody/check.sh --deep         the fast and the deep cases (about 40 minutes)
#   docs/verification/boat-custody/check.sh ledger         the named cases only
#   ... --trace                                            also print the counterexample of expected failures
#   ... --engine tlx                                       any of these with tlx instead of TLC
#
# Exit status 0: every case gave its expected verdict, and every case that must pass reached the
# distinct-state count its `states` header pins. 1: one did not; a wrong verdict prints its
# counterexample. 2: no checker, or a wrong argument.
#
# TLC is the reference: the run that goes with a change to a model, or to the code it models, uses
# TLC. It is $TLC if set (a command), else `tlc` on PATH, else the TLA+ tools pinned by this
# repository's flake.lock (`nix shell --inputs-from . nixpkgs#tlaplus`, TLC 2.19 / tools 1.7.4),
# else `java` with $TLA2TOOLS_JAR.
#
# tlx (github.com/tlaplus-x/tlx, version 0.1) is for iterating: `--engine tlx`, `--engine=tlx` or
# BOAT_CUSTODY_ENGINE=tlx. It is the binary in $BOAT_CUSTODY_TLX if set, else `tlx` on PATH. It
# runs with -tlc, so its verdicts, counts and traces are TLC's; trace.mjs reads either checker's.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../../.." && pwd)
deep=0
trace=0
named=()
engine=${BOAT_CUSTODY_ENGINE:-tlc}
# The help is the comment block at the top of this file.
usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deep) deep=1 ;;
    --trace) trace=1 ;;
    --engine)
      [[ $# -ge 2 ]] || {
        echo "--engine needs tlc or tlx" >&2
        exit 2
      }
      engine=$2
      shift
      ;;
    --engine=*) engine=${1#--engine=} ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "unknown option: $1" >&2
      exit 2
      ;;
    *) named+=("${1%.cfg}") ;;
  esac
  shift
done
case "$engine" in
  tlc | tlx) ;;
  *)
    echo "unknown engine $engine; it is tlc or tlx" >&2
    exit 2
    ;;
esac

if [[ "$engine" == tlx ]]; then
  tlx=${BOAT_CUSTODY_TLX:-$(command -v tlx || true)}
  if [[ -z "$tlx" || ! -x "$tlx" ]]; then
    if [[ -n "${BOAT_CUSTODY_TLX:-}" ]]; then
      echo "BOAT_CUSTODY_TLX is $BOAT_CUSTODY_TLX, which is not an executable; nothing was checked." >&2
    else
      echo "No tlx on PATH and BOAT_CUSTODY_TLX is not set; nothing was checked." >&2
    fi
    echo "Build it as README.md beside this script says and set BOAT_CUSTODY_TLX to it, or run with TLC (the default)." >&2
    exit 2
  fi
  # -tlc: TLC's verdicts, counts, depth and shortest traces, which the `states` headers pin.
  checker=("$tlx" check -tlc)
  checker_name=tlx
elif [[ -n "${TLC:-}" ]]; then
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
if [[ "$engine" == tlc ]]; then
  checker=("${tlc[@]}")
  checker_name=TLC
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
# (tlx keeps its compiled code in ~/.cache/tlx, which this script leaves alone.)
[[ "$engine" == tlx ]] || export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$scratch ${JAVA_TOOL_OPTIONS:-}"

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
  pinned=$(header "$cfg" states | tr -d ,)
  out="$scratch/$name.out"
  started=$(date +%s)
  (cd "$here" && "${checker[@]}" -workers auto -metadir "$scratch/meta-$name" -config "$cfg" "$module.tla") \
    >"$out" 2>&1 || true
  seconds=$(($(date +%s) - started))
  if [[ $version_shown -eq 0 ]]; then
    if [[ "$engine" == tlx ]]; then
      echo "$(grep -m 1 '^tlx version' "$out" || echo 'tlx (version unknown)') ($tlx)"
    else
      grep -m 1 '^TLC2 Version' "$out" || true
    fi
    version_shown=1
  fi
  if grep -q '^Model checking completed. No error has been found.' "$out"; then
    got=pass
  elif violated=$(sed -n 's/^Error: Invariant \([A-Za-z0-9_]*\) is violated\.$/\1/p' "$out" | head -n 1) &&
    [[ -n "$violated" ]]; then
    got=$violated
  elif grep -q -E '^Error: Temporal (properties were|property [A-Za-z0-9_]+ was) violated' "$out"; then
    # TLC: "Temporal properties were violated."; tlx: "Temporal property <Name> was violated."
    got=temporal
  else
    got=error
  fi
  states=$(sed -n 's/^.* states generated, \([0-9,]*\) distinct states found.*$/\1/p' "$out" | tail -n 1 | tr -d ,)
  # A case that must pass explores every reachable state, so its count is the same on every run and
  # for both checkers; the `states` header pins it, and a checker that passes over a different state
  # space fails the case. A case that must fail runs on every core, where workers race after the
  # violation and the count differs from run to run: those cases pin no count.
  if [[ "$got" == "$expect" && -n "$pinned" && "${states:-?}" != "$pinned" ]]; then
    unexpected=1
    keep=1
    printf 'FAIL  %-42s %s as expected, but %s states where the case pins %s (%ss)\n' \
      "$name" "$got" "${states:-?}" "$pinned" "$seconds"
    echo "        $checker_name's whole output: $out"
  elif [[ "$got" == "$expect" ]]; then
    printf 'ok    %-42s %-24s %8s states  %4ss\n' "$name" "$got" "${states:-?}" "$seconds"
    if [[ $trace -eq 1 && "$got" != pass ]]; then node "$here/trace.mjs" <"$out" | sed 's/^/        /'; fi
  else
    unexpected=1
    keep=1
    printf 'FAIL  %-42s expected %s, got %s (%ss)\n' "$name" "$expect" "$got" "$seconds"
    if [[ "$got" == error ]]; then
      grep -E 'Error|error|Exception|line [0-9]+' "$out" | head -n 20 | sed 's/^/        /'
    else
      node "$here/trace.mjs" <"$out" | sed 's/^/        /'
    fi
    echo "        $checker_name's whole output: $out"
  fi
done

if [[ $unexpected -ne 0 ]]; then
  echo "Some cases did not give their expected verdict or count. See the boat-custody skill: a real break, or a model to update."
  exit 1
fi
echo "Every case gave its expected verdict."
