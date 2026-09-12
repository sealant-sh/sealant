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

`WORKSPACE_BUILD_QUEUE_PREFETCH` (default `1`) sets how many deliveries one worker process handles
at once.

Image retention runs in the worker: every hour (`WORKSPACE_IMAGE_GC_INTERVAL_MS`, first pass 30 s
after boot) it deletes workspace images no live workspace launched from and no retained plan needs
(`WORKSPACE_IMAGE_RETAINED_PLANS`, default `3`), and removes build scratch older than six hours from
the OS temp directory. `WORKSPACE_IMAGE_GC_ENABLED=false` turns the sweep off.

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
