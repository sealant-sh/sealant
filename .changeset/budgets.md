---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Per-credential and per-owner budgets. `BudgetExceededError` (HTTP 429, with `budget`, `limit` and
`retryAfterSeconds`) joins the errors of `createWorkspace`, `restartWorkspace`, `createRun` and
inference `respond`; the transport gate answers the same shape, with `Retry-After`, when one
credential exceeds its request rate (`Retry-After` is set there only; handler refusals carry
`retryAfterSeconds` in the body). A budget refuses new work and never stops running work. A ceiling
is checked before the work is created, so creates that race can overshoot it by the number in
flight.

- `SEALANT_BUDGET_PRINCIPAL_REQUESTS_PER_MINUTE` (12000: one service key is a whole product) and
  `SEALANT_BUDGET_OWNER_LAUNCHES_PER_MINUTE` (120), counted per API process.
- `SEALANT_BUDGET_OWNER_LIVE_WORKSPACES` (100) and `SEALANT_BUDGET_OWNER_ACTIVE_RUNS` (100), read
  from Postgres. A launcher that keeps standby workspaces warm per owner should size the first to
  its pool.
- `SEALANT_BUDGET_OWNER_INFERENCE_TOKENS_PER_DAY` (off). Usage is now recorded per owner per UTC day
  in a new `inference_usage` table (migration `20260917211231_inference_usage`: counts only).
- `SEALANT_BUDGET_RUN_OUTPUT_BYTES` (1 GiB) on the worker: past it, output chunks keep their event
  rows and lose their bytes, and the record carries one loss span where stored content ends.

`0` turns a budget off, and the API logs at start which are off.
