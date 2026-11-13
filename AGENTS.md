## Sealant Quick Context

Sealant is a `pnpm` + `turbo` monorepo for building isolated, reproducible coding environments.

Rules and skills shared by every Sealant repo, including Linear, PRs, verification and model choice,
live in the home repo, cloned beside this one at `../agent-home`. Start sessions there when work
spans repos.

- `apps/web`: TanStack Start product web app.
- `apps/api`: Hono control-plane API.
- `apps/worker`: background workspace build worker.
- `apps/ssh-gateway`: SSH routing to workspaces. `apps/cf-bridge`: the Cloudflare Worker behind the
  cloudflare runtime adapter.
- `apps/cli`: connects AI-subscription credentials and manages profile bindings.
- `apps/docs`, `apps/marketing`: the docs site and the public website.
- `packages/sdk`, `packages/api-contracts`: published to npm as `@sealant/sdk` and
  `@sealant/api-contracts`. Mend builds on the SDK alone, so a change to either is a public API
  change and needs a changeset (`.changeset/README.md`).
- `packages/*`: private shared libraries (`db`, `auth`, `jobs`, `workspaces`, `credentials`,
  `telemetry`, `validators`, `source-integrations`, `ui`).

## Product Language Contract

- The primary product nouns are `workspace` (the live environment), `run` (the durable execution
  record), and `harness` (the agent that does the work). Runs are the heart of the product.
- For user-facing API design and UI copy, prefer these terms over implementation terms.
- Treat `workspace build job` and `attempt` as internal orchestration vocabulary unless a task
  explicitly asks for internals.
- When shaping sealant API surfaces for the web app, model around the workspace and run lifecycles
  first.

## Linear, Fixes and PRs

- When the work has a Linear ticket, load the `linear` skill
  (`../agent-home/.agents/skills/linear/`) before you start. Keep the ticket current while you work:
  when you make a decision, hit a blocker or change scope, comment on the ticket then, before
  carrying on.
- Fix a problem straight away only if it meets Fix Now or File in `../agent-home/AGENTS.md`. File
  the rest in Linear.
- Every change lands through a PR, docs and config included; never push to `main`. Open it with the
  `file-pr` skill (`../agent-home/.agents/skills/file-pr/`).

## Checks Before a PR

CI runs lint, typecheck and the tests. Run these before pushing and see them pass, formatting last:

```sh
pnpm lint
pnpm typecheck
pnpm --filter <package> test   # for each package the change touches
pnpm format:fix
```

A PR merges on two results: `checks`, the roll-up of every CI job, and `e2e checks`, the roll-up of
every Kubernetes e2e job. A new job in either workflow goes in its roll-up's `needs`;
`tooling/scripts/workflow-checks.test.mjs` fails until it does. DEVELOPMENT.md ("CI and merging")
says how the Version Packages PR gets them.

`pnpm typecheck` runs [tsrs](https://github.com/oxc-project/tsrs), a Rust port of the TypeScript 7
checker, in every package, as `tsrs --checkers 1`. It is in beta and pinned exactly; if you think it
is wrong about an error, compare with `tsc` and report any difference upstream. Package builds still
emit with `tsc`. `pnpm lint:types` runs oxlint's type-aware rules with tsrs as the type engine
(`OXLINT_TSGOLINT_PATH=…/tsrs-lint`).

Tests passing is not verification. To see a change working, and to screenshot every UI change for
its PR, use the `verify` skill in `.agents/skills/verify/`.

## Dependencies

- `pnpm-lock.yaml` is generated: let `pnpm install` / `pnpm add` write it, and commit it with the
  `package.json` change that caused it. CI and every image build install with `--frozen-lockfile`,
  and no workflow step writes the lockfile, so a dependency change without its lockfile fails CI.
- Internal dependencies use `workspace:*` in `package.json` and are imported as
  `@sealant/<package-name>`, never through `../packages/*` paths.
- An external dependency used by more than one app or package takes its version from the root
  `pnpm-workspace.yaml` `catalog`, referenced as `catalog:`. Add it to the catalog if it is missing.

## Code

- All backend code is Effect v4; see Effect below.
- Write TypeScript to the `coding-standards` skill
  (`../agent-home/.agents/skills/coding-standards/`), including its rules on `any` and casts.
- Before any non-tiny UI change in `apps/web`, read `apps/web/DESIGN.md` and follow it as the design
  source of truth.
- This repo is not Next.js: write no `"use client"` directives.
- In React, derive data from props, state and loaders; reach for `useEffect` only when no cleaner
  data flow exists.

## Effect

Before writing Effect code, load the home repo's `effect` skill. It covers services, layers, the
composition root, entrypoints, testing with layers, concurrency and the everyday Effect APIs. Check
every API against the `effect` version installed in `node_modules`, not memory or upstream `main`.

<!-- intent-skills:start -->

## Skill Loading

Use the repository’s installed Intent. If it is unavailable, report the missing dependency instead
of downloading a replacement. Before editing files for a substantial task:

- Run `pnpm exec intent list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm exec intent load <package>#<skill>` before changing
  files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer
  the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are
changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->
