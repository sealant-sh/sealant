// Only for check.test.mjs: a vitest run over the fixture suite beside this file.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tooling/verify/fixtures/skips/*.fixture.mjs"], passWithNoTests: false },
});
