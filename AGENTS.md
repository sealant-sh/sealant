## Sealant Quick Context

Sealant is a `pnpm` + `turbo` monorepo for building isolated, reproducible coding environments.

- `apps/web`: TanStack Start product web app.
- `apps/api`: Hono control-plane API.
- `apps/worker`: background sandbox build worker.
- `packages/*`: shared libraries (`db`, `auth`, `ui`, `sandbox-*`, `registry-*`, integrations).

## Product Language Contract

- Treat `sandboxes` and `issue workflows` as the two primary product domains.
- For user-facing API design and UI copy, prefer these terms over implementation terms.
- Treat `run` and `sandbox build job` as internal execution/orchestration vocabulary unless a task
  explicitly asks for internals.
- When shaping core API surfaces for the web app, model around sandbox lifecycle and issue workflow
  lifecycle/reporting first.

## Agent Defaults

- After code changes, always run `pnpm format:fix`.
- For type-checking, always use `tsgo` (`pnpm typecheck`) and do not use `tsc`.
- Never touch `pnpm-lock.yaml` (no manual edits and no workflow steps that update it).
- For internal dependencies, always use `workspace:*` in `package.json` and import via
  `@sealant/<package-name>`; never import from `../packages/*` paths.
- For any non-tiny UI change in `apps/web`, read `apps/web/DESIGN.md` first and follow it as the
  design source of truth.
- Do not add `"use client"` anywhere; this repo is not Next.js.
- In React code, avoid `useEffect` unless there is no cleaner data-flow option.
- Avoid `any` and avoid type assertions/casts like `as X` unless absolutely unavoidable.

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

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
