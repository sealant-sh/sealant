import { defineConfig } from "vitest/config";

/**
 * Dedicated config for the Docker-backed sealantd proof. The repo's root vitest config only matches
 * `*.test.ts`, which keeps these slow, Docker-requiring `*.e2e.ts` specs out of the default unit run.
 * Run with: `pnpm --filter @sealant/sandboxes test:e2e`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.e2e.ts"],
    testTimeout: 60_000,
    hookTimeout: 90_000,
    // Boots/tears down a container per file; keep them serial to avoid socket/exec contention.
    fileParallelism: false,
    passWithNoTests: false,
  },
});
