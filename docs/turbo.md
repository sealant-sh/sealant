# Turborepo

`turbo` is pinned exactly to **2.11.9** in the root `package.json`. The full notes, covering how
turbo is meant to be used, the rules, and the 2.10.x crash, live in Mend:
[`docs/operations/turbo.md`](https://github.com/sealant-sh/mend/blob/main/docs/operations/turbo.md).
Core was locked to 2.9.18, which predates that crash (vercel/turborepo#13254). Turbo 2.10.0 to
2.10.3 segfaulted whenever it stopped running tasks, after a failure, a Ctrl-C or a timeout. Pin
exactly and upgrade on purpose.

## Rules

- Every file a task reads from outside its package is an input, written as `$TURBO_ROOT$/…` next to
  `$TURBO_DEFAULT$`. Otherwise editing that file replays a stale cached result. Today that covers:
  - `tooling/scripts/bundle-app.mjs` for `build`;
  - the root `.oxlintrc.json` for `lint`;
  - the root `compose.selfhost.yaml` for `@sealant/api#test` (`apps/api/turbo.json`).
- Turbo runs tasks in strict env mode. A task sees only the variables in its `env` (hashed) and
  turbo's built-in passthrough list (`PATH`, `HOME`, `CI`, `DOCKER_*` and others). A variable that
  changes test behaviour must be in `test.env`: today that is `SEALANT_*` and `DATABASE_URL`.
- `turbo clean` is not a turbo command; it ran an empty `clean` task in every package. Use
  `pnpm clean`.
- Root `cacheMaxAge` is 14 days. Every worktree shares the main checkout's `.turbo/cache`, and
  without it nothing is ever evicted.
- To stop a non-interactive turbo, signal its process group (as Ctrl-C does) or send `SIGTERM`. The
  npm `turbo` bin is a Node wrapper that ignores a SIGINT sent only to its own pid when there is no
  TTY.

## Known, not fixed here

- `test` keeps `dependsOn: ["^test"]`. A transit node would let the test tasks run in parallel, but
  jobs, telemetry and worker share one test database.
- `packages/workspaces` `home-credentials.test.ts` "sh (bash)" fails under turbo and passes on its
  own. It depends on the inherited `SHLVL`, which strict mode strips. It fails the same way on
  2.9.18; the fix belongs in the test.
- `pnpm dev` cannot start every app at once. `@sealant/docs` and `@sealant/web` both use port 3000,
  and docs and marketing both take the Cloudflare Vite plugin's inspector port 9229.
