## Sealant Quick Context

Sealant is a `pnpm` + `turbo` monorepo for building isolated, reproducible coding environments.

Rules and skills shared by every Sealant repo, including Linear, PRs, verification and model choice,
live in the home repo, cloned beside this one at `../agent-home`. Start sessions there when work
spans repos.

- `apps/web`: TanStack Start product web app.
- `apps/api`: Hono control-plane API.
- `apps/worker`: background workspace build worker.
- `packages/*`: shared libraries (`db`, `auth`, `ui`, `workspace-*`, `registry-*`, integrations).

## Product Language Contract

- The primary product nouns are `workspace` (the live environment), `run` (the durable execution
  record), and `harness` (the agent that does the work). Runs are the heart of the product.
- For user-facing API design and UI copy, prefer these terms over implementation terms.
- Treat `workspace build job` and `attempt` as internal orchestration vocabulary unless a task
  explicitly asks for internals.
- When shaping sealant API surfaces for the web app, model around the workspace and run lifecycles
  first.

## Agent Defaults

- Submit pull requests as ready for review, never as drafts. With `gh stack`, use
  `gh stack submit --auto --open`.
- After code changes, always run `pnpm format:fix`.
- For type-checking, use `pnpm typecheck`. It runs [tsrs](https://github.com/oxc-project/tsrs), a
  Rust port of the TypeScript 7 checker, in every package, as `tsrs --checkers 1`. It is in beta and
  pinned exactly; if you think it is wrong about an error, compare with `tsc` and report any
  difference upstream. Package builds still emit with `tsc`. `pnpm lint:types` runs oxlint's
  type-aware rules with tsrs as the type engine (`OXLINT_TSGOLINT_PATH=…/tsrs-lint`).
- `pnpm-lock.yaml` is generated, never hand-edited: let `pnpm install` / `pnpm add` write it, and
  commit the result alongside the `package.json` change that caused it. CI and every image build
  install with `--frozen-lockfile`, so a dependency change without its lockfile update fails CI. No
  workflow step writes the lockfile.
- For internal dependencies, always use `workspace:*` in `package.json` and import via
  `@sealant/<package-name>`; never import from `../packages/*` paths.
- For external dependencies used by more than one app/package, prefer `catalog:` versions in
  `package.json` instead of inline semver.
- If a shared external dependency is missing from the catalog, add it to the root
  `pnpm-workspace.yaml` `catalog` and then reference it as `catalog:` from importers.
- Do not duplicate shared external dependency version strings across apps/packages; keep version
  authority in `pnpm-workspace.yaml`.
- For any non-tiny UI change in `apps/web`, read `apps/web/DESIGN.md` first and follow it as the
  design source of truth.
- Tests passing is not verification. To see a change working, and to screenshot every UI change for
  its PR, use the `verify` skill in `.agents/skills/verify/`.
- Do not add `"use client"` anywhere; this repo is not Next.js.
- In React code, avoid `useEffect` unless there is no cleaner data-flow option.
- Avoid `any` and avoid type assertions/casts like `as X` unless absolutely unavoidable.

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `pnpm exec effect-solutions list` to see available guides
2. Run `pnpm exec effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations
4. Define Effect services as types/contracts first (`Context.Tag` / `ServiceMap.Service`) with no
   embedded live implementation in the definition.
5. Define live/test implementations as separate layer constants after the service definitions (same
   file is fine when clearly sectioned), and compose those layers at the boundary.

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling,
error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

<!-- effect-solutions:end -->

## Local Effect Source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for reference. Use
this to explore APIs, find usage examples, and understand implementation details when the
documentation isn't enough. If the clone is missing, make it with
`git clone --depth 1 https://github.com/Effect-TS/effect-smol ~/.local/share/effect-solutions/effect`.

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
