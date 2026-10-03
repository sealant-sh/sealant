/**
 * What a run changed in a workspace's repository: the diff of the working tree (tracked edits and
 * new untracked files, as `git add -A` would stage them) against HEAD, plus `--name-status`.
 *
 * The staging happens in a THROWAWAY index: a temporary copy of the repository's index, named
 * by `GIT_INDEX_FILE`, removed on exit. The repository's own index — what the user (or their
 * agent) staged, partially staged, or deliberately left unstaged — is never written, so reading
 * the changes never changes git state. A refreshed copy of that index is kept in `$TMPDIR`, named
 * by the repository and the index's checksum, and the next reading starts from it: same entries,
 * fresher stat data. One shell invocation produces both outputs, split by a
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
    'tmp=$(mktemp "${TMPDIR:-/tmp}/sealant-index.XXXXXX") || exit 1',
    `trap 'rm -f "$tmp" "$tmp.lock"' EXIT`,
    // An empty file is not a valid index: start from the real one, or from none at all.
    'if [ -f "$real" ]; then',
    // The copy starts from a kept one when there is one for this very index (same repository,
    // same bytes): its stat data is refreshed, so `git add -A` rehashes nothing it need not. A
    // restored or freshly checked-out worktree's index marks every file written in its own
    // second as possibly changed, and nothing rewrites it until a git command does, so without
    // the kept copy every reading rehashed the whole tree (~330 ms for 1 800 files).
    '  repo=$(git rev-parse --absolute-git-dir | cksum | cut -d" " -f1)',
    '  keep="${TMPDIR:-/tmp}/sealant-index-$repo-$(cksum < "$real" | cut -d" " -f1,2 | tr " " .)"',
    '  if [ -f "$keep" ]; then cp "$keep" "$tmp"; else cp "$real" "$tmp"; fi',
    '  GIT_INDEX_FILE="$tmp" git update-index -q --refresh >/dev/null 2>&1',
    '  for old in "${TMPDIR:-/tmp}/sealant-index-$repo-"*; do [ "$old" = "$keep" ] || rm -f "$old"; done',
    '  cp "$tmp" "$keep.$$" 2>/dev/null && mv -f "$keep.$$" "$keep" 2>/dev/null',
    "else",
    '  rm -f "$tmp"',
    "fi",
    'GIT_INDEX_FILE="$tmp" git add -A >/dev/null 2>&1',
    'GIT_INDEX_FILE="$tmp" git --no-pager diff --cached 2>/dev/null',
    "printf '\\0sealant-name-status\\0'",
    'GIT_INDEX_FILE="$tmp" git --no-pager diff --cached --name-status 2>/dev/null',
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
