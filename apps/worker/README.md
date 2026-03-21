# Worker App

`@sealant/worker` is the first background worker for Sealant workspace image build jobs.

It currently provides:

- a Node worker entrypoint
- RabbitMQ consumption via `@sealant/workspace-build-queue`
- durable job state updates through `@sealant/db`
- Nix compilation through `@sealant/os-integration-nix`
- image publishing through `@sealant/registry-integration`

## Development

Run the worker locally:

```bash
pnpm --filter @sealant/worker dev
```

Run the worker in Docker Compose:

```bash
docker compose --profile apps up -d worker
```

The worker expects:

- the SQLite database from `@sealant/db`
- RabbitMQ from the root `compose.yaml` (`rabbitmq` service)
- Zot from the root `compose.yaml` (`zot` service)

By default the worker uses `amqp://sealant:sealant@127.0.0.1:5673` so it does not collide with an
existing local RabbitMQ instance on `5672`.
