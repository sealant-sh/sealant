# Jobs

`@sealant/jobs` is the business-agnostic job-queue transport package. It wraps
[pg-boss](https://github.com/timgit/pg-boss), so the queue lives in the same Postgres database as
the control plane: no broker process, no extra port, no extra credentials.

It provides:

- one shared pg-boss handle per process (`getJobQueueSingleton`), installed into the `pgboss` schema
  of `DATABASE_URL` on first use
- a small queue definition type (`JobQueueDefinition`) that mirrors the old RabbitMQ topology: a
  durable queue plus a dead-letter queue, with no automatic retries
- generic JSON publish/consume helpers (`publishJobQueueJson`, `consumeJobQueueJson`)
- an Effect service (`JobQueueServiceTag`) plus `createJobQueueService` for imperative call sites

Workers wake on Postgres `LISTEN`/`NOTIFY`, with polling as the fallback, so enqueue-to-start
latency stays in the low milliseconds.
