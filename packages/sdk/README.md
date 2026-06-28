# @sealant/sdk

The fluent public SDK for Sealant — **create a sandbox, run a harness, replay the record.**

```ts
import { Sealant, opencode } from "@sealant/sdk";

const sealant = new Sealant({ baseUrl: "http://localhost:8080" });

const sandbox = await sealant.sandboxes.create({
  repository: "github.com/acme/billing-service",
  harness: opencode(),
});

const run = await sandbox.harness.run("Round invoice totals once, after applying the discount.");

await run.record.replay();
```

## Design

- **Plain-Promise facade over an Effect core.** The default export is ordinary `async`/`await`. The
  Effect-native core (services, `Stream`s, typed errors) will be reachable via the `@sealant/sdk/effect`
  subpath for power users.
- **Decoupled public types.** The types in [`src/types.ts`](src/types.ts) are hand-written and kept
  independent of the Effect-core and `@sealant/telemetry` internal shapes, so the public surface stays
  stable across internal change. The whole surface is typed now, including operations not yet
  implemented (those reject with `SealantNotImplementedError`).
- **Harness-neutral.** `opencode()`, `codex()`, `claudeCode()`, and `customHarness()` are thin client
  values describing how to invoke a harness one-shot.

## Status

Scaffold. The public surface compiles and the harness factories are real; the client operations are
typed stubs pending the implementation phases (Effect core → `create()` → `harness.run()` →
`record.replay()`). See the SDK build plan for the phased sequence.
