#!/usr/bin/env node
// Checks a packed npm tarball before it goes anywhere near the publish job (ADR 0015 in
// sealant-sh/mend): every entry sits under package/, there is exactly one package/package.json, and
// every file the manifest points at (exports, main, module, types, typings, bin) is in the tarball.
// A package packed without its build has none of its dist/ and is refused here.
//
// The same file lives in sealant-sh/sealant (tooling/scripts/) and sealant-sh/sealantd (scripts/).
// Keep them identical.
//
//   node check-tarball.mjs <tarball>...
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Every file path a manifest points at, as written (`./dist/index.js`, `./dist/*.js`). */
export const manifestTargets = (manifest) => {
  const targets = [];
  const walk = (value) => {
    if (typeof value === "string") targets.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(manifest.exports);
  for (const field of ["main", "module", "types", "typings"]) walk(manifest[field]);
  walk(manifest.bin);
  return [...new Set(targets)];
};

const entryOf = (target) => `package/${target.replace(/^\.\//, "")}`;

/** What is wrong with a tarball, given its entries (`tar -tzf`) and its package/package.json. */
export const tarballProblems = (entries, manifest) => {
  const problems = [];
  const outside = entries.filter((entry) => !entry.startsWith("package/"));
  if (outside.length > 0) problems.push(`entries outside package/: ${outside.join(", ")}`);
  const manifests = entries.filter((entry) => entry === "package/package.json").length;
  if (manifests !== 1) problems.push(`${manifests} package/package.json entries, not 1`);
  const files = new Set(entries);
  for (const target of manifestTargets(manifest)) {
    const entry = entryOf(target);
    const present = entry.includes("*")
      ? entries.some((candidate) =>
          new RegExp(
            `^${entry
              .split("*")
              .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
              .join(".+")}$`,
          ).test(candidate),
        )
      : files.has(entry);
    if (!present) problems.push(`${target} is not in the tarball`);
  }
  return problems;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let failed = false;
  for (const tarball of process.argv.slice(2)) {
    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
    );
    const problems = tarballProblems(entries, manifest);
    for (const problem of problems) console.error(`::error::${tarball}: ${problem}`);
    if (problems.length > 0) failed = true;
    else console.log(`${tarball}: ${entries.length} entries; every exported file is there.`);
  }
  process.exit(failed ? 1 : 0);
}
