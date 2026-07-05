# Packages

Shared libraries and reusable code live here.

The current package architecture is:

- `db`: shared PostgreSQL database package for control-plane state, Drizzle schema, migrations, and
  repositories
- `auth`: shared Better Auth package for product-facing apps, backed by the shared database package
- `validators`: shared validation and contract package for API request/response schemas and
  API-to-worker messaging payloads
- `rabbitmq`: business-agnostic RabbitMQ transport utilities
- `sandboxes`: sandbox domain package covering build, publish, deploy, queue wiring, and lifecycle
  mapping, including harness integrations and package resolution/standardization
- `source-integrations`: source-provider integration logic such as GitHub repository selection, ref
  resolution, and access-related flows
