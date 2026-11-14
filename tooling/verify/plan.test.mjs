import assert from "node:assert/strict";
import test from "node:test";

import { matchesAny } from "./plan.mjs";

// The map's globs and the workflows' path filters must match the same files GitHub matches, or the
// plan and the pull request disagree about what runs.
test("globs match as GitHub's path filters do", () => {
  const cases = [
    ["**", ".github/workflows/ci.yml", true],
    ["packages/workspaces/boat-harness/**", "packages/workspaces/boat-harness/a/b.ts", true],
    ["packages/workspaces/boat-harness/**", "packages/workspaces/boat-harness-x/a.ts", false],
    [
      "packages/workspaces/src/worker/boat-*.ts",
      "packages/workspaces/src/worker/boat-assembly.ts",
      true,
    ],
    [
      "packages/workspaces/src/worker/boat-*.ts",
      "packages/workspaces/src/worker/x/boat-a.ts",
      false,
    ],
    ["**/*.db.test.ts", "retention.db.test.ts", true],
    ["**/*.db.test.ts", "apps/api/src/a.db.test.ts", true],
    ["**/*.db.test.ts", "apps/api/src/adb.test.ts", false],
    ["docs/{a,b}.md", "docs/b.md", true],
    ["docs/a.md", "docs/aamd", false],
  ];
  for (const [glob, file, expected] of cases) {
    assert.equal(
      matchesAny(file, [glob]),
      expected,
      `${glob} ${expected ? "matches" : "misses"} ${file}`,
    );
  }
});
