# Worker App

`@sealant/worker` is the first background worker for Sealant workspace image build jobs.

It currently provides:

- a Node worker entrypoint
- one worker-kind module per domain workload under `src/workers/`
- RabbitMQ transport via `@sealant/rabbitmq`
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

- the PostgreSQL database from `@sealant/db`
- RabbitMQ from the root `compose.yaml` (`rabbitmq` service)
- Zot from the root `compose.yaml` (`zot` service)
- access to the host Docker socket for BuildKit image builds and Docker runtime launches

By default the worker uses `amqp://sealant:sealant@127.0.0.1:5673` so it does not collide with an
existing local RabbitMQ instance on `5672`.

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
