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

## Deterministic exec

Run a command in the workspace with no agent in the loop — recorded into a run record like any other
process:

```ts
const check = await workspace.exec(["pnpm", "test"], { cwd: "/workspace/repo" });
check.exitCode; // the check datum — a NONZERO exit RESOLVES (that's the point)
check.stdout; // full stdout, decoded
check.run.record; // the durable evidence

// A causal proof is three execs with three recorded exit codes:
const base = await workspace.exec(["pnpm", "test"]); // fails
// ...apply the fix...
const head = await workspace.exec(["pnpm", "test"]); // passes
```

`exec()` rejects only when the execution machinery itself broke (workspace gone, transport dropped)
— i.e. when the exit code cannot be trusted. The underlying endpoint
(`POST /v1/workspaces/:id/exec`) accepts an ordered **list** of commands recorded as one check run;
the SDK surface starts with the single-command form.

## Typed record events

Timeline reads are discriminated by `kind` — switch on it and `data` narrows to the event's typed
payload (all 12 recorded kinds: process, io, file, network, runtime, and loss events):

```ts
for await (const entry of run.record.timeline()) {
  if (entry.kind === "networkSourceObserved") {
    entry.data.host; // typed — the raw material of a "sources the agent opened" trail
    entry.data.status;
  }
}
```

Forward compatibility is a case, not an error: kinds newer than your SDK version (and payloads that
fail their schema) arrive as `{ kind: "unknown", rawKind, data }` with everything preserved. Wire
conventions carry through: uint64 fields are decimal strings, protocol enums are numbers.

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

## Workspace tools and services

Choose a supported operating-system family — `fedora` (the default), `arch`, `nix`, or `ubuntu` —
request portable package names, and opt into services that need runtime support rather than a
package install:

```ts
const workspace = await sealant.workspaces.create({
  repository: "github.com/acme/billing-service",
  harness: codex(),
  os: "arch",
  packages: ["pnpm", "python", "uv", "mise", "github-cli", "lazygit", "bat"],
  services: { docker: true },
  credentials: { codex: true, github: true },
});
```

`services.docker` installs the Docker client in the image and starts a disposable, workspace-scoped
rootless daemon at launch. The workspace receives `DOCKER_HOST`; Sealant never mounts the host
Docker socket. GitHub credentials provide both `GH_TOKEN` and `GITHUB_TOKEN` to the workspace.

## Dotfiles and shell

Bring your own environment: a login shell and dotfiles applied before the workspace accepts work.

```ts
const workspace = await sealant.workspaces.create({
  repository: "github.com/acme/billing-service",
  harness: codex(),
  shell: "zsh",
  dotfiles: {
    // A repo the platform clones and applies (chezmoi/stow layouts detected, else copied):
    repository: { url: "github.com/acme/dotfiles" },
    // And/or caller-resolved archives — a checkout cloned host-side with your own ssh identity,
    // or a scanned selection of home files, sent as gzipped tars (max 4, ~4MB decoded each):
    archives: [{ data: tarGzBase64, manager: "copy", bootstrap: false }],
  },
});
```

`shell` installs the shell package and switches the login shell, so `.zshrc`/`.fishrc` actually take
effect. The `repository` applies first, then each archive in order, so local selections override
repo files. A failing apply fails the launch loudly rather than handing the agent a half-prepared
home. Managed OS families only — with `baseImage`, `dotfiles` and non-bash `shell` are rejected
client-side with the platform's reasoning.

## Custom base images

Instead of a managed OS family, a workspace image can be built from any image reference you already
trust:

```ts
const workspace = await sealant.workspaces.create({
  repository: "github.com/acme/billing-service",
  harness: codex(),
  baseImage: "node:22-bookworm",
});
```

Distro package installs are skipped entirely — the build overlays only the `sealantd` supervisor
(PID 1), the harness CLIs (installed with `npm`), and a fully static `socat` (the control-socket
relay), all copied in as static binaries. This is the **base-image contract**, checked at build time
with readable failures:

- **Any Linux base, `amd64`/`arm64`**, with a **POSIX shell** at `/bin/sh`. Shells beyond that are
  not assumed: the workspace login shell is `/bin/sh`, and `defaultShell` selection is not supported
  with `baseImage`.
- **Node.js + npm** at or above the harness CLIs' floor (the CLIs are installed with
  `npm install -g` and run on the base's node).
- **git**, for clone- and mount-sourced workspaces.

`packages` still works: names pass through **verbatim** (no portable-name resolution) to the base's
own package manager — `apt`, `apk`, `dnf`, or `pacman`, autodetected — and the build fails with a
readable error when the base has none. Dotfiles are not supported with `baseImage`. `baseImage` and
`os` are mutually exclusive.

## Inference on connected accounts

Run short, tool-calling inference loops on the caller's own subscription — server-side, through the
official agent SDKs (never raw model-API calls on stored credentials), with the tool loop executed
on YOUR side:

```ts
let response = await sealant.inference.respond({
  prompt: "Compile a review brief from this run record.",
  tools: [
    {
      name: "get_timeline",
      inputSchema: { type: "object", properties: { runId: { type: "string" } } },
    },
  ],
  responseFormat: { type: "json", schema: briefSchema },
  credentials: { claude: true },
});

while (response.turn.type === "toolCalls") {
  const toolResults = await Promise.all(
    response.turn.calls.map(async (call) => ({
      toolCallId: call.toolCallId,
      content: await runTool(call.name, call.input),
    })),
  );
  response = await sealant.inference.respond({ sessionId: response.sessionId, toolResults });
}

response.turn.json; // schema-constrained result
```

Only account references cross the surface — the control plane resolves and decrypts server-side and
invokes the official Claude Agent SDK with the account's own subscription token. Claude accounts
only for now (Codex inference is a stated follow-up); sessions are held in memory by the control
plane and expire after a few idle minutes, so handle a 404 on continuation by restarting the
exchange.

## Status

The core loop is real: `workspaces.create()`/`get()`/`list()`, `ready()`, blocking `harness.run()`
and non-blocking `harness.start()` (run execution happens server-side; the SDK is a thin HTTP
client), deterministic `workspace.exec()`, `inference.respond()` (connected-account inference with a
caller-executed tool loop), `runs.get()`, and the record read surface — `replay()`, `timeline()`
(typed, kind-discriminated entries), `scrollback()`, `commands()`, `transcript()`, `stream()`
(poll-backed), `loss()`, `summary()`, plus captured `changes` (files + diff) settled by
`run()`/`wait()`. The Effect-native core ships at `@sealant/sdk/effect`.

Still typed stubs pending their read models / endpoints: `artifacts.get()` and the time-travel folds
`fileTreeAt()`/`processTreeAt()` (Phase 1), and `harness.session()` + workspace lifecycle
`stop()`/`restart()`/`expire()` (Phase 3).
