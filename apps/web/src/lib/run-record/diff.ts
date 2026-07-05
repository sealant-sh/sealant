/**
 * Minimal unified-diff parser for the run's server-captured `git diff` output. Produces per-file
 * hunks the Changes rail renders with 2px edge marks (never flooded blocks, per DESIGN.md).
 */

export interface DiffLine {
  readonly sign: "add" | "del" | "context" | "hunk";
  readonly text: string;
}

export interface DiffFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly lines: readonly DiffLine[];
  readonly additions: number;
  readonly deletions: number;
}

const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

export const parseUnifiedDiff = (diff: string): DiffFile[] => {
  const files: DiffFile[] = [];
  let path: string | undefined;
  let oldPath: string | undefined;
  let lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let inHunk = false;

  const flush = (): void => {
    if (path !== undefined) {
      files.push({
        path,
        ...(oldPath === undefined || oldPath === path ? {} : { oldPath }),
        lines,
        additions,
        deletions,
      });
    }
    path = undefined;
    oldPath = undefined;
    lines = [];
    additions = 0;
    deletions = 0;
    inHunk = false;
  };

  for (const raw of diff.split("\n")) {
    const header = FILE_HEADER.exec(raw);
    if (header !== null) {
      flush();
      oldPath = header[1];
      path = header[2];
      continue;
    }
    if (path === undefined) {
      continue;
    }
    if (raw.startsWith("@@")) {
      inHunk = true;
      lines.push({ sign: "hunk", text: raw });
      continue;
    }
    if (!inHunk) {
      // index/---/+++ and mode metadata between the file header and the first hunk.
      continue;
    }
    if (raw.startsWith("+")) {
      additions += 1;
      lines.push({ sign: "add", text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      deletions += 1;
      lines.push({ sign: "del", text: raw.slice(1) });
    } else if (raw.startsWith(" ") || raw.length === 0) {
      lines.push({ sign: "context", text: raw.slice(1) });
    } else if (raw.startsWith("\\")) {
      lines.push({ sign: "context", text: raw });
    }
  }
  flush();
  return files;
};
