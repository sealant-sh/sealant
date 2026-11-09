import { defineConfig } from "vitest/config";

/**
 * The local Boat harness: Core's real worker, API, Boat adapter, guest and gateway against a fake
 * Boat provider and guest-twin containers. Needs Docker with privileged containers, cgroup v2 and
 * kernel WireGuard. Run with `pnpm boat:harness` from the repository root.
 */
export default defineConfig({
  test: {
    include: ["boat-harness/**/*.harness.ts"],
    // One stack per file; scenarios inside a file share it and run in order.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 15 * 60_000,
    hookTimeout: 45 * 60_000,
    passWithNoTests: false,
    reporters: ["verbose"],
  },
});
