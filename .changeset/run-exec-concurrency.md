---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

The worker handles up to four run-exec deliveries (harness runs and workspace execs) at once
(`RUN_EXEC_QUEUE_CONCURRENCY`, default 4). They shared the build queue's single slot
(`WORKSPACE_BUILD_QUEUE_PREFETCH`, default 1), so one slow exec (a cold binary read, an executor
that is gone) held every other workspace's setup and harness start for minutes.
