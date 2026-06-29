# Sealant Async Strategy — Final Architecture Decision

*Lead architect synthesis. Audience: the founder/engineer who implements this. Decisive, concrete, sequenced.*

---

## 1. Executive summary

**The user-visible incident is not a queue problem, and we must stop conflating the two.** The intermittent `harness.run()` "connection closed" flake is a readiness TOCTOU (finding #1, HIGH): the control plane reports `status="running"` the instant Docker says `State.Running=true` (`docker-runtime-adapter.ts:552`), with no probe of sealantd's `control.sock`. No queue choice touches this. **Fix it first, this week, queue-independent**, with a server-side health handshake that earns a distinct `ready` state — then shrink the `BRIDGE_RETRY` mask once telemetry confirms zero dead-window hits.

**The queue-layer bugs (findings #4 double-launch, #5 worker-death stranding) live in the seam between RabbitMQ redelivery and the Postgres lease — two stores that can disagree.** The decisive structural move is to **migrate to pg-boss on the Postgres we already run, deleting RabbitMQ**, which collapses that seam: a single `SELECT … FOR UPDATE SKIP LOCKED` arbiter makes "claim returns null for a live lease → ACK discards the broker's recovery → stranded forever" *unexpressible*, and folds the job insert into the same transaction as the sandbox row (killing the dual-write window). This is the right bet for an early-stage team optimizing reliability-without-heavy-ops: it adds zero infrastructure and *removes* a stateful system, unlike BullMQ (+Redis) or Temporal (+cluster).

**But we sequence pragmatically, not big-bang.** We graft the minimal-change proposal's app-side correctness work — deterministic container names, find-or-create/adopt, an epoch fencing token, and a stop-the-bleeding fix for #5 — *first*, because those are owed under any queue and they stop permanent stranding in days, not weeks. The pg-boss migration then deletes the hand-rolled lease/reaper rather than us building it to keep. **The push layer (SSE over Postgres LISTEN/NOTIFY, backed by a durable outbox) is phased in behind an async-iterable SDK surface we ship poll-backed now** — so poll→push is an internal swap with no change to the frozen `types.ts` contract.

Net: honest readiness this week; both HIGH findings closed structurally; one datastore; a stable SDK contract; and a credible, reversible path the team can execute slice-by-slice.

---

## 2. Queue decision

**Recommendation: migrate to pg-boss (Postgres-native), remove RabbitMQ — but only after the in-place correctness fixes land. Runner-up: graphile-worker.**

The reasoning is structural, not feature-count. The codebase is *already* a Postgres job system — `oci_image_build_jobs` carries `idempotencyKey` (unique index), `attemptCount`, `maxAttempts`, `availableAt`, `claimedAt`, `leaseExpiresAt`, plus a `status+claimed_at` index, and the lease-recovery primitives `claimNextQueuedJob`/`markJobRunning` already encode the exact `running AND lease-expired` WHERE clause. RabbitMQ is bolted on as a *wakeup transport only*; all job semantics live in the DB. **Findings #4 and #5 live precisely in the disagreement between broker redelivery and DB lease.** pg-boss collapses both stores into one transactional arbiter and deletes that disagreement by construction.

Why not the alternatives:

- **RabbitMQ keep-and-fix** is the lowest-migration path and its fixes are all app-side, but it *preserves the two-system seam* where the bugs live, needs a community plugin or TTL+DLX ladder to get any retry/backoff (today a failed build nacks `requeue=false` straight to DLQ with zero retries), and collides with `consumer_timeout` (~30 min default) on long builds — manufacturing the very redelivery that triggers double-launch. We keep it *temporarily* (it does no harm on the happy path and its automatic requeue-on-consumer-death is a correct primitive we're currently discarding), then retire it.
- **BullMQ** has the cleanest off-the-shelf stalled-job recovery, but buys it by adding **Redis as durable state** with sharp edges (`maxmemory-policy=noeviction`, AOF, replicas) — new infra for a low-throughput workload Postgres already serves. Wrong trade for this stage.
- **Temporal** is the textbook home for durable workflows but adds a cluster + persistence DB (often + Elasticsearch) and its deterministic-replay sandbox **fights the audited-sound Effect core** (arbitrary Effect programs are not replay-safe). Too heavy, wrong fit.
- **graphile-worker** shares pg-boss's entire thesis (Postgres-native, delete RabbitMQ, transactional `add_job`, SKIP LOCKED single-arbiter) and is a fine choice. It loses on the one axis that matters most here: crash recovery granularity. Its default ~4h stale-lock reclaim is far coarser than finding #5's ~10-min `ready()` timeout, and it doesn't cleanly expose that interval — you'd hand-roll a cron reaper, re-introducing the bespoke recovery the migration exists to delete. pg-boss's `expireInSeconds` is a true per-job visibility timeout you set to today's lease budget, plus a native `deadLetter` queue.

| Criterion (weighted for Sealant: early, low-ops) | **pg-boss (REC)** | graphile-worker (runner-up) | RabbitMQ keep+fix | BullMQ | Temporal |
|---|---|---|---|---|---|
| New infra / ops burden | **None — reuses PG, removes RabbitMQ** | None — reuses PG, removes RabbitMQ | Keeps clustered broker + PG | +Redis (noeviction+AOF+replicas) | +Cluster +persistence DB (+ES) |
| Datastores in job lifecycle | **One (PG)** | One (PG) | Two (broker + PG) | Two (Redis + PG) | Two+ |
| Fixes #5 worker-death stranding (HIGH) | **By construction (SKIP LOCKED + expireInSeconds)** | Structural, but recovery blunt (~4h) | App-side only; broker requeues but null→ack discards it | Lock-renewal + stalled checker | Heartbeat timeout / replay |
| Crash-recovery budget tunable to ~minutes | **Yes (`expireInSeconds`)** | No (4h default; needs custom reaper) | DB lease unwired; hung worker waits ~30min `consumer_timeout` | Yes (`lockDuration`); mistune→false reruns | Yes (`heartbeatTimeout`) |
| Kills the redelivery↔lease seam (#4/#5 root) | **Yes — one store** | Yes — one store | No — seam retained | Partial — Redis vs PG split | Yes |
| Native retry/backoff | **Yes** | Yes | No (plugin/TTL+DLX) | Yes | Yes |
| Native delayed/scheduled (`availableAt`, expire) | **Yes** | Yes | No (plugin) | Yes | Yes |
| Transactional enqueue (kills dual-write window) | **Yes (custom executor)** | Yes | No | No | Via workflow |
| Push to SDK clients | Via PG LISTEN/NOTIFY (shared substrate) | Same | AMQP is server-only — invisible at SDK edge | Redis streams (server-only) | Server-only |
| Migration effort | M–L | M–L | S (but bugs remain) | M | XL |
| Collides with Effect investment | No | No | No | No | **Yes** |

**Decision:** pg-boss is the target. Sequence it *after* the queue-agnostic correctness work (Section 7) so the bleeding stops first and the migration deletes hand-rolled code rather than competing with it.

---

## 3. The readiness fix (PRIMARY — finding #1/#2/#3)

This is the headline incident and it ships **first, this week, with zero queue dependency.** Make status *honest* by earning a distinct `ready` state with a real handshake — do not tune the mask.

**Server-side (the fix):**

1. **Stop returning `status:"running"` on `State.Running` alone.** Today `assertContainerRunning` (`docker-runtime-adapter.ts:436-447`) only proves Docker thinks the process is up — the false positive. `launch()` returns `status:"starting"` with the `containerId`; the runtime row stays `pending`/`starting` through the whole launch + `rm -rf` + `git clone` + runtime-health window.
2. **Run a two-stage readiness probe in Phase B** (`process-sandbox-build-job.ts`, where the docker handle and the variable, dominant clone cost live):
   - **Stage A — socket exists:** `docker exec <cid> test -S /run/sealant/control.sock`, the exact pattern already proven at `sealantd/boot.ts:116-125`, in a bounded retry loop (~100 ms spacing).
   - **Stage B — daemon accepts:** escalate to a real `connected.health` RPC over the control bridge — the *same call the SDK already makes* at `run-harness.ts:90`. The socket file can exist before sealantd `accept()`s; only the health RPC proves the daemon is past `rm -rf` + clone + runtime-health. **Readiness = health returns a runtimeId.**
   - **Bind-mount fast path** (`controlSocketHostDir` set, `:270-277`): probe the host path with `fs.stat` + `S_ISSOCK` instead of `docker exec`.
   - **Budget:** default ~120 s, env-configurable, must exceed worst-case clone+build (the ~685 ms mean is at ~0 load; real/large repos are multi-second, amplified under the documented 50+ container load). On budget expiry, write `status:"failed"` with captured container logs — an **honest bounded failure**, not a masked one that re-surfaces as `connection closed` in `run()`.
3. **Only after the handshake** does the worker upsert the runtime row to `ready`. Add `starting` and `ready` to the runtime status enum (DB column + `api-contracts` `sandboxRuntimeSchema.status`) so "process up" and "socket accepting" are separately nameable.

**SDK side (`facade/sandbox.ts:82`):** change the `ready()` gate from `runtime.status === "running" && resourceId !== undefined` to `details.status === "ready"`. Because the API only emits `ready` after the handshake, the gate is now honest and the TOCTOU is closed *at the source*.

**The mask:** keep `BRIDGE_RETRY` (`run-harness.ts:39`, ~4 s) as belt-and-suspenders during rollout; shrink it to a thin transient-only backstop once telemetry confirms zero dead-window hits. **It stops being the sole, time-based, clone-unaware guard** that loses on slow/large clones.

**Bonus:** the telemetry worker (`telemetry.ts`) — which today polls "running" docker rows and silently retries against a not-yet-bound socket — keys off `ready` and stops thrashing.

---

## 4. SDK async design

**Principle: design the async-iterable surface now (poll-backed), swap the transport to push later — invisibly.** The public surface in `packages/sdk/src/types.ts` stays **frozen**; we light up stubs, we do not change signatures.

### Concrete API

- **`create({ wait, onEvent })`** — inserts the job + first event in one txn, returns a `Sandbox` handle immediately. With `wait!==false` (default) awaits `ready()`. `onEvent` is fed every lifecycle `SandboxEvent` from the same stream that backs `events()`. Replaces the 2000 ms poll loop.
- **`ready()`** — resolves on the earned `ready` signal; rejects on a terminal `failed`/`cancelled`; honors `READY_TIMEOUT_MS` as a deadline that aborts the subscription. **Idempotent for an already-ready sandbox** because the initial replay yields the persisted `ready` event/row (resume guarantee, not luck).
- **`run(prompt, options)`** — stays blocking; drains telemetry locally (host-local slice, per memory). **Wire the dropped options:** `runHarness` is `(ctx, init, prompt)` and silently discards `options` (`run-harness.ts:204`), so `signal`/`timeoutMs`/`idempotencyKey` are ignored today. Thread `RunOptions.signal` into `runHarnessEffect` — race `produce` against an interrupt fired by the AbortSignal.
- **`harness.start()` + `run.wait()`** — non-blocking start returns a `Run` handle; `wait()` awaits the terminal run event over the stream rather than blocking the exec.
- **`sandbox.events()`** (stub at `sandbox.ts:102-106`) and **`record.stream()/timeline()/scrollback()`** (stubs at `types.ts:268-273`) — return AsyncIterables. **Wire them poll-backed first**, with no new endpoints: `events()` polls `getSandbox`, diffs `sandbox.status`/`runtime.status` against last-seen, yields `SandboxEvent{type,occurredAt,message}`; `stream()`/`timeline()` page the **existing** `getRunTimeline` endpoint by `sequence`, tailing on an interval until `getRun` reports terminal; `scrollback()` via `getRunScrollback`.

### Cancel / timeout — make them *real*, not cosmetic

The trap (flagged by the push proposal's judge): flipping the run row to `cancelled` does **not** kill the in-container harness process — it keeps executing and writing telemetry while the SDK claims cancelled. **Cancel must be effectful:** on `signal` abort, send `terminate`/SIGTERM to the live session's `processId` over the bridge, *then* `updateRunOp(status:"cancelled")`. `timeoutMs` → `Effect.timeout` routed through the *same* cancel path. `idempotencyKey` already exists in `RunOptions` and the `createRun` header — thread it through `createRunOp` (which currently takes no idempotency header, unlike `createSandboxOp`).

### Push transport (phased fast-follow, not blocking)

Swap the poll-backed iterables to **SSE over Postgres LISTEN/NOTIFY**, backed by a **durable outbox** — chosen because Postgres is already the control plane and on the read path (webhooks need public ingress + retry infra; AMQP is server-only and SDK clients can't speak it):

- **Two SSE endpoints:** `GET /v1/sandboxes/:id/events` and `GET /v1/runs/:id/record/stream` (`text/event-stream`). Each handler **replays durable rows where `sequence > cursor`, then LISTENs** and streams new rows. Resume via `Last-Event-ID` / `?from=<sequence>`; SSE event id = the monotonic per-entity `sequence`.
- **NOTIFY is a doorbell, never a delivery channel.** It carries only `(entity_id, high-water sequence)`; payloads live in durable outbox rows. A missed NOTIFY or a reconnect loses nothing because resume reads by cursor. This sidesteps NOTIFY's at-most-once, ~8 KB-cap nature.
- **Sequence caveat to engineer around (the push proposal's biggest correctness risk):** Postgres `BIGSERIAL`/sequences can *commit out of allocation order*, so a naive `WHERE sequence > cursor` tail can skip a lower-but-later-committed row. **Mitigation:** allocate the per-entity sequence with a counter advanced under the per-entity row lock inside the transition txn (monotonic on commit order), or tail with a small visibility lag / `txid_snapshot` low-watermark. Do not ship the naive version.
- **Connection fan-out:** each subscriber holds a LISTEN; use **one shared LISTEN connection that multiplexes channels and re-fans-out in-process**, not one PG connection per subscriber. Note: PgBouncer in transaction-pooling mode breaks LISTEN/NOTIFY — keep the listener on a direct connection.

Because the iterable surface is designed first, this swap is internal: `events()`/`stream()` keep their signatures; `types.ts` never changes.

---

## 5. Idempotency & fencing (finding #4)

At-least-once delivery + content-idempotent build + find-or-create launch + DB fencing = **exactly-once observable effect.**

1. **Deterministic container name keyed on `runId` only** — replace `buildContainerName`'s `Date.now().toString(36)` suffix (`docker-runtime-adapter.ts:185`) with `sealant-<runId>` (sanitized). **Deliberately do NOT embed the epoch in the name** (this avoids the durable proposal's self-inflicted hazard, where an epoch-suffixed name lets a reaper-bumped generation launch a *second* container while the first still runs). One live container per `runId`; re-runs always collide and adopt.
2. **Idempotent launch / find-or-create / adopt** — before `docker run`, `docker inspect sealant-<runId>`: if running with the matching image, **adopt** (return its id, re-run only the readiness probe, skip the run); if exited, `docker rm` then run. The `inspect → run` gap is itself a TOCTOU, so **rely on Docker's atomic `--name` uniqueness as the real arbiter**: run, and on a name-conflict error, re-inspect and adopt. A redelivery or reaper-republish can never spawn a sibling.
3. **Fencing token = monotonic `epoch`** (reuse `attemptCount`, already atomically incremented on claim at `:335,:382`, or add an `epoch` column). Add `launch_epoch` to the runtime row; guard `upsertRuntimeInstance` (today last-writer-wins `onConflictDoUpdate` keyed only on `runId`) with `WHERE run_id = ? AND (launch_epoch IS NULL OR launch_epoch <= ?)`. **Last-writer-wins becomes highest-fence-wins** — a stale worker cannot repoint the row. Under pg-boss this is a same-txn predicate.
4. **Compare-and-set transitions** — every state transition is a CAS on `(run_id, expected_status, epoch)`; a zombie worker's UPDATE touches 0 rows and no-ops.
5. **Container GC** (closes the gap both robustness judges flagged; `autoRemove=false` at `:260` is confirmed): a sweep reaps `sealant-*` containers with no live runtime row, and stale-epoch orphans by name pattern.
6. **Enqueue idempotency stays where it's already strong** — the `idempotencyKey` unique index + the create txn (`sandboxes.module.ts:984-1011`), `messageId=jobId` at `publisher.ts:25`.

---

## 6. Failure recovery (finding #5, HIGH)

**Root cause restated:** `claimJobById` returns null when the job is `running` with a still-valid 15-min lease; RabbitMQ requeues unacked deliveries in *seconds* on consumer death; the redelivery arrives, can't claim (lease valid), returns null, and the worker **treats null as success and ACKs (`sandboxes.ts:51-61`), discarding the broker's correct crash recovery.** The job never completes and never fails — it strands forever and surfaces as a `ready()` *timeout*. There is no reaper: `claimNextQueuedJob`/`markJobRunning` have **zero callers** (grep-confirmed).

**Target (pg-boss) — by construction:** `expireInSeconds` IS the lease+reaper, set to the real worst-case clone+build+probe budget. A worker that OOM/SIGKILLs leaves its job active; pg-boss maintenance expires the lock and returns it to retry via atomic SKIP LOCKED move-to-active — *the single owner*. The `claimJobById`-null branch and the null→ACK are **deleted outright.** Retries: `retryLimit`/`retryDelay`/`retryBackoff` (exponential) replace today's `nack(false)`→straight-to-DLQ-with-zero-retries, finally honoring the schema's `maxAttempts`. DLQ: native `deadLetter` queue; exhaustion writes a `failed` event so the SDK stream surfaces it instead of a silent strand.

**Interim (RabbitMQ, ships before the migration to stop the bleeding):**
- **Stop the active harm:** on null-from-claim, do **not** ACK-as-success. Distinguish "claimed by a live competitor" (ack-drop is correct) from "lease holder is gone" (requeue-with-delay so the broker's recovery isn't discarded).
- **Lease heartbeat + shortened lease:** fork a renewal fiber scoped to the job, renew `leaseExpiresAt` every `lease/3` via a `touchLease` op guarded by `workerId`; lower lease from 15 min to ~2–3 min. A live-but-slow job keeps renewing (never falsely reaped); a dead worker stops, lease expires within the window.
- **One reaper, leader-elected:** a `setInterval` (~30 s) **guarded by a Postgres advisory lock** so N worker replicas don't all reap (closes the no-leader-election gap). Wire the dormant `claimNextQueuedJob`/`markJobRunning` — **add `FOR UPDATE SKIP LOCKED`** to `claimNextQueuedJob` (it currently does SELECT-then-UPDATE without it, a latent double-claim race). It republishes `running AND lease-expired` jobs with `attempt<max`; republishes `queued AND available_at<=now` jobs (closes the API dual-write window); marks `attempt>=max` as `failed` (DB DLQ).
- **Reaper safety depends on Section 5 landing first.** A reaper republish must be harmless, which requires deterministic-name find-or-create + fencing to already be deployed (otherwise a re-run double-launches). This couples the stages — order accordingly.
- **`x-consumer-timeout`** on the quorum queue set above worst-case build, so long builds don't get force-requeued (manufacturing double-launch). Note: redeclaring an existing durable quorum queue with a changed arg can hit `PRECONDITION_FAILED` and require queue recreation — plan it as an operational migration, not a one-line edit. (Moot once RabbitMQ is removed.)

**Orthogonal hardening** (already in the `run-harness.ts` working diff): `closeEpoch` hardcodes `suspicious:false` (`:127`) — when the drain ends *without* the harness `processExited` (a dropped bridge), close with `suspicious:true` / `closeReason:"connection-dropped"` so a truncated run isn't recorded as complete. Bracket the epoch open/close; surface layer-build `SqlError` through the error funnel.

---

## 7. Staged implementation plan

Ordered so the **HIGH** findings close first, with the one dependency-driven exception noted. Each stage is independently shippable, reversible (flag-flip / revert-by-slice), and keeps `types.ts` frozen.

| # | Stage | Goal | Concrete changes | Closes | Effort |
|---|---|---|---|---|---|
| **0** | **Honest readiness** *(this week, queue-untouched)* | Kill the user-visible `connection closed` flake at the source | Add `starting`/`ready` to runtime enum (DB + contract). `launch()` returns `starting` on `State.Running` only. Two-stage probe in Phase B: `test -S /run/sealant/control.sock` (`boot.ts` pattern) → `connected.health` RPC; bind-mount path via `fs.stat`+`S_ISSOCK`; ~120 s env-configurable budget → on expiry `failed`+logs. Upsert `ready` only post-handshake. SDK `ready()` gate (`sandbox.ts:82`) → `status==="ready"`. Keep `BRIDGE_RETRY` as backstop, shrink after telemetry. | **#1 (HIGH), #2 (MED), #3 (MED)** | **S** |
| **1** | **Idempotent launch + fencing** *(queue-agnostic; prerequisite for the safe #5 reaper)* | One container per `runId`, no row repoint, regardless of redelivery | Deterministic name `sealant-<runId>` (replace `Date.now()` at `:185`). Find-or-create/adopt via inspect + atomic `--name` conflict→adopt. Add `epoch`/`launch_epoch`; fence `upsertRuntimeInstance` with `launch_epoch<=?`. CAS transitions. Container GC sweep. Thread `runId` into launch input. Fold in `run-harness` hardening (`suspicious`, epoch bracketing, SqlError funnel). | **#4 (LOW)** + safety net for #5 | **M** |
| **2** | **Stop the stranding (interim, RabbitMQ)** | Worker death no longer strands forever; real retries | Stop null→ACK (distinguish live-competitor vs dead-holder). Lease heartbeat fiber + lower lease to ~2–3 min. One advisory-lock-guarded reaper wiring `claimNextQueuedJob` (+`FOR UPDATE SKIP LOCKED`) + `markJobForRetry` + terminal-fail at `maxAttempts`. Set `x-consumer-timeout`. | **#5 (HIGH)**, retry gap (#3-adjacent) | **M** |
| **3** | **SDK async surface (poll-backed)** *(SDK-only, no new endpoints)* | Light up the stubs; real cancel/timeout | Wire `events()`/`onEvent` (diff `getSandbox`), `record.stream()/timeline()/scrollback()` over existing `getRunTimeline`/`getRunScrollback`. Thread `signal`→effectful cancel (SIGTERM to `processId` + `updateRunOp`), `timeoutMs`, `idempotencyKey`. `harness.start()`/`run.wait()`. | DX (cancel/timeout/events), masking-removal | **M** |
| **4** | **pg-boss migration** *(structural seam-collapse)* | One transactional store; delete hand-rolled lease/reaper | Introduce pg-boss on existing Postgres; dual-enqueue behind a flag; cut worker consumption to pg-boss; fold job insert into the `createSandbox` txn (custom executor → kills dual-write window). `expireInSeconds`=budget, `retryLimit`/`retryBackoff`, `deadLetter`. **Delete** `@sealant/rabbitmq`, `topology.ts`, `consumer.ts` settle dance, `claimJobById`/`claimNextQueuedJob`/`markJobRunning`, and Stage 2's heartbeat/reaper. | **#5 + #4 by construction**, removes seam & RabbitMQ ops | **L** |
| **5** | **Push read-path** *(internal transport swap)* | Replace polling with SSE; durable, resumable, replayable | Append-only outbox tables with monotonic per-entity sequence (allocated under row lock — *not* naive BIGSERIAL tail). Emit each transition's event in-txn. NOTIFY doorbell (id+seq only). Two SSE endpoints (replay-from-cursor → LISTEN), `Last-Event-ID` resume, shared multiplexed LISTEN connection. Flip `events()`/`stream()`/`ready()` to SSE behind unchanged signatures. Replace telemetry's 5 s poll with LISTEN. | Push DX, removes poll load | **L** |
| **6** | **Lifecycle verbs + capacity** | Complete the surface; bound load | `stop`/`restart`/`expire` as transitions; `expire` via `availableAt`/cron; admission control / launch-concurrency cap to replace RabbitMQ `prefetch` (guards the 50+-container amplification); metrics/alerts on reaper health, lease-expiry rate, probe duration. Defer `harness.session()` (needs bidirectional WS). | Back-pressure, observability, Phase-3 verbs | **M–L** |

**Why this order:** Stage 0 stops the pages immediately and is queue-independent — ship it regardless of whether 4–6 ever land. Stage 1 is owed under any queue and is the **safety net that makes Stage 2's reaper non-destructive**, so it precedes the lower-severity-but-coupled work (the one deviation from strict severity order, by necessity). Stage 2 closes the second HIGH on the current stack in days. Stages 4–6 are the strategic payoff — but they *delete* code from 2, so we deliberately keep Stage 2's investment minimal.

---

## 8. Open questions / risks

1. **How much to invest in the interim (Stage 2) given pg-boss deletes it?** The call here is "minimal stop-the-bleeding, then migrate." If the team has bandwidth to jump straight to pg-boss, Stages 2 and 4 can merge — but #5 is bleeding now (jobs stranded forever), so the interim is justified unless the migration can land in the same sprint. **Decide explicitly; don't drift.**
2. **pg-boss transactional enqueue feasibility.** The dual-write-window kill depends on pg-boss truly enlisting in the caller's transaction via the custom executor. Validate this in a spike before committing Stage 4 — if it can't share the txn, that headline benefit is partial.
3. **Sequence ordering under concurrency (Stage 5).** Postgres sequences commit out of allocation order; a naive cursor-tail SSE can permanently skip rows. The lock-allocated-sequence mitigation must be designed and adversarially tested, or the "ordered, exactly-once-by-sequence" guarantee is false.
4. **Lost-wakeup on the terminal `ready` event.** Replay-then-LISTEN has a window where the critical `ready` row commits between replay and subscribe. Always replay-after-subscribe (or re-check the cursor post-LISTEN) so an already-ready sandbox resolves immediately — otherwise the eliminated flake returns as a `ready()` timeout.
5. **Connection budget (Stage 5).** Long-lived SSE + per-subscriber LISTEN + pg-boss workers all draw on one `max_connections`. The shared LISTEN multiplexer is real, unbuilt work and an in-process SPOF for the event substrate; PgBouncer transaction-pooling silently breaks LISTEN/NOTIFY — keep the listener on a direct connection.
6. **Readiness budget vs lease budget.** The ~120 s probe budget and the (interim) ~2–3 min lease are near-colliding. Keep renewal interval ≪ lease and probe budget < lease, and load-test the renewal-fiber-stall path (a heavy buildkit step blocking the event loop can stall renewal → false reap → harmless-but-noisy re-run via find-or-create).
7. **Back-pressure regression on RabbitMQ removal.** Deleting RabbitMQ removes `prefetch`, today's only flow control. Stage 6's launch-concurrency cap must land with or before Stage 4 to avoid worsening the exact 50+-container load that widened the original window.
8. **Container GC correctness.** `autoRemove=false` means orphans accumulate (adopt-replacements, crash-before-record, stale epochs). The GC sweep must never reap a container with a live runtime row — gate strictly on DB state, and test the race against a concurrent adopt.
9. **Phase-A (build/publish) retry idempotency.** Once retries actually fire (Stages 2/4), confirm build+registry push is content-idempotent (same repo+ref → same tag/digest) so a retry doesn't duplicate or corrupt published images.