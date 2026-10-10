---
title: SDK
description:
  "@sealant/sdk — the fluent TypeScript SDK for Sealant, published on npm with a clear map of what
  is implemented versus typed-but-not-wired."
---

`@sealant/sdk` is a fluent TypeScript client for Sealant: create a workspace around a real
repository, run the harness you already use, and keep the replayable
[execution record](/docs/concepts/execution-records) after the workspace is gone. It is a thin HTTP
client over the [control-plane API](/docs/reference/http-api) — no local Docker or Postgres. It runs
anywhere the API is reachable.

The package is published on npm as `@sealant/sdk` `0.4.0`. It is early: the main workspace → run →
record path is wired, while several typed methods still reject with `SealantNotImplementedError`.

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

### Mount paths

Mount-sourced workspaces and additional mounts keep the same path-based SDK shape in every runtime.
In legacy Docker mode, `source.path`, `source.rootPath`, and `mounts[].hostPath` are host bind
paths. In strict Docker named-volume mode, they are canonical absolute paths visible to the
application and worker containers. They are not Docker's private volume data directories. The
operator maps those logical paths to actual Engine volume names; callers neither know nor inspect
that mapping. See
[Environment Variables](/docs/reference/environment-variables#docker-named-volume-mode).

### Harnesses

Harness factories describe how to invoke a harness one-shot: `opencode()`, `codex()`,
`claudeCode({ profile? })`, and `customHarness({ id, invoke, ... })` for anything else. Only
`opencode()` is exercised end-to-end today; the Codex and Claude Code invocation forms are pending
live verification against the baked workspace image.

### Owner identity

Workspaces and runs are attributed to the client's owner: `SealantConfig.ownerUserId`, else the
`SEALANT_OWNER_USER_ID` environment variable, else `usr_local`. A product that owns its own login
provisions one Sealant user per person and builds one client per user:

```ts
const admin = new Sealant({ baseUrl, apiKey: serviceKey });
const { userId } = await admin.users.ensure({ email, name }); // idempotent on email
const mine = new Sealant({ baseUrl, apiKey: serviceKey, ownerUserId: userId });
await mine.connectedAccounts.connect({ provider: "codex", secret: authJson });
```

`apiKey` is a service key (`SEALANT_SERVICE_KEYS` on the API) or a scoped user access token; see the
[HTTP API auth section](/docs/reference/http-api).

## Waiting for a workspace

`create()` resolves once the workspace is ready (pass `wait: false` to get the handle at once and
call `workspace.ready()` yourself). A launch goes through three phases, and `workspace.phase()`
reports the one it is in while the workspace is not ready:

| Phase         | What is happening                                                                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`      | Waiting for a worker to take the launch.                                                                                                                                                                                          |
| `image-build` | Building the workspace image, or finding one an earlier build of the same plan left. `imageBuild` carries the step (`step`/`steps`/`stepName`) and `progressAt`, when the build last wrote output, when the builder reports them. |
| `boot`        | The image is ready; the executor is starting and its daemon has not answered yet.                                                                                                                                                 |

`ready()` bounds each phase on its own, so a first launch on a new image is not failed by a slow
package mirror:

- **`readyTimeoutMs`** (default 10 minutes) bounds the launch outside the image build: queued, then
  booting. Past it, `ready()` rejects with `workspace_ready_timeout`.
- **`imageBuildTimeoutMs`** (default none) bounds the image build as a whole. Past it, `ready()`
  rejects with `workspace_image_build_timeout`.
- A build is otherwise waited for as long as it keeps reporting progress. The worker fails a build
  that writes nothing for `WORKSPACE_IMAGE_BUILD_STALL_MS` (10 minutes), or that runs past
  `WORKSPACE_IMAGE_BUILD_MAX_MS` (45 minutes) however much it prints, such as a dotfiles
  `install.sh` run at build time that loops. `ready()` then rejects with
  `workspace_image_build_stalled` or `workspace_image_build_timeout`, with the step the build
  stopped on.
- If the build stops reporting and nothing fails it (a worker that died and was never replaced),
  `ready()` gives up on its own (`workspace_image_build_stalled`) once it has seen no new progress
  for that stall bound plus five minutes, 20 minutes at least.
- A build that never reports progress (the Kubernetes and MicroVM builders report none, and a worker
  can die before its first report) is given up on 20 minutes after `ready()` first saw it building.
  Set `imageBuildTimeoutMs` to wait longer for such a builder: it then bounds the build instead.

Pass them to `create()` for the handle, or to `ready()` for one wait (these win):

```ts
const workspace = await sealant.workspaces.create({
  repository: "github.com/acme/billing-service",
  harness: opencode(),
  readyTimeoutMs: 5 * 60_000,
  imageBuildTimeoutMs: 45 * 60_000,
  onEvent: (event) => console.log(event.message), // "Building the workspace image (step 2/12: RUN apt-get …)"
});
```

`events()` (and `onEvent`) yields `status.<status>` on each status change and `phase.<name>` each
time the launch moves to another phase or its build to another step; a `phase.*` event carries the
phase. When `ready()` gives up on a bound for a workspace this handle created, it requests a stop
first and says whether the request was accepted. A stop while the image is still being built cancels
the launch: the build job fails (`launch-stopped`), the worker building it stops, nothing boots, and
the workspace reads `cancelled`. A launch that fails on the control plane rejects with
`workspace_not_ready` and the control plane's reason. A control plane that predates launch phases
reports none; `readyTimeoutMs` then bounds the whole wait, image build included.

An image is built once per plan (the rendered Containerfile): a later launch of the same plan reuses
the published image, and on Docker a worker whose database has no record of the plan reuses the
`sealant-workspace-<os-family>:plan-<hash>` image the Engine kept instead of building it again, once
the image carries the plan's full hash (the `sh.sealant.plan-hash` label its build stamps) and its
probe reads back. Images built before the label existed are built once more. Like any reuse of a
plan, the image is as old as its build: its base image and packages are not refreshed.

## What is implemented

These call the live API and work end-to-end:

- **Workspaces:** `sealant.workspaces.create()`, `.get()`, `.list()`
- **Workspace handle:** `workspace.status()`, `workspace.ready()`, `workspace.phase()`,
  `workspace.events()` (poll-backed status and launch-phase stream); see
  [Waiting for a workspace](#waiting-for-a-workspace)
- **Workspace lifecycle:** `workspace.stop()` (blocks until the container is gone and the workspace
  reports `stopped`), `workspace.restart()` (fresh runtime from the same resolved spec),
  `workspace.expire({ in: "2h" })` (TTL; `expire()` expires now, `expire({ in: null })` clears it) —
  plus `create({ ..., ttl: "2h" })` for a create-time TTL
- **Logins per home:**
  `workspace.credentials.put({ home, onBehalfOf, claude?, codex?, github?, pi?, opencode? })` writes
  a person's accounts into one home of the running workspace (`true` is their `default` account,
  `null` removes the provider), owned by the home's owner, and keeps them refreshed (`pi` and
  `opencode` are the person's ChatGPT login from a Codex account, merged into each tool's own
  `auth.json` beside the logins already there; `partial: true` writes what is connected and reports
  the rest in the result's `skipped`, so one call serves a person whatever they have connected); a
  home holds one person's logins until `workspace.credentials.release(home)`, and
  `workspace.credentials.list()` lists the homes. Needs a service key. A refused account rejects
  with `SealantApiError` whose `reason` is `connected-account-missing` or
  `connected-account-invalid` and whose `provider` names the account's provider. Every typed
  refusal's body code is on `reason` (`home-held`, `user-unsupported`, …); `code` is the error's
  type.
- **Per-person homes:** `create({ credentialsHome: { path, uid, gid } })` writes the launch's logins
  into that home (no login in the environment); `launch.image` (after `ready()`) and
  `workspace.image()` report the image's per-person capability; `workspaces.imageKey(options)` keys
  the image a create would build with no call, and `workspaces.inspectImage(options)` reads its
  capability before a create; `exec(argv, { user })` and `sessions.open(argv, { user })` (sent to
  the as-user routes, which an older control plane answers `404`) start the process as a person's
  Linux user (a uid in 40001–49999 whose primary group is `mend`), on a workspace whose `sealantd`
  reports `exec.user` (`workspace.processUser()`, also `launch.processUser` after `ready()`);
  anything else is refused (`user-unsupported`, the message saying why) and nothing starts. The
  daemon checks the passwd entry again and runs a process only as one of its owner map's people or a
  person in Mend's reserved range; root and anyone outside the range are refused.
  `create({ credentialsHome, sshAsOwner: true })` runs the workspace's SSH sessions (VS Code
  Remote-SSH included) as its owner's own Linux user, the `credentialsHome` uid, never root and
  never a user the caller names; `workspace.sshAsRoot()` sets them back to root. A create with
  `sshAsOwner` is refused (`ssh-user-unsupported`) before anything is sent to a control plane
  without the feature. `sealant.features()` reports what the control plane can do
  (`processUserRoutes`, `dotfilesApply`, `credentialsPartialPut`, `credentialsPiOpencode`,
  `captureOwnerMap`, `workspaceSshUser`), so a client detects them rather than reading a version. A
  capture source's `ownerMap: { gid, worktreeUid, people: [{ id, uid }] }` gives each person's saved
  directory to their uid and the worktree to the group on restore, and makes the executor a
  per-person one (no no-new-privileges, so everyone's `sudo` works); see
  [Workspace Images and People](/docs/reference/workspace-images#restoring-a-capture-per-person).
- **Dotfiles per person:**
  `workspace.dotfiles.apply({ onBehalfOf, user, home, repository?, archives? })` applies a person's
  dotfiles into their home of a running workspace, with a create's sources and applier: the clone,
  chezmoi, stow, copy and `install.sh` as their Linux user (never root), recorded on a run naming
  `onBehalfOf`. sealantd unpacks archives outside the home and writes every file in it as the
  person. Needs a service key. It resolves once every file is applied, with `bootstrap`
  (`./install.sh`) running as the person or `null`; `bootstrap.wait()` resolves with its exit code
  and output. See
  [Workspace Images and People](/docs/reference/workspace-images#a-persons-dotfiles).
- **Harness:** `workspace.harness.run(prompt)` — registers a run server-side and blocks until
  terminal; `workspace.harness.start(prompt)` — same run, returns the live handle immediately
- **Port forwarding:** `workspace.forward(port)` — a raw TCP byte pipe to `127.0.0.1:port` inside
  the workspace over one held WebSocket (`send`/`output`/`eof` for half-close/`close`). Protocol
  agnostic and never recorded; the target host is fixed at loopback by design. Rejects when nothing
  listens on the port.
- **Runs:** `sealant.runs.get(runId)`, `run.wait()` (polls to terminal, then fetches the captured
  changes), `run.result`, `run.changes` (files + diff)
- **Execution record** (`run.record`): `replay()`, `timeline()`, `stream()` (poll-backed),
  `scrollback()`, `loss()`, `summary()`, `commands()`, `transcript()`

## Typed but not implemented

These exist on the typed surface so you can compile against the final shape, but they reject at
runtime with `SealantNotImplementedError`. Do not depend on them yet:

- **Harness:** `harness.session()` (interactive)
- **Artifacts:** `run.artifacts.get()` (`.list()` currently returns empty)
- **Record time-travel folds:** `record.fileTreeAt()`, `record.processTreeAt()`

## Automating today

Use the SDK for the shipped workspace/run/record path. For endpoint coverage the SDK does not wrap
yet, use the [HTTP API](/docs/reference/http-api) directly or generate a client from
`http://localhost:4000/openapi.json`. The repo-local [CLI](/docs/reference/cli) covers connected
accounts and profile credential bindings, not general workspace/run automation.

Related: [HTTP API](/docs/reference/http-api) ·
[Runs and execution records](/docs/guides/runs-and-execution-records) ·
[What ships today](/docs/introduction/what-ships-today)
