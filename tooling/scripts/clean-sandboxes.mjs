import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sandboxGroups = ["apps", "packages", "tooling"];

const candidates = [resolve(repoRoot, "node_modules")];

for (const group of sandboxGroups) {
  const groupPath = resolve(repoRoot, group);
  let entries = [];

  try {
    entries = await readdir(groupPath, { withFileTypes: true });
  } catch {
    continue;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    candidates.push(resolve(groupPath, entry.name, "node_modules"));
  }
}

let hadFailure = false;

for (const candidate of candidates) {
  try {
    await rm(candidate, { force: true, recursive: true });
    console.log(`removed ${candidate}`);
  } catch (error) {
    hadFailure = true;
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`failed to remove ${candidate}: ${message}`);
  }
}

if (hadFailure) {
  process.exitCode = 1;
}
