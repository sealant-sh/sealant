import { defineConfig } from "vitest/config";

/**
 * The Docker-backed gateway proof (`*.e2e.ts`): OpenSSH's client, this gateway and a real daemon.
 * The default config only matches `*.test.ts`, which keeps these out of the unit run. Run with:
 * `pnpm --filter @sealant/ssh-gateway test:e2e`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.e2e.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    passWithNoTests: false,
  },
});
