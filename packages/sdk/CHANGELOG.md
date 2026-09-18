# @sealant/sdk

## 0.34.0

### Minor Changes

- c7c259d: The control plane fails closed (no SDK surface change; the packages ride the release
  train). The API now refuses to start when `SEALANT_SERVICE_KEYS` is unset. Missing configuration
  used to mean "serve every `/v1` route to anyone who can reach the port".
  - The one exception is explicit and for development: `SEALANT_ALLOW_OPEN_API=true`, honoured only
    when `NODE_ENV` is not `production`. Every published image sets `NODE_ENV=production`.
    `pnpm dev` sets the exception for the API it starts on loopback.
  - The web app is now a service principal: it presents `CORE_API_SERVICE_KEY` server-side.
    `install.sh` generates `SEALANT_WEB_SERVICE_KEY`, and the self-host compose file hands it to the
    web app and prepends it to the API's `SEALANT_SERVICE_KEYS`. **An existing self-host install
    must re-run `install.sh` (or add `SEALANT_WEB_SERVICE_KEY` to `.env`) before upgrading**;
    compose says so when it is missing.
  - Helm chart 0.3.0: `SEALANT_SERVICE_KEYS` is a required key of the secret, and the web app reads
    `SEALANT_WEB_SERVICE_KEY` from it. **Add both to the secret before upgrading**; the web key must
    be one of the service keys.
  - The session surface (`/v1/sessions/*`, `/v1/workspaces/:id/forward`) no longer reads "no
    `Authorization` header" as a trusted caller. The transport gate admits that surface on any
    bearer, including a `?token=` the handlers did not read, so a request with a junk `?token=` and
    an asserted `ownerUserId` was served as that owner. It is now refused, and the output stream
    accepts a user access token as `?token=`.
  - `POST /v1/github/webhooks` passes the transport gate on its own: GitHub cannot present a bearer,
    and the handler verifies the delivery's signature. With service keys set it was answered 401
    before that check could run.
  - A service key is read from `?token=` on the session surface only, where a browser cannot set a
    header. It is no longer accepted from a URL on any other route.
  - The web server refuses to start in production without `CORE_API_SERVICE_KEY`.

- 6e089f5: Per-credential and per-owner budgets. `BudgetExceededError` (HTTP 429, with `budget`,
  `limit` and `retryAfterSeconds`) joins the errors of `createWorkspace`, `restartWorkspace`,
  `createRun` and inference `respond`; the transport gate answers the same shape, with
  `Retry-After`, when one credential exceeds its request rate (`Retry-After` is set there only;
  handler refusals carry `retryAfterSeconds` in the body). A budget refuses new work and never stops
  running work. A ceiling is checked before the work is created, so creates that race can overshoot
  it by the number in flight.
  - `SEALANT_BUDGET_PRINCIPAL_REQUESTS_PER_MINUTE` (12000: one service key is a whole product) and
    `SEALANT_BUDGET_OWNER_LAUNCHES_PER_MINUTE` (120), counted per API process.
  - `SEALANT_BUDGET_OWNER_LIVE_WORKSPACES` (100) and `SEALANT_BUDGET_OWNER_ACTIVE_RUNS` (100), read
    from Postgres. A launcher that keeps standby workspaces warm per owner should size the first to
    its pool.
  - `SEALANT_BUDGET_OWNER_INFERENCE_TOKENS_PER_DAY` (off). Usage is now recorded per owner per UTC
    day in a new `inference_usage` table (migration `20260917211231_inference_usage`: counts only).
  - `SEALANT_BUDGET_RUN_OUTPUT_BYTES` (1 GiB) on the worker: past it, output chunks keep their event
    rows and lose their bytes, and the record carries one loss span where stored content ends.

  `0` turns a budget off, and the API logs at start which are off.

- 613376c: Credentials are bound to the destination they were issued for.
  - A client-supplied `authRef` is now checked against its source URL: the installation token is
    minted only for `https://<GitHub host>/<owner>/<name>[.git]` of the repository the ref stands
    for. A grant on one installation could previously attach its token to a clone of any URL. A
    restart checks the recorded spec the same way and answers 409 when it names another destination,
    and server-minted sources use the GitHub host the install talks to, so reruns pass on GitHub
    Enterprise Server.
  - `WorkspaceCaptureSource.transport` (`plaintext`, `channelCaPem`, `objectCaPem`) tells the
    workspace daemon how to dial the session channel and its object URLs. It needs a daemon with the
    capture transport policy (sealant-sh/sealantd#86); an older daemon ignores it. Without
    `transport` that daemon requires HTTPS with a publicly verifiable certificate and refuses to
    boot otherwise, so **a launcher that reaches its channel over plain HTTP on a private network
    must now send `transport: { plaintext: true }`**. The Cloudflare runtime does not support
    `transport`, and the control plane says so at create.
  - The control plane refuses a capture endpoint that is not `http(s)`, embeds credentials, is plain
    HTTP beyond loopback without `transport.plaintext`, or falls outside the operator's
    `SEALANT_CAPTURE_ALLOWED_ENDPOINTS`. `SEALANT_CAPTURE_REFUSE_PLAINTEXT=true` vetoes plain HTTP
    whatever a launcher states.

- 5411f65: Every owned operation is made for a named owner.
  - Reads, listings and changes of workspaces and runs require `ownerUserId` and serve the resource
    only when it belongs to that owner. A call that names none, or another owner, answers the same
    404 as a missing id. This closes the ID-only operations: `PATCH /v1/runs/:runId`,
    `PATCH /v1/workspaces/:id/name`, and the workspace `attempts` and `events` listings took an id
    and nothing else. `updateRun`, `renameWorkspace`, `listWorkspaceAttempts` and
    `listWorkspaceEvents` gain an optional `ownerUserId` on the wire; the control plane requires it.
  - `POST /v1/runs` creates a run only in a workspace that belongs to the owner it names. A foreign
    key used to be the only check, so any owner could start a run, executed server-side, in another
    owner's workspace.
  - An inference continuation is served only to the owner who opened the exchange; another owner's
    session id answers like one that does not exist. It was addressed by session id alone, on the
    opening owner's credentials.
  - The SDK names the owner on every record read. `workspace.exec()` read the timeline and
    scrollback without one. **An SDK older than this release reading records from a control plane
    with this release gets 404s**: upgrade callers together with the control plane, or set
    `SEALANT_REQUIRE_OWNER_SCOPE=false` on the API for the window between the two.
  - The SSH gateway's shared secret is now verified by the transport gate (its presence used to be
    enough to pass it) and is its own, narrower authority: key and target resolution, plus creating
    and updating the interactive `ssh` runs of the sessions it carries. The gateway sends it on its
    run recorder calls, which a closed control plane used to answer 401, leaving SSH sessions
    unrecorded.
  - The web app makes every control-plane call for the signed-in user, so a workspace or run id from
    another account reads like one that does not exist. Its workspace detail, attempts, events and
    rename routes checked nothing.

### Patch Changes

- f0c7ce9: Registry repository names, tags and digests are held to the OCI grammar and refused
  otherwise, never repaired. `GET /v1/registries/:id/tags` and `/manifest` now answer 400 for a
  `repository` or `reference` outside it (`..`, `%2e`, `?`, `#`, a backslash, a scheme, uppercase,
  an empty segment), and the registry client refuses the same before it builds a URL or a `docker`
  argument, keeps every request on the registry's origin under `/v2/`, does not follow redirects,
  gives each request a 30-second deadline and reads at most 8 MiB of any answer. The local Docker
  image store holds names to the same grammar, and `POST /v1/workspaces` answers 400 for a
  `repository` or `tag` outside it instead of failing the build later. The SDK's generated
  repository slug and the plan coordinates always satisfy the grammar (`.github` becomes `github`,
  `a..b` becomes `a-b`), and a prior publish under a name the grammar refuses counts as nothing to
  reuse. `isOciRepository`, `isOciTag`, `isOciDigest`, `isOciReference` and
  `toOciRepositoryComponent` are exported from `@sealant/api-contracts`.
- 7e6e1fa: Needs sealantd 0.17.0 (sealant-sh/sealantd#86): the capture session channel and every
  presigned object URL are dialled over HTTPS with a verified certificate, and never fall back. A
  plain-HTTP channel is dialled only to loopback, or when the launcher states the network is
  private: `source.transport.plaintext` on the capture source (`SEALANT_CAPTURE_ALLOW_PLAINTEXT` in
  the workspace), which this release already sends. A private CA for the channel or the object store
  rides `source.transport.channelCaPem` / `objectCaPem`. **Behaviour change:** a launcher that
  reaches its channel over plain HTTP on a private network without sending
  `transport: { plaintext: true }` now gets a workspace that refuses to boot, with the reason in its
  log. No new API surface here: `@sealant/runtime-client` and `@sealant/runtime-protocol` move to
  0.17.0, and the baked daemon default for workspace images, the MicroVM image and the Cloudflare
  bridge image is now `ghcr.io/sealant-sh/sealantd:0.17.0`.
- Updated dependencies [6e089f5]
- Updated dependencies [613376c]
- Updated dependencies [5411f65]
- Updated dependencies [f0c7ce9]
- Updated dependencies [7e6e1fa]
  - @sealant/api-contracts@0.34.0

## 0.33.1

### Patch Changes

- dcd5f3c: Needs sealantd 0.16.0 (sealant-sh/sealantd#82, #83): a daemon-only release where every
  PUT URL the capture executor mints is bound to the length the PUT then sends — the single-key
  fallback mint declared `0` before, which a registrar that signs an upload for an exact content
  length cannot serve — and where `plan.get` may name `sources`, gzipped archives the daemon lays
  down beside the worktree at boot and at every `capture.replan`, keyed by content and refused if
  they would land inside the worktree. That is how a control plane gets a directory beside the
  repository in a capture-source workspace, which mounts nothing from the host. No new API surface
  here: `@sealant/runtime-client` and `@sealant/runtime-protocol` move to 0.16.0, and the baked
  daemon default for workspace images, the MicroVM image and the Cloudflare bridge image is now
  `ghcr.io/sealant-sh/sealantd:0.16.0`.
- Updated dependencies [dcd5f3c]
  - @sealant/api-contracts@0.33.1

## 0.33.0

### Minor Changes

- c49e0ba: Support the existing Docker service requirement on Lambda MicroVM workspaces when the
  operator configures a separate Docker-capable image and pins the same image ARN/version on API and
  worker. Ordinary workspaces keep their default image. The elevated variant uses guest-root Docker
  inside the MicroVM, with a private Unix socket and disposable graph storage, not a host Docker
  socket or a rootless sidecar.

  The guest validates required-service readiness, prepares runtime directories after snapshot
  restore, and reports Docker failure without losing the terminate hook's capture-flush opportunity.
  Docker images now check daemon startup and cleanup during AWS image validation. This does not
  change the fixed-image runtime model or make MicroVMs execute the workspace-profile OCI image.

  The existing requirement to package the matching `sealantctl` alongside `sealantd` remains. Docker
  activation requires a complete platform image; installing a client package alone is insufficient.

### Patch Changes

- Updated dependencies [c49e0ba]
  - @sealant/api-contracts@0.33.0

## 0.32.0

### Minor Changes

- da0e848: Add `source.harnessHome` for capture-sourced workspaces. The optional executor-local
  directory is validated, persisted in the workspace blueprint, sent to every runtime as
  `SEALANT_CAPTURE_HARNESS_HOME`, and retained across cold materialization and standby replans. When
  omitted, capture behavior is unchanged.

### Patch Changes

- Updated dependencies [da0e848]
  - @sealant/api-contracts@0.32.0

## 0.31.2

### Patch Changes

- 9b36398: Needs sealantd 0.15.2 (sealant-sh/sealantd#78, #79): a daemon-only patch where the orphan
  reaper no longer reaps the daemon's own children, so `capture.flush` stops failing with
  `No child process (os error 10)` on 4–33% of flushes under load, and a byte-quota refusal is
  terminal instead of retried forever. No new API surface; `@sealant/runtime-client` and
  `@sealant/runtime-protocol` move to 0.15.2 and the baked daemon default for workspace images, the
  MicroVM image and the Cloudflare bridge image is now `ghcr.io/sealant-sh/sealantd:0.15.2`.
- Updated dependencies [9b36398]
  - @sealant/api-contracts@0.31.2

## 0.31.1

### Patch Changes

- 8769089: Needs sealantd 0.15.1 (sealant-sh/sealantd#76): a daemon-only patch where tracked files
  win over `.gitignore` and packs and staging survive a long ship. No new API surface;
  `@sealant/runtime-client` and `@sealant/runtime-protocol` move to 0.15.1 and the baked daemon
  default for workspace images, the MicroVM image and the Cloudflare bridge image is now
  `ghcr.io/sealant-sh/sealantd:0.15.1`.
- Updated dependencies [8769089]
  - @sealant/api-contracts@0.31.1

## 0.31.0

### Minor Changes

- 28d3d5b: `worktreeId` is optional on the `capture` workspace source. A standby executor launched
  before its worktree exists — to materialise the project base and a dependency cache, then be bound
  to a worktree at claim — omits it; `SEALANT_CAPTURE_WORKTREE_ID` stays unset on every runtime
  (Docker, Kubernetes, Cloudflare) and the daemon takes the worktree from the channel's plan answer.
- c677bc9: A `microvm` runtime adapter id: workspaces can now run on AWS Lambda MicroVMs (one
  Firecracker VM per workspace, driven with the Lambda MicroVMs API and reached through the VM's
  authenticated inbound endpoint). Workspace reads report `runtime.adapter: "microvm"` for such
  workspaces, and blueprints may request `target.runtime.family: "microvm"`. Nothing changes for
  Docker, Kubernetes or Cloudflare deployments; a deployment registers the adapter only when the
  `SEALANT_MICROVM_*` environment is configured.

  `workspace.capture.flush()` (`POST /v1/workspaces/:id/capture/flush`): a final capture, then
  everything staged is shipped and registered on the session channel, answered with the daemon's
  capture status (`pending`, `fenced`, byte and object counts). Synchronous over the control
  connection, refused on workspaces that are not capture-sourced. Needs sealantd 0.14.0 in the
  workspace image, which is now the baked default.

- fbf6c8c: `workspace.capture.replan()` (`POST /v1/workspaces/:id/capture/replan`): the daemon asks
  the session channel for its plan again with no worktree named, delta-materialises the answer over
  what is on disk, and captures under the answered worktree and epoch from then on (the fence lifts,
  foreign queue entries drop). The claim hook for a standby executor. Synchronous over the control
  connection, idempotent (`unchanged: true`), answered with the worktree id, epoch, optional head
  sequence and capture id, and the files and bytes written, skipped and removed. Refused on
  workspaces that are not capture-sourced.

  Needs sealantd 0.15.0, which also makes materialise a delta over what is on disk and sends
  `platform` on `plan.get`; `@sealant/runtime-client` and `@sealant/runtime-protocol` move to 0.15.0
  and the baked daemon default for workspace images, the MicroVM image and the Cloudflare bridge
  image is now `ghcr.io/sealant-sh/sealantd:0.15.0`.

### Patch Changes

- b9e68f7: Docker runtime: `SEALANT_DOCKER_WORKSPACE_NETWORK=<name>` attaches every workspace
  container to an existing Docker network (`--network <name>`), so a workspace resolves sibling
  Compose services — a session channel, a bucket — by name without publishing them on the host. With
  the workspace Docker service on, the container joins the shared network beside its sidecar network
  at creation (Docker Engine 25+). Every workspace container also gets
  `--add-host host.docker.internal:host-gateway`.
- Updated dependencies [28d3d5b]
- Updated dependencies [b9e68f7]
- Updated dependencies [c677bc9]
- Updated dependencies [fbf6c8c]
  - @sealant/api-contracts@0.31.0

## 0.30.0

### Minor Changes

- af93419: A `capture` workspace source (sealantd ADR-0015):
  `workspaces.create({ source: { kind: "capture", endpoint, worktreeId, token } })` launches a
  workspace that mounts nothing and clones nothing — the daemon materialises the worktree from the
  session channel onto the executor's own disk and ships captures back, so a session can run where
  no host path exists and outlive any one executor. The create request carries the credential as
  `captureToken`; the control plane seals it beside `secretEnv` and delivers it through the same
  boot file as `SEALANT_CAPTURE_TOKEN`, never into the blueprint or a read response. A capture
  workspace cannot be restarted in place. Runtime support: Docker (no workspace bind), Kubernetes
  (`emptyDir` workspace root, no store claim) and Cloudflare (kept alive while live; planned stops
  now send SIGTERM through `stop()` so the daemon can flush, with `destroy()` reserved for fencing).

### Patch Changes

- 4d64b6a: The worker now keeps workspace images and build scratch bounded. Every build's scratch
  directory (the Containerfile, plan and spec JSON, and the `docker save` tarball on registry
  installs) is removed once the image is published or the build fails; before this each build left
  up to ~800 MB under the worker's temp directory for good. An hourly retention sweep
  (`WORKSPACE_IMAGE_GC_ENABLED`, `WORKSPACE_IMAGE_GC_INTERVAL_MS`, `WORKSPACE_IMAGE_RETAINED_PLANS`,
  `WORKSPACE_IMAGE_MIN_AGE_HOURS`) deletes images no live workspace launched from, no retained plan
  still needs, and nothing published in the last week — on the Engine store by image id, on a
  registry by manifest — and removes build scratch older than six hours, so an upgrade reclaims what
  earlier versions leaked. Stopping a workspace now removes its containers with their anonymous
  volumes; the Docker sidecar used to leave one behind per workspace, and `docker volume prune`
  clears the ones older installs accumulated.
- Updated dependencies [af93419]
- Updated dependencies [4d64b6a]
  - @sealant/api-contracts@0.30.0

## 0.29.0

### Minor Changes

- f5d4625: Sealant no longer runs RabbitMQ or a zot registry on single-host installs. The job queue
  moved into the control-plane Postgres database (pg-boss, `pgboss` schema; `RABBITMQ_URL` is gone),
  and workspace images now stay in the Docker Engine that builds and runs them: the worker tags the
  built image and launches by image id, with no push, pull, or tarball round-trip. Set
  `REGISTRY_BASE_URL` + `REGISTRY_PUSH_REGISTRY` only to publish to an OCI registry (still required
  on Kubernetes, where the chart keeps its in-cluster registry). `GET /v1/registries/default`
  reports `pushRegistry: "docker-engine"` on installs without a registry. Existing self-host
  installs: re-run the installer (or `docker compose up -d --remove-orphans`) and restart any
  workspace that was mid-build during the upgrade.

  The API's `/docs` page now loads the Scalar viewer from jsDelivr instead of embedding it, and the
  server bundles are emitted as ASCII with comments stripped; together that trims roughly 20 MiB of
  resident memory per Sealant API process and 10 MiB per worker and gateway.

### Patch Changes

- Updated dependencies [f5d4625]
  - @sealant/api-contracts@0.29.0

## 0.28.0

### Minor Changes

- d0696d5: Add opt-in Docker named-volume workspace mounts through `SEALANT_DOCKER_VOLUME_MAPPINGS`.
  Containerized applications can share selected worktrees, harness state, control sockets, and
  staged launch files with sibling workspaces without host-directory binds. Existing SDK mount,
  standby, and additional-mount inputs retain their path-based contract; the deployment maps
  canonical paths to existing named volumes and subdirectories. Strict mode validates mappings and
  source directories, requires Docker API 1.45 or newer, and never falls back to host binds. Legacy
  bind mode is unchanged.

### Patch Changes

- Updated dependencies [d0696d5]
  - @sealant/api-contracts@0.28.0

## 0.27.0

### Minor Changes

- e889127: Workspace-scoped Docker on Kubernetes, and a create-time refusal where it cannot be
  served. `services.docker` now works on Kubernetes installs whose operator enabled it
  (`workspaces.docker.enabled`): the rootless daemon runs as a sidecar of a user-namespaced
  workspace Pod, the workspace receives `DOCKER_HOST=unix:///run/docker/docker.sock`, and
  `forward({ host: "docker" })` keeps resolving (to the Pod's loopback, where nested containers
  publish). An install that cannot serve the service refuses `workspaces.create` synchronously with
  `WorkspaceDockerServiceUnsupportedError` (HTTP 422, stable `code: "workspace-docker-unsupported"`)
  — the consumer's capability probe, so a workbench can explain the gap beside its Docker switch
  instead of surfacing a launch failure minutes later.

### Patch Changes

- Updated dependencies [e889127]
  - @sealant/api-contracts@0.27.0

## 0.26.0

### Minor Changes

- 643f809: Standby workspaces and bindable mounts (sealantd ADR-0014, Mend ADR-0001). A workspace
  can now be created with `source: { kind: "standby", rootPath }`: the caller-owned root (a
  project's worktrees directory) is mounted hidden and the working directory does not exist until
  `workspace.bind({ subpath })` points it at one of the root's subdirectories — after the container
  is already running, which neither Docker nor Kubernetes allow for a mount. An extra mount declared
  `bindable: true` works the same way for its own path, so a project can mount a sibling
  repository's worktrees and bind one at `/workspace/repos/<name>`. `POST /v1/workspaces/:id/bind`
  applies the bind over the daemon's control connection and records the workspace's live bindings,
  which every relaunch re-supplies. Requires a sealantd with `bindMount` (runtime-client 0.13).

### Patch Changes

- Updated dependencies [643f809]
  - @sealant/api-contracts@0.26.0

## 0.25.0

### Minor Changes

- c914f09: Workspace SSH reaches the SDK: `sealant.workspaceSsh.info()` returns the deployment's
  gateway connect coordinates (host, port, username prefix; null when no gateway is configured), and
  `sealant.sshKeys.ensure/list/remove` manage the owner's SSH public keys — `ensure` is idempotent,
  so consumers can offer a machine's key on every start. Together these let a product open a
  workspace in an editor over SSH without any manual gateway or key configuration.

### Patch Changes

- @sealant/api-contracts@0.25.0

## 0.24.1

### Patch Changes

- 3b8580e: Server fix riding this release: `GET /v1/sessions/:id/output` and the SSE tail
  (`/output/stream`) now serve pipe-mode sessions. Both filtered recorded chunks to the PTY output
  stream kind only, so a protocol-mode harness opened over `openSession({ mode: "pipe" })` — claude
  stream-json, codex app-server — looked permanently silent to every reader even though its stdout
  was captured and stored. The read paths now accept the pty-out and stdout kinds (one session only
  ever records one of them) and scope by the session's daemon id so a run's other sessions never
  interleave. No SDK code change; `output()` simply starts returning data for pipe sessions.
  - @sealant/api-contracts@0.24.1

## 0.24.0

### Minor Changes

- 2ca12be: Cluster env sources at the create boundary (cluster-env-sources design, phase 1 of 2).
  - `workspaces.create` accepts `envFrom` — an ordered list of
    `{ kind: "secret" | "configmap", name }` naming Kubernetes objects in the platform's workspaces
    namespace whose keys become workspace environment, resolved by the platform worker at creation —
    and `kubernetes.serviceAccountName`, an explicit allowlisted trust grant for the workspace Pod.
  - On a deployment whose effective runtime family is not Kubernetes, create refuses synchronously
    with the new typed error (`WorkspaceRuntimeEnvReferencesUnsupportedError`, HTTP 422, stable code
    `runtime-env-references-unsupported`). The stable code doubles as the SDK consumer's capability
    probe.
  - This release carries the surface and the fail-closed gate only; worker-side resolution (label
    opt-in, both kinds, ordering semantics, the ServiceAccount allowlist) ships in the companion
    change — until it lands, Kubernetes launches with these fields are refused with an honest "not
    resolved by this platform build yet".

### Patch Changes

- Updated dependencies [dd88081]
- Updated dependencies [2ca12be]
  - @sealant/api-contracts@0.24.0

## 0.23.0

### Minor Changes

- 3a9c68c: `workspaces.create` no longer pins the runtime target to Docker. The blueprint now
  carries `target.runtime: { family: "auto", mode: "prefer" }`, so the deployment's default runtime
  adapter decides — Docker on self-host (unchanged behaviour), Kubernetes when the control plane's
  worker is configured for a cluster. Callers that genuinely need a specific runtime family can
  still say so through the control-plane API's blueprint.

### Patch Changes

- 3a9c68c: Session attach, SSE output streams, and workspace port forwards now always send the
  `ownerUserId` assertion in the URL. Previously it was sent only for host-local (no API key)
  clients, so a service-principal client opening the attach WebSocket was rejected with "ownerUserId
  is required when authenticating as a service principal."
  - @sealant/api-contracts@0.23.0

## 0.22.0

### Minor Changes

- b45e4a4: Per-user identity for products that own their own login.
  - **Service principals.** `SEALANT_SERVICE_KEYS` (API) closes the control plane: every `/v1`
    request must carry a service key as a bearer (may assert any `ownerUserId`) or, on the session
    surface, a scoped user access token. Unset keeps the open loopback-only model. Public routes
    (`/healthz`, `/readyz`, `/openapi.json`, `/docs`) and the gateway routes are unaffected.
  - **Users endpoint.** `POST /v1/users` upserts a user by email and `GET /v1/users/:userId` reads
    one — the provisioning path for a product that maps each of its users to a Sealant user.
  - **Owner scoping on reads.** `GET /v1/workspaces/:id` and the `GET /v1/runs/:id` family accept an
    optional `ownerUserId` query and answer 404 when it does not match; the SDK always sends it,
    closing the by-id reads that previously leaked across owners.
  - **SDK.** `SealantConfig.ownerUserId` (one client per user; overrides `SEALANT_OWNER_USER_ID`),
    `sealant.users.{ensure,get}`, and `sealant.connectedAccounts.{list,connect,disconnect}`; the
    matching `/effect` operations and contract errors are exported.

### Patch Changes

- Updated dependencies [b45e4a4]
  - @sealant/api-contracts@0.22.0

## 0.21.0

### Minor Changes

- 06295a9: Pipe-mode sessions: `workspace.sessions.open(argv, { mode: "pipe" })` (and
  `POST /v1/sessions` with `mode: "pipe"`) starts the leader with plain stdio pipes and no
  controlling terminal — the shape for processes that speak a byte protocol over stdin/stdout, such
  as `codex app-server` or `claude --print --input-format stream-json`. `send` feeds stdin,
  `output`/`attach` carry stdout byte-exact with the same replay-from-sequence semantics as PTY
  sessions, stderr is recorded as diagnostics only, and `resize` is rejected. Sessions report
  `mode`; the default stays `pty`. Requires sealantd ≥ 0.11 in the workspace image.

### Patch Changes

- Updated dependencies [06295a9]
  - @sealant/api-contracts@0.21.0

## 0.20.2

### Patch Changes

- fb27d3f: Workspace images install claude-code with `--allow-scripts=@anthropic-ai/claude-code`:
  recent npm blocks install scripts by default, and claude-code's postinstall is what links its
  native binary — without it every `claude` launch died with "claude native binary not installed"
  once the v0.20.0 plan-hash rotation rebuilt images. Codex was unaffected (no install script).
  Older npm treats the unknown config as a warning; plan hashes rotate once so broken images
  rebuild. No API surface changes; this release exists to rebuild workspace images.
- Updated dependencies [fb27d3f]
  - @sealant/api-contracts@0.20.2

## 0.20.1

### Patch Changes

- 4effb57: The api image bakes system CA certificates. The Codex CLI the codex inference engine
  spawns is a native binary that validates TLS against `/etc/ssl/certs`, which
  `node:24-bookworm-slim` does not ship — every codex exchange failed with "invalid peer
  certificate: UnknownIssuer" until the store exists. Node's own TLS (and therefore the claude
  engine, which runs through the Agent SDK) was never affected. No API surface changes; this release
  exists to rebuild the image.
- Updated dependencies [4effb57]
  - @sealant/api-contracts@0.20.1

## 0.20.0

### Minor Changes

- 7e8d789: Codex inference on connected accounts: `/v1/inference/respond` (and
  `sealant.inference.respond`) now accepts `credentials: { codex: true | "<name>" }` and runs the
  exchange through the official Codex CLI against a private per-invocation `CODEX_HOME`, on the
  caller's own OpenAI subscription. `model` passes through verbatim on both arms. The rotated
  auth.json is read back at end of exchange and persisted newest-wins, exactly like the workspace
  sync-back. Tool-less v1: caller-defined `tools` stay claude-only (a codex exchange with tools is a
  400), `maxTurns` is claude-only, and a profile-only selection prefers the profile's claude binding
  before falling back to its codex binding. Selecting both providers in one exchange is now an
  explicit 400.

### Patch Changes

- 8fce747: Nix-family workspace images boot again. The Containerfile set
  `ENTRYPOINT ["sealantd", "boot"]` — exec form with a bare name, resolved against the image's
  `PATH` — but `nixos/nix` ships only its profile dirs there, so every nix workspace died at
  container init with `exec: "sealantd": executable file not found in $PATH` before ever reaching
  ready. The entrypoint is now the absolute `/usr/local/bin/sealantd`, and both render paths (distro
  and custom base) prepend `/usr/local/bin` to `PATH` so the other baked binaries (the docker CLI,
  socat, and anything sealantd resolves by name in-container) work on bases that don't include it.
- Updated dependencies [7e8d789]
  - @sealant/api-contracts@0.20.0

## 0.19.1

### Patch Changes

- efd0fe7: Workspace images bake `bubblewrap` alongside the Codex CLI. Codex's Linux sandbox wants a
  system `bwrap` and printed "Codex could not find bubblewrap on PATH … will use the bundled
  bubblewrap" on every launch without it — the first thing every new workspace showed. The
  prerequisite now travels with the harness integration on every family (fedora, arch, ubuntu, nix),
  so the banner is gone and Codex sandboxes with the distro's `bwrap`. Image plan hashes change, so
  existing workspace images rebuild once.
- Updated dependencies [efd0fe7]
  - @sealant/api-contracts@0.19.1

## 0.19.0

### Minor Changes

- a761e8c: Secret environment variables on `workspaces.create({ secretEnv })` — the transient secret
  channel.

  The map is validated by the exported `parseWorkspaceSecretEnv` (same grammar/bounds as `env`, same
  platform-owned reservations, but secret-shaped names allowed; connected-account names stay
  reserved), rides the create request beside the spec, is sealed with the install's credential key
  on the build job, decrypted by the worker just before launch, staged as a `0600` boot file the
  workspace daemon (sealantd ≥ 0.10.0) reads once, removed from the host the moment the workspace is
  ready, and cleared from the job row when the launch settles. It never enters the blueprint, the
  attempt snapshot, `docker run` argv, container env, or any read API; every value is masked in
  captured process output; every process the platform starts in the workspace inherits it, winning
  over `env` and container env for the same name. Platform-side restarts run without secret env by
  design. The workspace image now bakes sealantd 0.10.0.

- e621c78: Non-secret workspace environment variables on `workspaces.create({ env })`.

  The map is validated against a public policy (grammar, size bounds, reserved platform names, and
  secret-looking names the workspace runtime would silently drop), lowered into a new strict
  `runtime.userEnv` blueprint field, set on the workspace container, and inherited by every process
  the platform starts inside the workspace — the harness, later shells, and exec'd commands. Values
  are ordinary configuration by contract: they persist verbatim in the durable workspace spec and
  are returned by workspace-details APIs; secrets stay on `credentials`. Live workspaces are never
  mutated, restarts reuse the stored spec, and caller values can never override platform controls or
  injected credentials (caller env is emitted first under docker's last-wins `-e` ordering).

  The policy is exported from both packages (`parseWorkspaceEnv`, `findWorkspaceEnvReservedRule`,
  `formatWorkspaceEnvIssue`, `WORKSPACE_ENV_*` constants; also importable via
  `@sealant/api-contracts/workspace-environment`) so downstream settings surfaces validate with the
  platform's exact rules. Legacy `runtime.env` keeps its unrestricted stored-spec semantics and is
  not emitted by the SDK; worker-resolved dotfiles clone auth moved off that field onto a transient
  adapter launch input and no longer rides any blueprint env map.

### Patch Changes

- Updated dependencies [a761e8c]
- Updated dependencies [e621c78]
  - @sealant/api-contracts@0.19.0

## 0.18.1

### Patch Changes

- 98521fc: Dotfiles archives now stage under the control-socket shared directory when the worker
  runs inside the self-host compose stack. `docker run -v` resolves bind paths on the daemon's host
  filesystem, so archives staged in the worker container's private tmpdir arrived as an empty mount
  and boot aborted with "manifest.json: No such file or directory". The staging root now follows
  `WORKSPACE_CONTROL_SOCKET_HOST_DIR` (`<dir>/_dotfiles/…`) — the one path the stack bind-mounts at
  the same location on both sides — and host-run workers keep using the system tmpdir.
- Updated dependencies [98521fc]
  - @sealant/api-contracts@0.18.1

## 0.18.0

### Minor Changes

- 0d4d02b: Dotfiles and shell:
  `workspaces.create({ shell: "zsh", dotfiles: { repository, archives } })`. `shell` installs the
  login shell and switches to it so shell dotfiles take effect. `dotfiles` accepts a repository the
  platform clones (manager auto-detected: chezmoi / stow / copy, optional bootstrap) and/or
  caller-resolved archives — gzipped tars applied at boot through the same manager dispatch, the
  shape for dotfiles resolved host-side with the caller's own ssh identity or scanned from the home
  directory. The repository applies first, then archives in order; everything applies before the
  workspace reports ready, and a failing apply fails the launch loudly. Dotfiles ref handling no
  longer assumes `main` (absent = the remote's default branch), chezmoi is provisioned on every
  managed family (on Ubuntu 24.04 from the pinned upstream release — the archive has no package),
  and client-supplied `authRef`s are now validated at create against the caller's GitHub
  installation grants. Not supported with `baseImage`.

### Patch Changes

- Updated dependencies [0d4d02b]
  - @sealant/api-contracts@0.18.0

## 0.17.0

### Minor Changes

- ae55cdd: Custom base images: `workspaces.create({ baseImage: "node:22-bookworm" })` builds the
  workspace image from any caller-supplied OCI reference instead of a managed OS family. Distro
  package installs are skipped; the build overlays only the sealantd supervisor, the harness CLIs
  (npm), and a fully static socat relay (vendored beside sealantd). The base-image contract
  (documented in the SDK README): any Linux base on amd64/arm64 with a POSIX shell, node + npm for
  the harness CLIs, git for clone/mount sources — each checked at build time with readable failures,
  including a shell-less base. `packages` pass through verbatim to the base's own detected package
  manager (apt/apk/dnf/pacman). `baseImage` and `os` are mutually exclusive.
- cd4ce97: Ubuntu as a first-class workspace OS family: `workspaces.create({ os: "ubuntu" })` builds
  the workspace image from `ubuntu:24.04` with apt-installed packages (cached, non-interactive), the
  same baked harness CLIs, socat relay, and `sealantd boot` entrypoint as the other families.
  Package standardization resolves portable package names against the Ubuntu 24.04 archive (`python`
  → `python3`, `fd` → `fd-find`, `github-cli` → `gh`); packages the archive does not carry (`pnpm`,
  `uv`, `mise`, `lazygit`) are reported unsupported at create time. The `resolvePackage` response's
  `osSupport` now always carries an `ubuntu` entry, so an SDK at this version needs a control plane
  at the same version.

### Patch Changes

- Updated dependencies [ae55cdd]
- Updated dependencies [cd4ce97]
  - @sealant/api-contracts@0.17.0

## 0.16.0

### Minor Changes

- 9472211: UDP forwards: `workspace.forward(port, { protocol: "udp" })` opens a connected-UDP
  forward in the workspace instead of a TCP stream — one frame on the pipe is exactly one datagram,
  both directions (`?protocol=udp` on the forward WS route; sealantd 0.7.0 underneath). TCP is
  unchanged and remains the default.

### Patch Changes

- Updated dependencies [9472211]
  - @sealant/api-contracts@0.16.0

## 0.15.0

### Minor Changes

- cfb6965: `workspace.forward(port, { host })`: the forward target grows from fixed loopback to a
  closed workspace-private set — `127.0.0.1` (default) or `docker`, the workspace-scoped Docker
  sidecar's network alias. Inner `docker compose` publishes its ports on that sidecar, so a database
  started by compose is now reachable through the same forward surface. Never caller-arbitrary: the
  allowlist is the SSRF boundary.

### Patch Changes

- Updated dependencies [cfb6965]
  - @sealant/api-contracts@0.15.0

## 0.14.0

### Minor Changes

- 4a735c8: `workspace.forward(port)`: a raw TCP byte pipe to `127.0.0.1:port` inside the workspace,
  over one held WebSocket (`GET /v1/workspaces/:id/forward?port=N`, scope `workspace:exec`). The
  public surface for sealantd's existing forward primitive — protocol-agnostic, never recorded, host
  fixed at loopback. Nothing listening on the port is an HTTP 502 before the upgrade; a text
  `{"t":"eof"}` frame carries TCP half-close, which WebSockets lack natively.

### Patch Changes

- Updated dependencies [4a735c8]
  - @sealant/api-contracts@0.14.0

## 0.13.5

### Patch Changes

- efcee92: Bake every supported harness CLI into each workspace image (codex + claude-code; opencode
  installs as an extra when a blueprint requests it), and inject `SEALANT_HARNESS_BANNER` /
  `SEALANT_HARNESS_LAUNCH_COMMAND` at container launch instead of baking them as image ENV. Harness
  choice now decides what launches, not what is installed — a shell in any workspace can open either
  baked agent against the same files and state.
- Updated dependencies [efcee92]
  - @sealant/api-contracts@0.13.5

## 0.13.4

### Patch Changes

- 6b91552: Allow the self-host API to open persisted workspace control sockets by mounting the
  socket directory read-only and using sealantd's required root peer identity, while dropping all
  Linux capabilities and forbidding privilege escalation.
- Updated dependencies [6b91552]
  - @sealant/api-contracts@0.13.4

## 0.13.3

### Patch Changes

- 145295d: Include the Docker Compose CLI plugin in workspace images whenever the workspace-scoped
  Docker service is enabled, so `docker compose` works against the workspace's disposable daemon.
- Updated dependencies [145295d]
  - @sealant/api-contracts@0.13.3

## 0.13.2

### Patch Changes

- c245231: Keep API-backed workspace sessions on the persisted Unix control socket, including
  workspaces that do not enable SSH, so self-hosted API containers can supervise runs without a
  Docker CLI.
- Updated dependencies [c245231]
  - @sealant/api-contracts@0.13.2

## 0.13.1

### Patch Changes

- bb4ae55: Declare Effect as a consumer-provided peer dependency so `@sealant/sdk/effect` and
  `@sealant/api-contracts` compose with the consumer's compatible Effect runtime instead of
  installing an incompatible second copy.
- Updated dependencies [bb4ae55]
  - @sealant/api-contracts@0.13.1

## 0.13.0

### Minor Changes

- 62d46d4: Add `workspaces.create({ services: { docker: true } })`. Docker-enabled workspaces
  include the client and connect to a disposable workspace-scoped rootless daemon without mounting
  the host Docker socket.

### Patch Changes

- @sealant/api-contracts@0.13.0

## 0.12.3

### Patch Changes

- bf5a55b: Forward the workspace mount allowlist and connected-account encryption key from self-host
  `.env` configuration into the API and worker containers.
- Updated dependencies [bf5a55b]
  - @sealant/api-contracts@0.12.3

## 0.12.2

### Patch Changes

- Updated dependencies [f605a8b]
  - @sealant/api-contracts@0.12.2

## 0.12.1

### Patch Changes

- Updated dependencies [7ca347a]
  - @sealant/api-contracts@0.12.1

## 0.12.0

### Minor Changes

- 7fc7aef: Mount-sourced linked Git worktrees now automatically carry their shared Git metadata into
  the workspace. The worktree remains the single public source and all repository data stays in
  caller-owned host storage, while Git commands inside the workspace can follow the existing `.git`
  pointer normally.

### Patch Changes

- @sealant/api-contracts@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [8d86e05]
  - @sealant/api-contracts@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [cc7dddc]
  - @sealant/api-contracts@0.10.0

## 0.9.0

### Minor Changes

- 63824ae: Workspace creation accepts additional caller-owned mounts beside the primary source:
  `workspaces.create({ mounts: [{ hostPath, mountPath, readOnly }] })`. Extra mounts are read-only
  by default and bind at a container path outside the working directory (e.g.
  `/workspace/ref/effect`) — they widen what the workspace can see, not where its work product
  lands. Host paths ride the same operator allowlist as mount sources
  (`SEALANT_MOUNT_ALLOWED_STORE_ROOTS`); the control plane rejects container paths overlapping the
  working directory or the daemon control dir. Like the primary mount, extra mount paths are
  caller-owned — never reprovisioned, never cleaned.

### Patch Changes

- @sealant/api-contracts@0.9.0

## 0.8.1

### Patch Changes

- d160516: Fix `session.attach`: the WS route now addresses the daemon's session id (and rejects
  non-running sessions with a 409) instead of passing the control plane's id to the daemon.
  - @sealant/api-contracts@0.8.1

## 0.8.0

### Minor Changes

- 091ef5c: A real data plane for interactive terminals: `session.attach()` over one held WebSocket.

  The request/response session verbs made every keystroke pay auth + DB lookups + a fresh
  short-lived daemon connection (a `docker exec` spawn per event on the default transport), and
  output rode a 250ms journal poll — hopeless for an interactive terminal. New raw route
  `GET /v1/sessions/:sessionId/attach` upgrades to a WebSocket, authenticates once, opens ONE daemon
  control connection for the socket's lifetime, and bridges the daemon's reliable attach channel
  (byte-exact replay from `?from=`, then live output) both ways. Binary frames are PTY bytes; text
  frames are control JSON (`{"t":"resize",...}` up, `{"t":"end"}` down). The SDK exposes it as
  `session.attach({from})` → `SessionAttachment` (`send`/`resize`/`output`/`closed`/`close`). The
  existing `send`/`output` verbs remain the request/response control plane.

### Patch Changes

- Updated dependencies [091ef5c]
  - @sealant/api-contracts@0.8.0

## 0.7.1

### Patch Changes

- e0aab44: Strip the create-payload `credentials` key from the workspace spec before it reaches the
  build job. The SDK folds `credentials` into the spec it sends; the api lowers it into
  `runtime.credentialRefs` but previously left the raw key in place, and the worker's strict
  blueprint schema rejected it — killing every `mount` + `credentials` create at
  `parseWorkspaceBlueprint` ("Unrecognized key: credentials"). Mount-sourced workspaces with
  connected-account credentials now build.
- Updated dependencies [e0aab44]
  - @sealant/api-contracts@0.7.1

## 0.7.0

### Minor Changes

- 649d965: Mount-sourced workspaces, first-class interactive PTY sessions, scoped access tokens, and
  byte-exact resumable session output — the Mend agent-workbench P0 surfaces (plan §8.1.A/§8.1.B).
  - **Mount source**: `workspaces.create({ source: { kind: "mount", path } })` provisions the
    workspace from a caller-owned host directory bind-mounted as the working directory instead of a
    clone (sealantd ≥ 0.6.0). The path is caller-owned: writes persist across stop/restart/expiry
    and the platform never reprovisions or deletes it. Paths must be proper descendants of an
    operator-configured allowlist root (`SEALANT_MOUNT_ALLOWED_STORE_ROOTS`, enforced at the API,
    the launch adapter, and daemon boot). Credentials and dotfiles options compose unchanged;
    clone-based workspaces are unaffected.
  - **Interactive sessions**: `workspace.sessions.open(argv)` / `.get(id)` / `.list()` and a real
    `harness.session()`. Sessions are durable platform resources: the PTY survives handle and
    process loss, and a session re-fetched by id from any workspace handle supports `send()` (string
    or bytes), `resize()`, `signal()`, `status()` (with the output high-water cursor), and
    `close()`. New control-plane endpoints under `/v1/sessions`, including an SSE live tail
    (`/v1/sessions/:id/output/stream`).
  - **Byte-exact resumable output**: session output is recorded redacted and sequence-keyed;
    `session.output({ from })` replays exact history and continues into the live tail, resumable
    after any disconnect via `lastChunk.sequence + 1n`. `GET /v1/runs/:id/scrollback` gains
    `fromSequence`/`limit` range reads and a `pty` stream for interactive runs.
  - **Scoped access tokens**: `sealant.accessTokens.create({ scopes, workspaceId?, ttl? })` mints
    bearer tokens over three scopes — `session:read` (stream/status), `session:input`
    (input/resize/signal), `workspace:exec` (open terminals) — enforced on the session surface, so a
    read-stream token can stream but is rejected for input and exec.
  - **Server-side run commands**: run invocations for built-in harnesses are constructed by the
    control plane (persisted on the run), so `workspaces.get(id)` handles can start harness runs; an
    explicit client command remains the `customHarness()` escape hatch.
  - **Correlation metadata**: opaque `metadata` bags accepted at run and session creation, stored
    verbatim and echoed on reads.
  - sealantd image pin bumped to 0.6.0 (mount boot contract, durable PTY session journal, file
    events on by default).

### Patch Changes

- Updated dependencies [649d965]
  - @sealant/api-contracts@0.7.0

## 0.6.0

### Minor Changes

- 6d1d72d: Workspace lifecycle close-out: `workspace.stop()`, `workspace.restart()`, and
  `workspace.expire()` are real end-to-end operations instead of `SealantNotImplementedError`
  rejections.
  - New control-plane endpoints: `POST /v1/workspaces/:id/stop` (async 202 — the worker removes the
    container and records the terminal `stopped` state), `POST /v1/workspaces/:id/restart` (async
    202 — a fresh launch from the same resolved spec, recorded as a new attempt), and
    `POST /v1/workspaces/:id/expire` (sets, clears, or triggers the workspace TTL).
  - `WorkspaceStatus` gains `"stopped"`, and workspace summaries/details expose `expiresAt`.
  - `createWorkspace` accepts an optional `ttlSeconds`; the SDK's `create()` accepts
    `ttl: "2h"`-style durations. Expired workspaces are stopped by the platform reaper.
  - SDK `stop()` blocks until the workspace reports `stopped`; `restart()` returns a fresh handle
    whose `ready()` gates on the new runtime; `expire({ in: "2h" | null })` sets or clears the TTL.

  Compatibility: adding `"stopped"` to the workspace status enum changes the wire contract — older
  published SDKs decode workspace responses against the previous five-value literal union and will
  fail to decode a stopped workspace. Upgrade the SDK together with the control plane.

### Patch Changes

- f4c35ca: `workspaces.create()` without a `ref` now really does use the repository's default
  branch, as the option's docs always claimed. The SDK no longer lowers a missing `ref` to `"main"`,
  the blueprint schema keeps the workspace source `ref` truly optional instead of defaulting it, and
  the docker runtime adapter omits `SEALANT_WORKSPACE_REPO_REF` entirely when unset so sealantd's
  plain `git clone` resolves the remote HEAD. Previously every repository whose default branch isn't
  `main` (e.g. `master`) failed workspace boot with
  `fatal: Remote branch main not found in upstream origin`. Requires sealantd ≥ 0.5.1 in the
  workspace image for the no-ref path.
- Updated dependencies [6d1d72d]
  - @sealant/api-contracts@0.6.0

## 0.5.0

### Minor Changes

- 0d2ce1c: Inference on connected accounts. New `inference` contract group:
  `POST /v1/inference/respond` runs short, tool-calling inference loops on the caller's own
  subscription — the server resolves the connected-account reference (same shape as workspace
  creation), decrypts, and invokes the OFFICIAL Claude Agent SDK with `CLAUDE_CODE_OAUTH_TOKEN`
  (never raw model-API calls on stored credentials, per the connected-accounts design's hard
  constraint). Caller-defined JSON-schema tools are exposed to the model verbatim; tool calls park
  server-side and the CALLER executes them, posting results back in a multi-turn session loop.
  Structured output rides the agent SDK's native json_schema output format. SDK:
  `sealant.inference.respond(...)` (new exchange or continuation) + `inferenceRespondOp` in the
  Effect core. Usage is attributed per account (`last_used_at`), and a live auth rejection marks the
  account invalid. Claude accounts only; Codex inference is a stated follow-up.
- 012f858: Export the Effect-native core at the `@sealant/sdk/effect` subpath. Effect-end-to-end
  consumers get the contract-derived control-plane client as a service (`SealantApiClient` +
  `sealantApiClientLayer`), one operation effect per contract endpoint, the managed runtime
  (`makeSdkRuntime`), and the typed contract errors on the failure channel — instead of wrapping the
  Promise facade. The README's "will be reachable" promise is now true.
- 5cabebb: Typed record-event taxonomy. `@sealant/api-contracts` now exposes the payload schemas
  behind every recorded event kind (process, io, file, network, runtime, and loss events — the
  stored jsonb shape: uint64s as decimal strings, protocol enums as numbers) plus
  `decodeRecordEventPayload`, a total decoder that folds a wire `(kind, ref)` pair into a
  discriminated union and degrades to an `unknown` case instead of throwing. The SDK's
  `TimelineEntry` is now that discriminated union: switch on `kind` and `data` narrows to the typed
  payload, with `{ kind: "unknown", rawKind, data }` as the forward-compatibility case for kinds
  newer than the SDK. No new event kinds were added; a file-read/open event is noted as future work.
- 436546e: Deterministic exec in a workspace. New contract endpoint `POST /v1/workspaces/:id/exec`
  executes an ORDERED LIST of commands in the workspace, recorded as ONE run (a "check run") on the
  same run-exec pipeline as harness runs — every command executes in order regardless of exit codes
  (a nonzero exit is a check datum, e.g. `base fails · head passes · revert fails`), and the run
  completes iff every command executed and was recorded. SDK: `workspace.exec(argv, { cwd? })`
  returns `{ exitCode, stdout, stderr, run }`, resolving on nonzero exits and rejecting only when
  the execution machinery itself broke.

### Patch Changes

- Updated dependencies [0d2ce1c]
- Updated dependencies [5cabebb]
- Updated dependencies [436546e]
  - @sealant/api-contracts@0.5.0

## 0.4.0

### Minor Changes

- a551b17: Rename the product's core noun from `sandbox` to `workspace` across the public API and
  SDK. "Workspace" is the honest, industry-standard name for the live, disposable environment a
  harness works in — Sealant does not provide a hardened security sandbox, so the old name
  over-promised containment. The `run` and `harness` nouns are unchanged.

  Concretely, this changes web and API routes from `/sandboxes` to `/workspaces`, renames the SDK
  surface (`sealant.sandboxes` → `sealant.workspaces`, and the `sandbox` handle to `workspace`),
  switches the SSH username prefix from `sbx-` to `ws-`, adds a rename-only database migration for
  the workspace tables and columns, and renames the internal `@sealant/sandboxes` package to
  `@sealant/workspaces`.

### Patch Changes

- Updated dependencies [a551b17]
  - @sealant/api-contracts@0.4.0

## 0.3.1

### Patch Changes

- 2b90be5: Platform release: interactive-run telemetry ingest re-enabled (run-keyed) with honest
  head-loss accounting. No SDK surface changes — this release keeps the package versions in lockstep
  with the self-host images that actually record interactive sessions.
  - @sealant/api-contracts@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [bf3dc5e]
  - @sealant/api-contracts@0.3.0

## 0.2.0

### Minor Changes

- 6234d20: First public release of the fluent SDK.
  - `harness.run(prompt)` — blocking one-shot execution: registers the run server-side, resolves
    once terminal with the captured changes (files + diff) inline.
  - `harness.start(prompt)` — non-blocking: same server-side run, returns the live `Run` handle
    immediately; stream progress with `run.record.stream()` and settle with `run.wait()`.
  - `run.wait()` now fetches the server-side captured changes once the run is terminal, so handles
    from `start()` and `runs.get()` settle with an honest diff.
  - Execution-record read surface: `replay()`, `timeline()`, `stream()`, `scrollback()`,
    `commands()`, `transcript()`, `loss()`, `summary()`.
  - `@sealant/api-contracts` ships as the contract-first HTTP API definition the SDK's client is
    derived from.

### Patch Changes

- Updated dependencies [6234d20]
  - @sealant/api-contracts@0.2.0
