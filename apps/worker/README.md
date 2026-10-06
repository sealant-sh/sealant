# Worker App

`@sealant/worker` is the first background worker for Sealant workspace image build jobs.

It currently provides:

- a Node worker entrypoint
- one worker-kind module per domain workload under `src/workers/`
- job-queue transport via `@sealant/jobs` (pg-boss, in the control-plane database)
- workspace lifecycle processing through `@sealant/workspaces`
- durable state updates through `@sealant/db`

## Development

Run the worker locally:

```bash
pnpm --filter @sealant/worker dev
```

Run the worker in Docker Compose:

```bash
docker compose --profile apps up -d worker
```

The Compose worker image now bakes the repo into the container and talks to the host Docker daemon
through the mounted socket. That keeps local `node_modules` ownership on the host untouched.

For local development, the Compose worker connects to the shared PostgreSQL service from the root
`compose.yaml`. Run migrations on the host before starting the worker:

```bash
pnpm db:migrate
```

The worker expects:

- the PostgreSQL database from `@sealant/db` — it carries the job queue too, in the `pgboss` schema,
  which the worker creates on first start
- access to the host Docker socket for BuildKit image builds and Docker runtime launches

Built images stay in that Docker Engine: the worker tags them
`sealant-workspace-<osFamily>:plan-<hash>` and launches workspaces by image id, so nothing is pushed
or pulled. Set `REGISTRY_BASE_URL` and `REGISTRY_PUSH_REGISTRY` together to publish to an OCI
registry instead; Kubernetes builds require them.

`WORKSPACE_BUILD_QUEUE_PREFETCH` (default `1`) sets how many build and lifecycle deliveries one
worker process handles at once; `RUN_EXEC_QUEUE_CONCURRENCY` (default `4`) sets how many run-exec
deliveries (harness runs and workspace execs) it handles at once.

Image retention runs in the worker: every hour (`WORKSPACE_IMAGE_GC_INTERVAL_MS`, first pass 30 s
after boot) it deletes workspace images no live workspace launched from and no retained plan needs
(`WORKSPACE_IMAGE_RETAINED_PLANS`, default `10`), never touches an image published within
`WORKSPACE_IMAGE_MIN_AGE_HOURS` (default a week), and removes build scratch older than six hours
from the OS temp directory. `WORKSPACE_IMAGE_GC_ENABLED=false` turns the sweep off.

Run records are kept as long as their runs unless `SEALANT_RUN_RECORD_RETENTION_DAYS` is set: then,
every hour (first pass 5 min after boot), the worker deletes the record (`telemetry_*` rows) of
every run that finished more than that many days ago, at most 5,000 rows per statement and 500,000
per pass, and sets the run's `record_deleted_at`. The run row stays.

Every hour (first pass a minute after boot) the worker also deletes run-exec job rows left in
`pgboss.job`: a worker deletes each job as it takes it, because the job holds the command's
arguments, so a finished or dead-lettered copy, or one `active` for over ten minutes, is a leftover.

The worker also watches launched runtimes: every `WORKSPACE_RUNTIME_EXIT_POLL_INTERVAL_MS` (default
5 s) it asks each runtime whether its `ready` workspaces are still up, and Docker (`docker events`)
and Kubernetes (a watch on the workspace Pods) additionally report exits as they happen. A workspace
whose container or Pod died on its own is recorded `failed` with its exit code and log tail, and its
remains are removed — the same terminal state a container that dies during boot gets.

No stop loses a capture-sourced workspace's unsaved work. Before the worker tears one down — a
lifecycle stop, the expired, stranded, superseded and orphaned reapers, a retained launch, or the
deadline sweep — it asks the workspace's sealantd for a FINAL flush (this executor is ending) and
polls its capture status (`WORKSPACE_CAPTURE_DRAIN_POLL_INTERVAL_MS`). The runtime is removed only
once the daemon reports that flush `complete`; an empty queue alone is not proof, and a daemon that
does not report completeness (sealantd up to the pinned 0.18.2) is never taken as saved, so its
workspace is kept (`not saved · not confirmed · kept`). A queue still moving defers the stop to the
reaper's next tick. A daemon that answers but whose queue does not move for
`WORKSPACE_CAPTURE_DRAIN_STALL_WINDOW_MS` keeps its workspace running (`not saved · kept`). A daemon
silent for `WORKSPACE_CAPTURE_DRAIN_UNREACHABLE_WINDOW_MS` keeps its workspace too
(`not saved · daemon silent · kept`) while the runtime reports the executor running; a runtime that
reports the executor gone lets the stop proceed, and one that exited after a final flush it never
confirmed is left in place (its disk holds the staged captures). The FINAL flush asks the daemon to
answer within `WORKSPACE_CAPTURE_DRAIN_FINAL_DEADLINE_MS`, never more than the round trip's bound
(`WORKSPACE_CAPTURE_DRAIN_REQUEST_TIMEOUT_MS`) less a margin, and gives managed processes
`WORKSPACE_CAPTURE_DRAIN_FINAL_GRACE_MS` between SIGTERM and SIGKILL. A FINAL past its deadline
answers incomplete and keeps shipping in the daemon, so the polls that follow and the next sweep's
flush converge on one upload. A run whose source cannot be read is treated as capture-sourced. The
exit reconciler asks the daemon before it records an exit: a runtime whose daemon still answers is
drained first. A MicroVM whose guest Docker failed while sealantd is up is reported, never
terminated.

Drain ownership and progress live in `workspace_capture_drains`: one worker drains a workspace at a
time across every worker process (`WORKSPACE_CAPTURE_DRAIN_LEASE_MS`), and the last observation is
what `GET /v1/workspaces/:id` reports as `captureDrain`. A capture-sourced launch that fails after
its executor became ready keeps the executor (`launch-retained`) and is drained before it is
stopped. A runtime with its own deadline (a MicroVM's maximum duration) gets its final drain and a
planned stop `WORKSPACE_CAPTURE_DEADLINE_LEAD_MS` (plus an upload estimate) before the deadline. A
stop records that it is under way before it asks the runtime to go, so the exit reconciler records
the resulting exit as the planned stop, not a failure; a stop that fails after its drain is recorded
`stop-failed` on the drain and retried by the reaper. An owner's `stop({ discardUnsaved: true })` is
recorded (who, when) and every stop path honours it: the runtime is terminated without a drain and
the drain reads `discarded`.

Docker workspace containers carry their own stop timeout (`--stop-timeout`:
`SEALANT_DOCKER_STOP_GRACE_SECONDS`, or `SEALANT_DOCKER_CAPTURE_STOP_GRACE_SECONDS` for a capture
workspace), so any `docker stop` waits for sealantd's final flush; raise the Docker daemon's
`shutdown-timeout` on hosts that run capture workspaces, or a daemon shutdown still cuts it off.

Runtime launch defaults to Docker via `DEFAULT_RUNTIME_ADAPTER=docker` when the normalized workspace
spec leaves `target.runtime.family` as `auto`.

Per-workspace Docker runtime selection now comes from `spec.runtime.ociRuntime`. Requests default to
`runc`; `runsc` launches require the worker host Docker daemon to have `runsc` registered.

Workspace startup and SSH behavior are spec-authoritative. SSH-enabled workspaces need no key
material from the worker: the gateway reaches them over the sealantd control socket
(`WORKSPACE_CONTROL_SOCKET_HOST_DIR`), and client keys are authorized against the control plane's
`ssh_keys` table. Remaining worker defaults:

- `DEFAULT_SSH_BIND_HOST=127.0.0.1`
- `DEFAULT_SSH_ENDPOINT_EXPOSURE_STRATEGY=host-published` (`container-network` is gateway-ready)
