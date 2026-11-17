#!/usr/bin/env bash
# Model-checks the capture removal ledger (CaptureRemovalLedger.tla) with tlx. Each case in cases/
# names its module, the verdict it must give, its group and, if it must pass, the distinct states it
# must reach.
#
#   docs/formal/capture-removal/check.sh             the fast cases (the quick bounds)
#   docs/formal/capture-removal/check.sh --quick     the same
#   docs/formal/capture-removal/check.sh --deep      the fast and the deep cases (every bound)
#   docs/formal/capture-removal/check.sh ledger      the named cases only
#   ... --trace                                      also print the counterexample of expected failures
#   ... --engine tlc                                 any of these with TLC, for a cross-check by hand
#
# `pnpm verify formal` runs the fast cases when a diff touches a path in COVERAGE, and CI runs them on
# such a pull request; `--deep` runs nightly (`pnpm verify formal --all --full`). FORMAL_WORKERS caps
# the checker's threads (default: one per core); on a shared machine set it.
#
# Exit status 0: every case gave its expected verdict, and every case that must pass reached the
# distinct-state count its `states` header pins. 1: one did not; a wrong verdict prints its
# counterexample. 2: no checker, or a wrong argument.
#
# The checker is tlx, built at the commit docs/formal/tlx.sh pins (on first use: about 3 minutes),
# or $TLX. `--engine tlc`, `--engine=tlc` or FORMAL_ENGINE=tlc runs TLC instead; docs/formal/checker.sh
# says where each is found.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../../.." && pwd)
deep=0
trace=0
named=()
engine=${FORMAL_ENGINE:-tlx}
# The help is the comment block at the top of this file.
usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deep) deep=1 ;;
    --quick) deep=0 ;;
    --trace) trace=1 ;;
    --engine)
      [[ $# -ge 2 ]] || {
        echo "--engine needs tlx or tlc" >&2
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

# shellcheck source=../checker.sh
source "$here/../checker.sh"
command -v node >/dev/null 2>&1 || {
  echo "node is needed to print counterexamples (it is in the repository's dev shell)." >&2
  exit 2
}

scratch=$(mktemp -d -t capture-removal-check.XXXXXX)
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
  (cd "$here" && "${checker[@]}" -workers "${FORMAL_WORKERS:-auto}" -metadir "$scratch/meta-$name" -config "$cfg" "$module.tla") \
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
  else
    got=error
  fi
  states=$(sed -n 's/^.* states generated, \([0-9,]*\) distinct states found.*$/\1/p' "$out" | tail -n 1 | tr -d ,)
  # A case that must pass explores every reachable state, so its count is the same on every run and
  # for both checkers; the `states` header pins it, and a checker that passes over a different state
  # space fails the case. A case that must fail stops at a violation whose count differs
  # from run to run with more than one worker: those cases pin no count.
  if [[ "$got" == "$expect" && -n "$pinned" && "${states:-?}" != "$pinned" ]]; then
    unexpected=1
    keep=1
    printf 'FAIL  %-40s %s as expected, but %s states where the case pins %s (%ss)\n' \
      "$name" "$got" "${states:-?}" "$pinned" "$seconds"
    echo "        $checker_name's whole output: $out"
  elif [[ "$got" == "$expect" ]]; then
    printf 'ok    %-40s %-26s %9s states  %4ss\n' "$name" "$got" "${states:-?}" "$seconds"
    if [[ $trace -eq 1 && "$got" != pass ]]; then node "$here/trace.mjs" <"$out" | sed 's/^/        /'; fi
  else
    unexpected=1
    keep=1
    printf 'FAIL  %-40s expected %s, got %s (%ss)\n' "$name" "$expect" "$got" "$seconds"
    if [[ "$got" == error ]]; then
      grep -E 'Error|error|Exception|line [0-9]+' "$out" | head -n 20 | sed 's/^/        /'
    else
      node "$here/trace.mjs" <"$out" | sed 's/^/        /'
    fi
    echo "        $checker_name's whole output: $out"
  fi
done

if [[ $unexpected -ne 0 ]]; then
  echo "Some cases did not give their expected verdict or count. See the capture-removal skill: a real break, or a model to update."
  exit 1
fi
echo "Every case gave its expected verdict."
