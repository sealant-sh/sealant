---
title: SDK
description:
  "@sealant/sdk — the fluent TypeScript SDK for Sealant. Preview: first npm release in flight, with
  a clear map of what is implemented versus typed-but-not-wired."
---

`@sealant/sdk` is a fluent TypeScript client for Sealant: create a workspace around a real
repository, run the harness you already use, and keep the replayable
[execution record](/docs/concepts/execution-records) after the workspace is gone. It is a thin HTTP
client over the [control-plane API](/docs/reference/http-api) — no local Docker or Postgres; it runs
anywhere the API is reachable.

> **Preview.** The SDK is not on npm yet — the publish pipeline (Changesets + release tags) is in
> place and the first release is in flight. Until it lands, the SDK is consumable only inside the
> Sealant monorepo (import `@sealant/sdk` from a workspace package). Expect the surface to firm up
> across early releases.

## Shape

```ts
import { Sealant, opencode } from "@sealant/sdk";

const sealant = new Sealant({ baseUrl: "http://localhost:4000" });

// Create a live workspace and wait until it is ready.
const workspace = await sealant.workspaces.create({
  repository: "github.com/acme/billing-service",
  harness: opencode(),
});

// Run the harness one-shot; resolves when the run is terminal.
const run = await workspace.harness.run("Round invoice totals after applying the discount.");

// Read the replayable record.
await run.record.replay();
console.log(await run.record.transcript());
```

Prefer not to block? `harness.start()` registers the same server-side run but returns the live
handle immediately — stream progress, then settle:

```ts
const run = await workspace.harness.start("Round invoice totals after applying the discount.");

for await (const entry of run.record.stream()) {
  console.log(entry.kind, entry.occurredAt);
}

const settled = await run.wait(); // terminal result + captured changes (files, diff)
console.log(settled.result.outcome, await settled.changes.diff());
```

The client takes `{ baseUrl }` (and an optional `apiKey`, which the API does not enforce today — see
[auth](/docs/reference/http-api)). Point `baseUrl` at your install's API, normally
`http://localhost:4000`.

### Harnesses

Harness factories describe how to invoke a harness one-shot: `opencode()`, `codex()`,
`claudeCode({ profile? })`, and `customHarness({ id, invoke, … })` for anything else. Only
`opencode()` is exercised end-to-end today; the others provide the typed surface and are pending
live verification against the baked workspace image.

### Owner identity

Workspaces and runs are attributed to a `usr_local` owner by default (override with the
`SEALANT_OWNER_USER_ID` environment variable). This is the same temporary pre-auth model the API
uses — it disappears when real authentication lands.

## What is implemented

These call the live API and work end-to-end:

- **Workspaces:** `sealant.workspaces.create()`, `.get()`, `.list()`
- **Workspace handle:** `workspace.status()`, `workspace.ready()`, `workspace.events()` (poll-backed
  status stream)
- **Harness:** `workspace.harness.run(prompt)` — registers a run server-side and blocks until
  terminal; `workspace.harness.start(prompt)` — same run, returns the live handle immediately
- **Runs:** `sealant.runs.get(runId)`, `run.wait()` (polls to terminal, then fetches the captured
  changes), `run.result`, `run.changes` (files + diff)
- **Execution record** (`run.record`): `replay()`, `timeline()`, `stream()` (poll-backed),
  `scrollback()`, `loss()`, `summary()`, `commands()`, `transcript()`

## Typed but not implemented

These exist on the typed surface so you can compile against the final shape, but they reject at
runtime with `SealantNotImplementedError`. Do not depend on them yet:

- **Harness:** `harness.session()` (interactive)
- **Workspace lifecycle:** `workspace.stop()`, `workspace.restart()`, `workspace.expire()`
- **Artifacts:** `run.artifacts.get()` (`.list()` currently returns empty)
- **Record time-travel folds:** `record.fileTreeAt()`, `record.processTreeAt()`

## Automating today

Until the SDK is published, the portable way to script Sealant from outside the monorepo is the
[HTTP API](/docs/reference/http-api) directly — generate a client from the live
`http://localhost:4000/openapi.json`. There is no CLI; see [CLI](/docs/reference/cli).

Related: [HTTP API](/docs/reference/http-api) ·
[Runs and execution records](/docs/guides/runs-and-execution-records) ·
[What ships today](/docs/introduction/what-ships-today)
