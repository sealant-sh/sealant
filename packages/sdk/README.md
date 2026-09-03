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
Docker socket. On Kubernetes the daemon is a sidecar of a user-namespaced workspace Pod and the
operator has to enable it (`workspaces.docker.enabled`); an install that cannot serve it refuses
`create` with the stable code `workspace-docker-unsupported` (HTTP 422) — map that code to explain
the gap beside your Docker switch instead of surfacing a launch failure later. GitHub credentials
provide both `GH_TOKEN` and `GITHUB_TOKEN` to the workspace.

## Workspace environment variables

Ordinary (non-secret) configuration set on the workspace at creation and inherited by every process
the platform starts inside it — the harness, later shells, exec'd commands, and their descendants:

```ts
const workspace = await sealant.workspaces.create({
  repository: "github.com/acme/billing-service",
  harness: codex(),
  env: { APP_MODE: "review", FEATURE_FLAGS: "checkout,invoices" },
});
```

The contract, stated plainly:

- **Not for secrets.** Values are persisted verbatim in the durable workspace spec and are returned
  by workspace-details APIs to authorized clients for the life of that record. Use `credentials` for
  connected-account material. There is no partial support: secret-looking names — containing
  `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, or `APIKEY` (as a substring, so
  `TOKENIZER_PATH` counts), ending in `_KEY`, or exactly `KEY` — are rejected at create, because the
  workspace runtime's secret filter would silently drop them before any process could see them. A
  loud rejection beats a variable that never arrives.
- **Validated, client-side and server-side, with the same policy.** Names are
  `[A-Za-z_][A-Za-z0-9_]*` (max 128 chars); values are any UTF-8 up to 4 KiB (empty and multiline
  included, NUL excluded); at most 128 entries and 32 KiB total per workspace. Platform-owned names
  (`SEALANT_*`, `HOME`, `PATH`, `TERM`, `DOCKER_HOST`, proxy variables, loader/shell/
  runtime-injection controls like `LD_*`, `BASH_ENV`, `NODE_OPTIONS`, `PYTHONPATH`, and Git/SSH
  config controls) are rejected. The policy is exported (`parseWorkspaceEnv`,
  `findWorkspaceEnvReservedRule`, `formatWorkspaceEnvIssue`, `WORKSPACE_ENV_*` constants) so your
  own settings surface can validate with the platform's exact rules.
- **Fixed at creation.** A live workspace is never mutated; a platform-side restart reuses the
  stored spec. Caller values can never override platform controls or injected connected-account
  credentials.
- **No nested-container injection.** Docker Compose or `docker run` inside the workspace can use the
  values for interpolation, but child containers receive only what the Compose file or the command
  explicitly passes (`environment`, `env_file`, `-e`). Docker runtime only.

## Secret environment variables

The half of a real `.env` that `env` deliberately refuses — API keys, database URLs with passwords —
goes through the **transient secret channel**:

```ts
const workspace = await sealant.workspaces.create({
  repository: "github.com/acme/billing-service",
  harness: codex(),
  env: { APP_MODE: "review" },
  secretEnv: {
    DATABASE_URL: "postgres://app:s3cret@db.internal/billing",
    STRIPE_API_KEY: "sk_live_…",
  },
});
```

What the platform guarantees for `secretEnv`, and how it differs from `env`:

- **Same grammar and size bounds** (`parseWorkspaceSecretEnv`, exported), and the same
  platform-owned names are reserved — but secret-shaped names are exactly what belongs here.
  Connected-account names (`GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`) stay reserved:
  attach those through `credentials`.
- **Never persisted in the clear.** The map rides the create request beside the spec, is sealed with
  the install's credential key on the build job, is decrypted by the worker just before launch, and
  the sealed row is cleared once the launch settles. It is never in the blueprint, the attempt
  snapshot, `WorkspaceDetails`, or any read API.
- **Never in `docker run` argv or container env.** The worker stages a `0600` file the workspace
  daemon reads once at boot and removes it the moment the workspace is ready. `docker inspect` shows
  a file path, not values.
- **Inherited by every process the platform starts in the workspace**, winning over `env` and
  container env for the same name — the harness, later shells, exec'd commands, Services.
- **Masked in captured output.** Every value seeds the daemon's redactor regardless of its name, so
  a `DATABASE_URL` a process echoes is recorded as `***REDACTED***`, like a token.
- **Fixed at creation.** A platform-side _restart_ of the workspace runs **without** secret env (the
  sealed copy is gone by design); create a new workspace to re-supply it. Docker runtime only;
  nested containers started by Compose or `docker run` inside the workspace still receive only what
  you explicitly pass.

Not covered, and worth saying plainly: a process that _deliberately_ writes a secret to a file in
the repository or to a mount is producing ordinary workspace state, and the redactor masks captured
I/O, not files.

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
