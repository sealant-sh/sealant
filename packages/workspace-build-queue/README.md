# Workspace Build Queue

`@sealant/workspace-build-queue` is the RabbitMQ transport package for workspace image build jobs.

It currently provides:

- the durable queue topology for workspace image build requests
- a per-process RabbitMQ singleton for publish and consume channels
- a small typed message contract for queueing jobs by `jobId`
- publisher and consumer helpers built on top of `amqplib`
- a local RabbitMQ dev compose file under `dev/rabbitmq/`

## Environment

- `RABBITMQ_URL`: defaults to `amqp://sealant:sealant@127.0.0.1:5672`
- `WORKSPACE_BUILD_QUEUE_PREFETCH`: defaults to `1`

## Development

Start RabbitMQ locally:

```bash
docker compose -f packages/workspace-build-queue/dev/rabbitmq/compose.yaml up -d
```

The broker listens on `amqp://sealant:sealant@127.0.0.1:5672` and the management UI is available at `http://127.0.0.1:15672`.
