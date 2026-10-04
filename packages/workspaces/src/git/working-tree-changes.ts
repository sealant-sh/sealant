/**
 * What a run changed in a workspace's repository: the diff of the working tree (tracked edits and
 * new untracked files, as `git add -A` would stage them) against HEAD, plus `--name-status`.
 *
 * The staging happens in a THROWAWAY index: a temporary copy of the repository's index, named
 * by `GIT_INDEX_FILE`, removed on exit. The repository's own index — what the user (or their
 * agent) staged, partially staged, or deliberately left unstaged — is never written, so reading
 * the changes never changes git state. A refreshed copy of a snapshot of that index is kept in
 * `$TMPDIR`, named by the repository, the snapshot's checksum and its own, and the next reading of
 * the same index starts from it: same entries, fresher stat data. The script exits nonzero when it
 * could not read the changes. One shell invocation produces both outputs, split by a
 * NUL-delimited separator (a diff never contains NUL; git prints binary files as a summary).
 */

/** Separates the diff from the name-status list in the script's stdout. */
export const WORKING_TREE_CHANGES_SEPARATOR = "\0sealant-name-status\0";

/**
 * A POSIX shell script, run in the repository, that prints the diff, the separator, then the
 * name-status list. Prints nothing (and succeeds) outside a git repository.
 */
export const workingTreeChangesScript = (): string =>
  [
    "real=$(git rev-parse --git-path index 2>/dev/null) || exit 0",
    'dir="${TMPDIR:-/tmp}"',
    'tmp=$(mktemp "$dir/sealant-index.XXXXXX") || exit 1',
    'snap=""',
    `trap 'rm -f "$tmp" "$tmp.lock" \${snap:+"$snap"}' EXIT`,
    // An empty file is not a valid index: start from the real one, or from none at all.
    'if [ -f "$real" ]; then',
    // Every copy keeps its source's mtime (`cp -p`): git trusts an entry's stat data only when the
    // file's mtime is older than the index's own, so a copy stamped "now" would hide an edit made
    // in the same second, of the same size, as the reading that refreshed it.
    // One snapshot of the repository's index, read once: the key, the fallback and the copy that
    // is refreshed and kept are all that one snapshot, so an index replaced meanwhile can never
    // be kept under the other's key. Failing to take it is failing to read the changes.
    '  snap=$(mktemp "$dir/sealant-index.XXXXXX") && cp -p "$real" "$snap" || exit 1',
    // A kept copy for this snapshot (same repository, same bytes) has fresh stat data, so
    // `git add -A` rehashes nothing it need not: a restored or freshly checked-out worktree's
    // index matches none of its files' stat data, and nothing rewrites it until a git command
    // does, so every reading rehashed the whole tree (~330 ms for 1 800 files). A kept copy is
    // named by its own checksum and used only when the bytes copied match it; anything else (a
    // copy removed or replaced meanwhile, a failed copy) falls back to the snapshot. The cache
    // may cost time, never correctness.
    // Every checksum must be numeric, or the cache is not used: a `cksum` missing or failing
    // would key every repository's index the same. `pair X SEP`: X is digits SEP digits.
    `  pair() { a=\${1%%"$2"*}; b=\${1#*"$2"}; [ "$a" != "$1" ] && [ -n "$a" ] && [ -n "$b" ] && case "$a$b" in *[!0-9]*) false ;; esac; }`,
    '  repo=$(git rev-parse --absolute-git-dir | cksum | cut -d" " -f1)',
    '  sum=$(cksum < "$snap" | cut -d" " -f1,2 | tr " " .)',
    "  cache=1",
    '  case "$repo" in ""|*[!0-9]*) cache="" ;; esac',
    '  pair "$sum" . || cache=""',
    '  key="$dir/sealant-index-$repo-$sum"',
    '  hit=""',
    '  if [ -n "$cache" ]; then',
    '    for kept in "$key".*; do',
    '      [ -f "$kept" ] || continue',
    '      got=""',
    '      cp -p "$kept" "$tmp" 2>/dev/null && got=$(cksum < "$tmp" | cut -d" " -f1,2 | tr " " _)',
    '      pair "$got" _ && [ "$kept" = "$key.$got" ] && hit=1',
    "      break",
    "    done",
    "  fi",
    '  [ -n "$hit" ] || cp -p "$snap" "$tmp" || exit 1',
    '  GIT_INDEX_FILE="$tmp" git update-index -q --refresh >/dev/null 2>&1',
    // Published by rename only, under the checksum of exactly what is published.
    '  pub="$dir/sealant-index-$repo.pub.$$"',
    '  if [ -n "$cache" ] && cp -p "$tmp" "$pub" 2>/dev/null; then',
    '    own=$(cksum < "$pub" | cut -d" " -f1,2 | tr " " _)',
    '    mine="$key.$own"',
    '    if pair "$own" _ && mv -f "$pub" "$mine" 2>/dev/null; then',
    // Older copies go; a reader copying one meanwhile finds it does not match and falls back.
    '      for old in "$dir/sealant-index-$repo-"*; do [ "$old" = "$mine" ] || rm -f "$old"; done',
    "    else",
    '      rm -f "$pub"',
    "    fi",
    "  fi",
    "else",
    '  rm -f "$tmp"',
    "fi",
    'GIT_INDEX_FILE="$tmp" git add -A >/dev/null 2>&1 || exit 1',
    'GIT_INDEX_FILE="$tmp" git --no-pager diff --cached 2>/dev/null || exit 1',
    "printf '\\0sealant-name-status\\0'",
    'GIT_INDEX_FILE="$tmp" git --no-pager diff --cached --name-status 2>/dev/null || exit 1',
  ].join("\n");

/** Split the script's stdout; output without the separator (no repository) is no change. */
export const splitWorkingTreeChanges = (
  output: string,
): { readonly diff: string; readonly nameStatus: string } => {
  const at = output.indexOf(WORKING_TREE_CHANGES_SEPARATOR);
  if (at === -1) {
    return { diff: "", nameStatus: "" };
  }
  return {
    diff: output.slice(0, at),
    nameStatus: output.slice(at + WORKING_TREE_CHANGES_SEPARATOR.length),
  };
};
