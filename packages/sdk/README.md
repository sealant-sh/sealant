# @sealant/sdk

The fluent public SDK for Sealant — **create a workspace, run a harness, replay the record.**

```ts
import { Sealant, opencode } from "@sealant/sdk";

const sealant = new Sealant({ baseUrl: "http://localhost:8080" });

const workspace = await sealant.workspaces.create({
  repository: "github.com/acme/billing-service",
  harness: opencode(),
});

const run = await workspace.harness.run("Round invoice totals once, after applying the discount.");

await run.record.replay();
```

## Design

- **Plain-Promise facade over an Effect core.** The default export is ordinary `async`/`await`. The
  Effect-native core is reachable via the `@sealant/sdk/effect` subpath for consumers that are
  Effect end-to-end: the contract-derived client as a service, one operation effect per endpoint,
  and the typed contract errors on the failure channel (no squashing) —

  ```ts
  import { Effect } from "effect";
  import { getRunOp, resolveInternalConfig, sealantApiClientLayer } from "@sealant/sdk/effect";

  const layer = sealantApiClientLayer(resolveInternalConfig({ baseUrl: "http://localhost:8080" }));

  const status = getRunOp("run_123").pipe(
    Effect.map((run) => run.status),
    Effect.catchTag("RunNotFoundError", () => Effect.succeed("gone" as const)),
    Effect.provide(layer),
  );
  ```

- **Decoupled public types.** The types in [`src/types.ts`](src/types.ts) are hand-written and kept
  independent of the Effect-core and `@sealant/telemetry` internal shapes, so the public surface
  stays stable across internal change. The whole surface is typed now, including operations not yet
  implemented (those reject with `SealantNotImplementedError`).
- **Harness-neutral.** `opencode()`, `codex()`, `claudeCode()`, and `customHarness()` are thin
  client values describing how to invoke a harness one-shot.

## Connected-account credentials

Attach the caller's connected Claude / Codex / GitHub accounts to a workspace so the harness
authenticates as that identity instead of running unauthenticated:

```ts
const workspace = await sealant.workspaces.create({
  repository: "github.com/acme/billing-service",
  harness: claudeCode(),
  credentials: { claude: true, github: "bot-account" },
});
```

`true` means "my default account"; a string names a specific connected account. `profile` names a
profile whose bundled per-provider bindings apply first, and any explicit `claude`/`codex`/`github`
field wins over the profile's binding for that provider. Only account references cross the SDK
surface — secret material never does; the control plane resolves references to encrypted credentials
and injects them at launch.

## Status

The core loop is real: `workspaces.create()`/`get()`/`list()`, `ready()`, blocking `harness.run()`
and non-blocking `harness.start()` (run execution happens server-side; the SDK is a thin HTTP
client), `runs.get()`, and the record read surface — `replay()`, `timeline()`, `scrollback()`,
`commands()`, `transcript()`, `stream()` (poll-backed), `loss()`, `summary()`, plus captured
`changes` (files + diff) settled by `run()`/`wait()`. The Effect-native core ships at
`@sealant/sdk/effect`.

Still typed stubs pending their read models / endpoints: `artifacts.get()` and the time-travel folds
`fileTreeAt()`/`processTreeAt()` (Phase 1), and `harness.session()` + workspace lifecycle
`stop()`/`restart()`/`expire()` (Phase 3).
