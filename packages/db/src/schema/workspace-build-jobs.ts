import { runtimeAdapterIds, type NewWorkspace, type WorkspaceBuild } from "@sealant/validators";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Client-level `casing: "snake_case"` no longer exists, so re-apply snake_case at the
// table level to keep implicit column names mapping to snake_case db columns.
const pgTable = snakeCase.table;

import { workspaceAttempts } from "./control-plane.js";

export const ociImageBuildJobStatusValues = ["queued", "running", "succeeded", "failed"] as const;

export type OciImageBuildJobStatus = (typeof ociImageBuildJobStatusValues)[number];

export const workspaceRuntimeInstanceStatusValues = [
  "pending",
  // "running": legacy — the container is up but its control socket may not be accepting yet. Retained
  // for rows written before the readiness probe landed; the launch path no longer emits it.
  "running",
  // "ready": the control socket is accepting (readiness probe passed). This is the honest "reachable"
  // signal the SDK gates on — see resolveWorkspaceStatus + DockerRuntimeAdapter.launch.
  "ready",
  "failed",
  "stopped",
] as const;

export type WorkspaceRuntimeInstanceStatus = (typeof workspaceRuntimeInstanceStatusValues)[number];

// Why a runtime instance was stopped: an explicit user/API stop, TTL expiry (reaper), or a stop
// taken as part of a failure path. Workspaces are ephemeral, so "stopped" is terminal.
export const workspaceRuntimeInstanceStopReasonValues = ["user", "expired", "failed"] as const;

export type WorkspaceRuntimeInstanceStopReason =
  (typeof workspaceRuntimeInstanceStopReasonValues)[number];

export const ociImageBuildJobs = pgTable(
  "oci_image_build_jobs",
  {
    id: text().primaryKey(),
    runId: text("run_id").references(() => workspaceAttempts.id, { onDelete: "set null" }),
    status: text({ enum: ociImageBuildJobStatusValues }).notNull().default("queued"),
    registryId: text().notNull(),
    repository: text().notNull(),
    tag: text().notNull(),
    requestPayload: jsonb("request_payload").$type<NewWorkspace>().notNull(),
    // The transient secret channel: `secretEnv` sealed with the credential cipher at create,
    // decrypted by the worker just before launch, and CLEARED once the launch phase settles —
    // success or failure — so a settled row never carries it. Null on restart re-enqueues:
    // restarted workspaces run without secret env by design.
    secretEnvSealed: text("secret_env_sealed"),
    idempotencyKey: text(),
    attemptCount: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(3),
    availableAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    claimedAt: timestamp({ mode: "date", withTimezone: true }),
    leaseExpiresAt: timestamp({ mode: "date", withTimezone: true }),
    workerId: text(),
    startedAt: timestamp({ mode: "date", withTimezone: true }),
    finishedAt: timestamp({ mode: "date", withTimezone: true }),
    builderId: text(),
    resultPayload: jsonb("result_payload").$type<WorkspaceBuild>(),
    publishedReference: text(),
    publishedDigestReference: text(),
    publishedDigest: text(),
    errorCode: text(),
    errorMessage: text(),
    createdAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("oci_image_build_jobs_status_available_at_idx").on(table.status, table.availableAt),
    index("oci_image_build_jobs_status_claimed_at_idx").on(table.status, table.claimedAt),
    index("oci_image_build_jobs_created_at_idx").on(table.createdAt),
    index("oci_image_build_jobs_run_id_idx").on(table.runId),
    uniqueIndex("oci_image_build_jobs_idempotency_key_idx").on(table.idempotencyKey),
  ],
);

/**
 * How one connected-account credential was ACTUALLY injected at this instance's launch. Recorded
 * so post-run sync-backs can trust launch-time truth instead of the account row's CURRENT payload
 * shape (which a reconnect may have switched while the workspace was alive) — e.g. a claude
 * account reconnected token→session-file mid-run must NOT have this env-injected workspace's
 * harness-written credentials file synced back over the fresh paste.
 */
export interface WorkspaceLaunchCredentialInjection {
  readonly provider: string;
  readonly connectedAccountId: string;
  readonly injection: "env" | "file";
}

export const workspaceRuntimeInstances = pgTable(
  "workspace_runtime_instances",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => workspaceAttempts.id, { onDelete: "cascade" }),
    status: text({ enum: workspaceRuntimeInstanceStatusValues }).notNull().default("pending"),
    adapter: text({ enum: runtimeAdapterIds }),
    resourceId: text("resource_id"),
    // Null on rows written before this column existed (or before launch succeeded): sync-backs
    // treat null as "no credential was file-injected here".
    launchCredentialInjections: jsonb("launch_credential_injections").$type<
      readonly WorkspaceLaunchCredentialInjection[]
    >(),
    reference: text(),
    endpoint: text(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    stopReason: text("stop_reason", { enum: workspaceRuntimeInstanceStopReasonValues }),
    launchedAt: timestamp("launched_at", { mode: "date", withTimezone: true }),
    finishedAt: timestamp("finished_at", { mode: "date", withTimezone: true }),
    /**
     * The instant the runtime itself ends the executor, whatever anyone asks (a Lambda MicroVM's
     * maximum duration, counted from its start). Null where the runtime imposes no lifetime, and
     * on rows launched before this column existed. A caller holding unsaved work on the executor
     * plans its drain before this.
     */
    runtimeDeadlineAt: timestamp("runtime_deadline_at", { mode: "date", withTimezone: true }),
    /**
     * The workspace source the launch booted from (`sources.workspace.kind` of the blueprint:
     * `capture`, `git`, `empty`, …), written with the first row of the launch. A capture-sourced
     * runtime holds work nowhere else until its queue is saved, so every stop drains it first.
     * Null on rows written before this column existed; stop paths then read the attempt snapshot,
     * and treat a run whose source cannot be read as capture-sourced (fail closed).
     */
    sourceKind: text("source_kind"),
    /**
     * Launch ownership while the row is `pending`: the worker launching the executor and the
     * instant its ownership lapses unless renewed. The launching worker renews it while it waits
     * for readiness and clears it with the row's terminal launch write (`ready` or `failed`). A
     * `pending` row that names an executor (`resource_id`) and whose ownership lapsed was left by
     * a worker that died or was interrupted after the executor started: the stranded-launch
     * sweep adopts it as a retained launch, so it is drained, preserved before its deadline and
     * stopped like any other. Null on rows written before these columns existed.
     */
    launchOwner: text("launch_owner"),
    launchLeaseExpiresAt: timestamp("launch_lease_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("workspace_runtime_instances_status_updated_at_idx").on(table.status, table.updatedAt),
    index("workspace_runtime_instances_adapter_status_idx").on(table.adapter, table.status),
  ],
);

/**
 * What the last drain observation concluded about a capture-sourced runtime (`capture-drain.ts`):
 *
 *  - `draining`: the queue is still moving; the stop continues on a later sweep.
 *  - `kept`: nothing may stop the runtime — the queue stalled, a class was refused, the daemon is
 *    silent while the executor runs, or the final flush did not report `complete`.
 *  - `saved`: the daemon reported the final flush complete; the stop proceeds.
 *  - `gone`: the daemon is silent and the runtime reports the executor ended; nothing to save.
 *  - `stop-failed`: the drain let the stop through, but removing the runtime (or recording it)
 *    failed; `detail` carries the error, and the next sweep retries the stop.
 *  - `stopped`: the runtime was removed after the drain let it go.
 *  - `discarded`: the owner discarded the unsaved captures; the runtime was terminated without a
 *    drain (`discardRequestedAt` / `discardRequestedBy` record who asked, and when).
 */
export const workspaceCaptureDrainStateValues = [
  "draining",
  "kept",
  "saved",
  "gone",
  "stop-failed",
  "stopped",
  "discarded",
] as const;

export type WorkspaceCaptureDrainState = (typeof workspaceCaptureDrainStateValues)[number];

/**
 * One row per run whose capture queue a worker drained or is draining, or whose runtime deadline
 * scheduled a preservation. It is the durable half of `capture-drain.ts`:
 *
 *  - **Ownership**: `leaseOwner` / `leaseExpiresAt`. One worker at a time drains a run, across
 *    every worker process; a lease that expires (its worker died) is taken over.
 *  - **Progress**: the stall and silence windows are measured from `lastProgressAt` and
 *    `unreachableSince`, so a drain spanning many sweeps, or moving between workers, keeps its
 *    clock.
 *  - **Observation**: `state`, `detail`, `lastStatus`, `observedAt` — what the API reports while
 *    a stop is in progress (a stop request is not a stop).
 *  - **Schedule**: `preservationStartsAt`, the instant the deadline sweep starts the final drain
 *    of a runtime with a platform lifetime, and the throughput it was estimated from.
 */
export const workspaceCaptureDrains = pgTable(
  "workspace_capture_drains",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => workspaceAttempts.id, { onDelete: "cascade" }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { mode: "date", withTimezone: true }),
    state: text({ enum: workspaceCaptureDrainStateValues }),
    detail: text(),
    /** The daemon's last capture status, as the worker read it (JSON-safe numbers). */
    lastStatus: jsonb("last_status").$type<Readonly<Record<string, unknown>>>(),
    lastProgressAt: timestamp("last_progress_at", { mode: "date", withTimezone: true }),
    unreachableSince: timestamp("unreachable_since", { mode: "date", withTimezone: true }),
    keptLogged: boolean("kept_logged").notNull().default(false),
    silentLogged: boolean("silent_logged").notNull().default(false),
    observedAt: timestamp("observed_at", { mode: "date", withTimezone: true }),
    preservationStartsAt: timestamp("preservation_starts_at", {
      mode: "date",
      withTimezone: true,
    }),
    /** Upload throughput observed on the executor (bytes per second), for the lead estimate. */
    uploadBytesPerSecond: doublePrecision("upload_bytes_per_second"),
    /** The `uploadedBytes` sample and its instant that the next throughput reading diffs from. */
    uploadSampleBytes: doublePrecision("upload_sample_bytes"),
    uploadSampledAt: timestamp("upload_sampled_at", { mode: "date", withTimezone: true }),
    /**
     * The audit of a discard: when the owner asked to end this runtime without saving its
     * unsaved captures, and who asked. Set once, never cleared; every stop path honours it.
     */
    discardRequestedAt: timestamp("discard_requested_at", { mode: "date", withTimezone: true }),
    discardRequestedBy: text("discard_requested_by"),
    /**
     * The control plane's attestation, on a stop request, that its store holds a sealed FINAL of
     * this run's executor: the executor it names (the run id, or the runtime's resource id or
     * reference), the lease epoch and the sealed capture's chain position, when and by whom.
     * Permission to delete the executor once it has ended (the preservation policy checks the
     * id and the epoch); the latest attestation stands.
     */
    completionExecutorId: text("completion_executor_id"),
    completionEpoch: bigint("completion_epoch", { mode: "number" }),
    completionCaptureN: bigint("completion_capture_n", { mode: "number" }),
    completionAttestedAt: timestamp("completion_attested_at", { mode: "date", withTimezone: true }),
    completionAttestedBy: text("completion_attested_by"),
    /**
     * The executor is RETAINED: kept because its disk holds work not confirmed saved (it ended
     * without a complete final flush, or its launch failed after it started). Set once (the
     * first instant stands) with why; cleared when the executor is finally removed (`stopped`,
     * `discarded`) or found gone. Recovery retries on a backoff: `nextRecoveryAt`, how many
     * attempts, and the last attempt's error.
     */
    retainedAt: timestamp("retained_at", { mode: "date", withTimezone: true }),
    retainedReason: text("retained_reason"),
    recoveryAttempts: integer("recovery_attempts").notNull().default(0),
    nextRecoveryAt: timestamp("next_recovery_at", { mode: "date", withTimezone: true }),
    lastRecoveryError: text("last_recovery_error"),
    /**
     * The capture token the executor was launched with (`SEALANT_CAPTURE_TOKEN`, the one Mend
     * issued for the session), sealed with the credential cipher. The daemon reads it once at
     * boot from its secret env file, which is removed once the executor is ready; recovering a
     * retained executor restarts that boot, so the token is staged again from here. Cleared when
     * the executor is finally removed or found gone.
     */
    captureTokenSealed: text("capture_token_sealed"),
    createdAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("workspace_capture_drains_state_idx").on(table.state),
    index("workspace_capture_drains_retained_idx").on(table.retainedAt, table.nextRecoveryAt),
  ],
);

export type WorkspaceCaptureDrain = typeof workspaceCaptureDrains.$inferSelect;
export type NewWorkspaceCaptureDrain = typeof workspaceCaptureDrains.$inferInsert;

export type OciImageBuildJob = typeof ociImageBuildJobs.$inferSelect;
export type NewOciImageBuildJob = typeof ociImageBuildJobs.$inferInsert;

export type WorkspaceRuntimeInstance = typeof workspaceRuntimeInstances.$inferSelect;
export type NewWorkspaceRuntimeInstance = typeof workspaceRuntimeInstances.$inferInsert;

// Compatibility exports while the rest of the codebase migrates away from
// workspace_build_jobs naming.
export const workspaceBuildJobStatusValues = ociImageBuildJobStatusValues;

export type WorkspaceBuildJobStatus = OciImageBuildJobStatus;

export type WorkspaceBuildJob = OciImageBuildJob;
export type NewWorkspaceBuildJob = NewOciImageBuildJob;
