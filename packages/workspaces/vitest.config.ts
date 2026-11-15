import { configDefaults, defineConfig } from "vitest/config";

/**
 * Boat's database-backed files. Each test clones and migrates a database of its own before it
 * starts, which on a busy runner takes a good part of vitest's default 5 s on its own: a test
 * that asserts nothing wrong then fails on the clock, and a failed test job publishes no release.
 */
const BOAT_DATABASE_TESTS = ["src/runtime/boat/**/*.db.test.ts"];

/**
 * The files that run the home scripts for real: each test starts several of them, each a shell that
 * starts dozens of processes (setpriv, flock, node…), about 145 in all for the longest. No test
 * here claims anything about speed and none waits on a clock it could be given instead, so vitest's
 * default 5 s was never a bound on them. It only failed them when a loaded runner slowed the work.
 * Their timeout still catches a script that hangs.
 */
const REAL_PROCESS_TESTS = ["src/runtime/home-credentials.test.ts"];

/**
 * The package's default run (`pnpm test`): every `*.test.ts`, as the repository's root config has
 * it, in projects so that only the files above get a longer timeout. A test that passes its own
 * timeout keeps it.
 */
export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...BOAT_DATABASE_TESTS, ...REAL_PROCESS_TESTS],
        },
      },
      {
        test: {
          name: "boat-database",
          include: BOAT_DATABASE_TESTS,
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: "real-processes",
          include: REAL_PROCESS_TESTS,
          testTimeout: 20_000,
        },
      },
    ],
  },
});
