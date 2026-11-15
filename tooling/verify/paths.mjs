// Path matching for the obligations map, and the rule a gated CI job runs by. No dependencies: the
// Kubernetes e2e workflow's `changes` job runs gate.mjs before anything is installed.

/**
 * A glob as GitHub's path filters read it: `*` and `?` stay within one path segment, `**` crosses
 * them, `{a,b}` is either, and a leading dot is an ordinary character (node's `path.matchesGlob`
 * would let `**` skip `.github/`).
 */
export function globToRegExp(glob) {
  let source = "";
  let braces = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      const slash = glob[index + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") {
      braces += 1;
      source += "(?:";
    } else if (char === "}" && braces > 0) {
      braces -= 1;
      source += ")";
    } else if (char === "," && braces > 0) source += "|";
    else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Whether `file` (a repo-relative path) matches any of `globs`. */
export function matchesAny(file, globs) {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

/**
 * Whether a gated job runs for these changed files: the first file the map entry `id` covers, or
 * undefined when it covers none. The one rule both CI (gate.mjs) and `pnpm verify plan` apply. A
 * gated entry lists its own `paths`: a workflow's path filter would stop the whole workflow, roll-up
 * included, and a required roll-up that never reports blocks the merge.
 */
export function gateHit(obligations, id, files) {
  const entry = obligations.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`obligations.json has no entry ${id}`);
  if (!Array.isArray(entry.paths))
    throw new Error(`obligations.json: ${id} gates jobs, so it lists its own paths`);
  return files.find((file) => matchesAny(file, entry.paths));
}
