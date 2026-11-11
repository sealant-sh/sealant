import { configDefaults, defineConfig } from "vitest/config";

/**
 * Boat's database-backed files. Each test clones and migrates a database of its own before it
 * starts, which on a busy runner takes a good part of vitest's default 5 s on its own: a test
 * that asserts nothing wrong then fails on the clock, and a failed test job publishes no release.
 */
const BOAT_DATABASE_TESTS = ["src/runtime/boat/**/*.db.test.ts"];

/**
 * The package's default run (`pnpm test`): every `*.test.ts`, as the repository's root config has
 * it, in two projects so that only Boat's database-backed files get the longer timeout. A test
 * that passes its own timeout keeps it.
 */
export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...BOAT_DATABASE_TESTS],
        },
      },
      {
        test: {
          name: "boat-database",
          include: BOAT_DATABASE_TESTS,
          testTimeout: 20_000,
        },
      },
    ],
  },
});
