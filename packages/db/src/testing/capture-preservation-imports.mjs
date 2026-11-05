import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const probes = [
  ["packages/db/src/repositories", "./capture-preservation.js"],
  ["packages/db/src/repositories", "./capture-preservation.ts"],
  ["packages/db/src", "./schema/capture-preservation"],
  ["packages/workspaces/src/worker", "../../../db/src/repositories/capture-preservation.js"],
  ["apps/api/src/routes", "../../../../../packages/db/src/schema/capture-preservation.js"],
  ["apps/api/src/routes", "@sealant/db/testing/capture-preservation"],
];

for (const [directory, specifier] of probes) {
  const path = join(root, directory, `.parking-import-${randomUUID()}.ts`);
  try {
    await writeFile(
      path,
      `import { probe } from ${JSON.stringify(specifier)};\nexport { probe };\n`,
      { flag: "wx" },
    );
    const result = spawnSync("pnpm", ["exec", "oxlint", "--format", "json", path], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      1,
      `expected lint rejection for ${directory}: ${specifier}\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(
      result.stdout,
      /no-restricted-imports/,
      `missing ownership rejection for ${specifier}`,
    );
    console.log(`Rejected ${directory}: ${specifier}`);
  } finally {
    console.log(`Removing owned probe ${path}`);
    await rm(path, { force: true });
  }
}
console.log(`${probes.length} ownership probes passed; zero skipped`);
