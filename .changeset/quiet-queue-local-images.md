---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Sealant no longer runs RabbitMQ or a zot registry on single-host installs. The job queue moved into
the control-plane Postgres database (pg-boss, `pgboss` schema; `RABBITMQ_URL` is gone), and
workspace images now stay in the Docker Engine that builds and runs them: the worker tags the built
image and launches by image id, with no push, pull, or tarball round-trip. Set `REGISTRY_BASE_URL` +
`REGISTRY_PUSH_REGISTRY` only to publish to an OCI registry (still required on Kubernetes, where the
chart keeps its in-cluster registry). `GET /v1/registries/default` reports
`pushRegistry: "docker-engine"` on installs without a registry. Existing self-host installs: re-run
the installer (or `docker compose up -d --remove-orphans`) and restart any workspace that was
mid-build during the upgrade.

The API's `/docs` page now loads the Scalar viewer from jsDelivr instead of embedding it, and the
server bundles are emitted as ASCII with comments stripped; together that trims roughly 20 MiB of
resident memory per Sealant API process and 10 MiB per worker and gateway.
