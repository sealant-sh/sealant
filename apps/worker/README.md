# Worker App

`@sealant/worker` is the first background worker for Sealant workspace image build jobs.

It currently provides:

- a Node worker entrypoint
- RabbitMQ consumption via `@sealant/workspace-build-queue`
- durable job state updates through `@sealant/db`
- Nix compilation through `@sealant/os-integration-nix`
- image publishing through `@sealant/registry-integration`
- runtime launch selection through `@sealant/runtime-adapters-api`

## Development

Run the worker locally:

```bash
pnpm --filter @sealant/worker dev
```

Run the worker in Docker Compose:

```bash
docker compose --profile apps up -d worker
```

This also starts `nix-builder`, which the worker uses for Nix compilation via the Docker API.

Deep dive for the Docker-based Nix command runner:

- `apps/worker/NIX_BUILDER_COMMAND_RUNNER.md`

The worker expects:

- the SQLite database from `@sealant/db`
- RabbitMQ from the root `compose.yaml` (`rabbitmq` service)
- Zot from the root `compose.yaml` (`zot` service)
- Nix builder from the root `compose.yaml` (`nix-builder` service)

By default the worker uses `amqp://sealant:sealant@127.0.0.1:5673` so it does not collide with an
existing local RabbitMQ instance on `5672`.

Runtime launch defaults to Docker via `DEFAULT_RUNTIME_ADAPTER=docker` when the normalized workspace
spec leaves `target.runtime.family` as `auto`.

The worker now applies runtime defaults when requests omit startup/SSH fields:

- `DEFAULT_WORKSPACE_STARTUP_MODE=idle` (or `harness`)
- `DEFAULT_WORKSPACE_IDLE_COMMAND="while :; do sleep 30; done"`
- `DEFAULT_WORKSPACE_SSH_ENABLED=true`
- `DEFAULT_WORKSPACE_SSH_LISTEN_PORT=2222`
- `DEFAULT_SSH_AUTHORIZED_KEYS_FILE=/workspace/.secrets/authorized_keys`
- `DEFAULT_SSH_BIND_HOST=127.0.0.1`

For local Docker Compose usage, create `./.secrets/authorized_keys` in the repo with one or more
public keys. When SSH is enabled the Docker runtime adapter injects that key material into the
sandbox and publishes SSH on an available host port.
