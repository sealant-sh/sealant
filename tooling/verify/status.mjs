// `pnpm verify status`: for each obligation the current diff owes, whether a passing result exists
// for this exact commit, made from a clean tree. The receipt a PR body or verdict comment carries.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { decodeResult, resultPath } from "./result.mjs";

/** The newest valid result of each verb in `.verify/latest/`, with the path it is kept at. */
export function readLatest(root) {
  const directory = path.join(root, ".verify", "latest");
  if (!existsSync(directory)) return [];
  const results = [];
  for (const name of readdirSync(directory).toSorted()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(".verify", "latest", name);
    try {
      const result = decodeResult(JSON.parse(readFileSync(path.join(root, file), "utf8")));
      results.push({ file: resultPath(result), result });
    } catch {
      // A result from an older schema or a half-written file proves nothing; it is ignored.
    }
  }
  return results;
}

/**
 * Judges each owed item against the latest results. `implemented` is the set of verbs this repo
 * has, so an item whose proof needs a verb that does not exist yet says so rather than "not run".
 */
export function judge({ owed, latest, head, implemented }) {
  return owed.map((item) => {
    const base = { ...item };
    const verb = item.proof.split(":")[0];
    const proving = latest.find(({ result }) => (result.proves ?? []).includes(item.proof));
    if (proving !== undefined) {
      const { result, file } = proving;
      if (result.head.sha === head.sha && !result.head.dirty) {
        return {
          ...base,
          status: result.status,
          evidence: file,
          detail: `${result.verb}: ${result.status}`,
        };
      }
      return {
        ...base,
        status: "skipped",
        evidence: file,
        detail: `the newest result is for ${result.head.sha.slice(0, 8)}${result.head.dirty ? " with a dirty tree" : ""}, not this commit`,
      };
    }
    if (item.kind === "external") {
      return {
        ...base,
        status: "requires_external_observer",
        detail: item.what ?? "cannot be proved from here",
      };
    }
    if (item.ci !== undefined && !implemented.has(verb)) {
      return { ...base, status: "skipped", detail: `not run here; CI runs it (${item.ci})` };
    }
    if (!implemented.has(verb)) {
      return {
        ...base,
        status: "not_implemented",
        detail: `\`pnpm verify ${verb}\` does not exist yet`,
      };
    }
    return { ...base, status: "skipped", detail: "not run for this commit" };
  });
}

/** The receipt: one line per obligation with its status and evidence. */
export function toMarkdown({ head, judged }) {
  const lines = [
    `### Verification of ${head.sha.slice(0, 8)}${head.dirty ? " (dirty tree)" : ""}`,
    "",
  ];
  if (judged.length === 0) lines.push("Nothing owed.");
  for (const item of judged) {
    const mark = item.status === "passed" ? "x" : " ";
    const evidence = item.evidence === undefined ? "" : ` (\`${item.evidence}\`)`;
    const how = item.command === undefined ? "" : ` \`${item.command}\``;
    lines.push(
      `- [${mark}] **${item.id}**: ${item.status}${evidence}.${how} ${item.detail ?? ""}`.trimEnd(),
    );
  }
  return `${lines.join("\n")}\n`;
}
