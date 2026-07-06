## Sealant Quick Context

Sealant is a `pnpm` + `turbo` monorepo for building isolated, reproducible coding environments.

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
- When shaping core API surfaces for the web app, model around the workspace and run lifecycles
  first.

## Agent Defaults

- After code changes, always run `pnpm format:fix`.
- For type-checking, always use `tsgo` (`pnpm typecheck`) and do not use `tsc`.
- Never touch `pnpm-lock.yaml` (no manual edits and no workflow steps that update it).
- For internal dependencies, always use `workspace:*` in `package.json` and import via
  `@sealant/<package-name>`; never import from `../packages/*` paths.
- For external dependencies used by more than one app/package, prefer `catalog:` versions in
  `package.json` instead of inline semver.
- If a shared external dependency is missing from the catalog, add it to the root
  `pnpm-workspace.yaml` `catalog` and then reference it as `catalog:` from importers.
- Do not duplicate shared external dependency version strings across apps/packages; keep version
  authority in `pnpm-workspace.yaml`.
- When installing new dependencies for agent work, do not update the lockfile (for example use
  `pnpm add --lockfile=false ...` when needed).
- For any non-tiny UI change in `apps/web`, read `apps/web/DESIGN.md` first and follow it as the
  design source of truth.
- Do not add `"use client"` anywhere; this repo is not Next.js.
- In React code, avoid `useEffect` unless there is no cleaner data-flow option.
- Avoid `any` and avoid type assertions/casts like `as X` unless absolutely unavoidable.

## Picking the right models for workflows and subagents

Rankings, higher = better. Cost reflects what I actually pay (OpenAI has really generous limits),
not list price. Intelligence is how hard a problem you can hand the model unsupervised. Taste covers
UI/UX, code quality, API design, and copy.

| model    | cost | intelligence | taste |
| -------- | ---- | ------------ | ----- |
| gpt-5.5  | 9    | 8            | 5     |
| sonnet-5 | 5    | 5            | 7     |
| opus-4.8 | 4    | 7            | 8     |
| fable-5  | 2    | 9            | 9     |

How to apply:

- These are defaults, not limits. You have standing permission to override them: if a cheaper
  model's output doesn't meet the bar, rerun or redo the work with a smarter model without asking.
  Judge the output, not the price tag. Escalating costs less than shipping mediocre work.
- Cost is a tie-breaker only; when axes conflict for anything that ships, intelligence > taste >
  cost.
- Bulk/mechanical work (clear-spec implementation, data analysis, migrations): gpt-5.5 — it's
  effectively free.
- Anything user-facing (UI, copy, API design) needs taste ≥ 7.
- Reviews of plans/implementations: fable-5 or opus-4.8, optionally gpt-5.5 as an extra independent
  perspective.
- Never use Haiku.
- Mechanics: gpt-5.5 is only reachable through the Codex CLI — `codex exec` / `codex review` (my
  ~/.codex/config.toml defaults to gpt-5.5). Use the codex-implementation, codex-review, and
  codex-computer-use skills; for work they don't cover (investigation, data analysis), run
  `codex exec -s read-only` directly with a self-contained prompt.
- Claude models (sonnet-5, opus-4.8, fable-5) run via the Agent/Workflow model parameter.

Using gpt-5.5 inside workflows and subagents (the model parameter only takes Claude models, so use a
wrapper):

- Spawn a thin Claude wrapper agent with `model: 'sonnet', effort: 'low'` whose prompt instructs it
  to write a self-contained codex prompt, run `codex exec` via Bash, and return the codex output
  verbatim.

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
documentation isn't enough.

<!-- intent-skills:start -->

# Skill mappings - when working in these areas, load the linked skill file into context.

skills:

- task: "add tRPC on the web app (server router/context/procedures)" load:
  "/home/yiannis/Developer/OS/Sealant/apps/web/node_modules/@trpc/server/skills/server-setup/SKILL.md"
- task: "add tRPC on the web app endpoint in TanStack Start routes" load:
  "/home/yiannis/Developer/OS/Sealant/apps/web/node_modules/@trpc/server/skills/adapter-fetch/SKILL.md"
- task: "add tRPC on the web app with React Query integration" load:
  "/home/yiannis/Developer/OS/Sealant/apps/web/node_modules/@trpc/tanstack-react-query/skills/react-query-setup/SKILL.md"
- task: "route auth guards and redirects in TanStack Router" load:
  "/home/yiannis/Developer/OS/Sealant/node_modules/.pnpm/@tanstack+router-core@1.167.5/node_modules/@tanstack/router-core/skills/router-core/auth-and-guards/SKILL.md"
- task: "TanStack Start API route handlers under src/routes/api" load:
"/home/yiannis/Developer/OS/Sealant/node_modules/.pnpm/@tanstack+start-client-core@1.166.13/node_modules/@tanstack/start-client-core/skills/start-core/server-routes/SKILL.md"
<!-- intent-skills:end -->
