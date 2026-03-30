# Worker App

`@sealant/worker` is the first background worker for Sealant workspace image build jobs.

It currently provides:

- a Node worker entrypoint
- one worker-kind module per domain workload under `src/workers/`
- RabbitMQ transport via `@sealant/rabbitmq`
- sandbox lifecycle processing through `@sealant/sandboxes`
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

For local development, the Compose worker shares the same SQLite file as the host apps by mounting
`packages/db/.data` into the container. Run migrations on the host before starting the worker:

```bash
pnpm db:migrate
```

The worker expects:

- the SQLite database from `@sealant/db`
- RabbitMQ from the root `compose.yaml` (`rabbitmq` service)
- Zot from the root `compose.yaml` (`zot` service)
- access to the host Docker socket for BuildKit image builds and Docker runtime launches

By default the worker uses `amqp://sealant:sealant@127.0.0.1:5673` so it does not collide with an
existing local RabbitMQ instance on `5672`.

Runtime launch defaults to Docker via `DEFAULT_RUNTIME_ADAPTER=docker` when the normalized workspace
spec leaves `target.runtime.family` as `auto`.

Per-sandbox Docker runtime selection now comes from `spec.runtime.ociRuntime`. Requests default to
`runc`; `runsc` launches require the worker host Docker daemon to have `runsc` registered.

The worker now applies runtime defaults when requests omit startup/SSH fields:

- `DEFAULT_WORKSPACE_STARTUP_MODE=idle` (or `harness`)
- `DEFAULT_WORKSPACE_IDLE_COMMAND="while :; do sleep 30; done"`
- `DEFAULT_WORKSPACE_SSH_ENABLED=true`
- `DEFAULT_WORKSPACE_SSH_LISTEN_PORT=2222`
- `DEFAULT_SSH_AUTHORIZED_KEYS_FILE=/app/.secrets/authorized_keys`
- `DEFAULT_SSH_BIND_HOST=127.0.0.1`
- `DEFAULT_SSH_ENDPOINT_EXPOSURE_STRATEGY=host-published` (`container-network` is gateway-ready)

For local Docker Compose usage, create `./.secrets/authorized_keys` in the repo with one or more
public keys. When SSH is enabled the Docker runtime adapter injects that key material into the
sandbox and publishes SSH on an available host port.
