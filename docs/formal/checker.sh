# Sourced by each docs/formal/<area>/check.sh. Reads `engine` (tlx or tlc) and `root` (the
# repository), and sets `checker` (the command, as an array) and `checker_name`, or exits 2 when
# there is no such checker.
#
# tlx (github.com/tlaplus-x/tlx) is the checker every model is run with: on a developer's machine, in
# CI and nightly. It is $TLX if set (a path, for trying another build), else the build of the commit
# docs/formal/tlx.sh pins, built on first use. It runs with -tlc, tlx's mode that promises TLC's
# verdicts, distinct-state counts, depth and shortest traces, so the cases' pinned counts hold for
# both checkers and trace.mjs reads either's counterexamples.
#
# TLC is kept for a cross-check by hand (`check.sh --engine tlc`); nothing scheduled runs it. It is
# $TLC if set (a command), else `tlc` on PATH, else the TLA+ tools pinned by this repository's
# flake.lock (`nix shell --inputs-from . nixpkgs#tlaplus`, TLC 2.19 / tools 1.7.4), else `java` with
# $TLA2TOOLS_JAR.

case "$engine" in
  tlx)
    if [[ -n "${TLX:-}" ]]; then
      tlx=$TLX
    else
      code=0
      tlx=$("$root/docs/formal/tlx.sh") || code=$?
      [[ $code -eq 0 ]] || exit 2
    fi
    if [[ ! -x "$tlx" ]]; then
      echo "TLX is $tlx, which is not an executable; nothing was checked." >&2
      exit 2
    fi
    checker=("$tlx" check -tlc)
    checker_name=tlx
    ;;
  tlc)
    if [[ -n "${TLC:-}" ]]; then
      read -r -a checker <<<"$TLC"
    elif command -v tlc >/dev/null 2>&1; then
      checker=(tlc)
    elif command -v nix >/dev/null 2>&1; then
      # The nixpkgs this repository's flake.lock pins: the same TLC for everyone, fetched once.
      tools=$(nix build --no-link --print-out-paths --inputs-from "$root" nixpkgs#tlaplus \
        2> >(grep -v "is dirty" >&2))
      checker=("$tools/bin/tlc")
    elif [[ -n "${TLA2TOOLS_JAR:-}" ]] && command -v java >/dev/null 2>&1; then
      checker=(java -XX:+UseParallelGC -cp "$TLA2TOOLS_JAR" tlc2.TLC)
    else
      echo "No TLC found. Install Nix (the repository pins the TLA+ tools), or set" >&2
      echo "TLA2TOOLS_JAR to tla2tools.jar 1.7.4 from github.com/tlaplus/tlaplus/releases." >&2
      exit 2
    fi
    checker_name=TLC
    ;;
  *)
    echo "unknown engine $engine; it is tlx or tlc" >&2
    exit 2
    ;;
esac
