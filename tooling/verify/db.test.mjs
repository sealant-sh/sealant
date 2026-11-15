import assert from "node:assert/strict";
import test from "node:test";

import { SUITES } from "./db.mjs";
import { REPO_ROOT } from "./repo.mjs";

// The database suite is found by searching for the gates, so a new database test joins it without
// anyone listing it; it must not also run another suite's files, or the Docker-only proofs.
test("the database suite holds every database-gated test file and no other suite's", () => {
  const database = SUITES.database.files(REPO_ROOT);
  for (const file of [
    "packages/jobs/src/service.test.ts",
    "packages/telemetry/src/telemetry.db.test.ts",
    "apps/api/src/routes/workspaces/idempotency-key.db.test.ts",
  ]) {
    assert.ok(database.includes(file), `${file} reads a database gate`);
  }
  for (const [suite, { files }] of Object.entries(SUITES)) {
    if (suite === "database") continue;
    for (const file of files(REPO_ROOT))
      assert.ok(!database.includes(file), `${file} is ${suite}'s`);
  }
  assert.ok(!database.some((file) => file.endsWith(".docker.test.ts")), "Docker proofs stay out");
});
