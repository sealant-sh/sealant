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
  /**
   * The file was a copy its holder cannot refresh (docs/connected-accounts-design.md §6a): there is
   * nothing newer to read back. Absent on rows launched before copies, whose files still rotate.
   */
  readonly copy?: boolean;
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
    /**
     * The build of sealantd the executor boots: the released sealantd image its workspace image
     * copied the daemon from (`COPY --from=<image> /usr/local/bin/sealantd`), recorded at launch.
     * Null when the launch could not tell (no image plan), and on rows written before it existed.
     */
    daemonImage: text("daemon_image"),
    /**
     * Whether that daemon has sealantd's recovery boot (resume its own staging, no restore, no
     * dotfiles, no lifecycle step, no harness, admission closed), as Core knew it at launch.
     * Recovery restarts a retained executor on its own disk ONLY when this is `true`: a daemon
     * without it would run its ordinary boot over the work the disk holds. Null = unknown, and
     * unknown is not recoverable in place (kept, reported).
     */
    daemonRecoveryBoot: boolean("daemon_recovery_boot"),
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

/** One request a removal sent to the runtime, with its own outcome (`deletion_requests`). */
export interface WorkspaceCaptureDeletionRequest {
  readonly id: string;
  /** Microseconds since the epoch, the database's clock. */
  readonly issuedAt: number;
  /**
   * `unknown` until known; `refused` / `done` as the runtime answered; `fenced` when the runtime's
   * bound on it passed with its outcome still unknown, so it can no longer act.
   */
  readonly outcome: "unknown" | "refused" | "done" | "fenced";
}

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
    /**
     * When the worker read `last_status` (the database's clock). An attestation is weighed
     * against it: an observation that the work is not saved, made after a seal, revokes that seal.
     */
    lastStatusAt: timestamp("last_status_at", { mode: "date", withTimezone: true }),
    /**
     * When `last_status` was recorded, by the database's own clock. With an observation fence's
     * `openedAt` (the same clock) it orders a status by causality where the executor's own
     * position cannot (`capture-evidence-order.ts`); never compared with any process's clock.
     */
    lastStatusRecordedAt: timestamp("last_status_recorded_at", {
      mode: "date",
      withTimezone: true,
    }),
    /**
     * Every answer on record that says the executor's work is not saved and that no answer
     * recorded since covers (review 9 #4, decision 25): an antichain of the executor's unsaved
     * positions, each with when it was recorded (the database's clock, microseconds since the
     * epoch). `last_status` is one latest answer; two answers no position orders are both kept
     * here, and nothing reads saved — no observed complete, no seal — until every one of them is
     * covered (`nextUnsavedObservations`).
     */
    unsavedStatuses: jsonb("unsaved_statuses")
      .$type<
        readonly {
          readonly status: Readonly<Record<string, unknown>>;
          readonly recordedAt: number | null;
        }[]
      >()
      .notNull()
      .default([]),
    /**
     * Bumped by every change to the evidence about this executor: a status recorded, an
     * observation opened or resolved, an attestation. A destructive decision records the version
     * it read and commits only while it is still current (`authorizeDeletion`, decision 18).
     */
    evidenceVersion: bigint("evidence_version", { mode: "number" }).notNull().default(0),
    /**
     * Observations in flight: a status or flush request sent to the executor whose answer is not
     * recorded yet, by token, with when it was opened and when it lapses (the database's clock).
     * While any is unresolved, nothing Core holds of the executor is known to be current, and no
     * deletion is authorized on it (review 6 #5). A failed record leaves its fence; a later
     * observation opened after it lapsed resolves it.
     */
    observationFences: jsonb("observation_fences")
      .$type<Readonly<Record<string, { readonly openedAt: string; readonly expiresAt: string }>>>()
      .notNull()
      .default({}),
    /**
     * The removal of this executor, as an owned durable transition (review 7 #5, decision 21).
     * `deleting`: a deleter authorized it on evidence version `deletionEvidenceVersion` (the
     * compare-and-set) and holds it under `deletionToken` until `deletionExpiresAt` (renewed while
     * it removes the runtime). While it is held, no observation of the executor is admitted and no
     * recovery starts it; a status recorded anyway voids it, and so does anything admitted once it
     * lapsed — the deleter re-checks right before the runtime call and decides again.
     * `deleting-issued`: the runtime was asked to remove the executor (review 8 #7). A request
     * already sent cannot be revoked, so this stays exclusionary whether or not its hold is live:
     * no observation is admitted, no recovery starts it and no status voids it. A live hold is its
     * issuer, still waiting on the runtime; a lapsed one is an outcome nobody knows until the
     * runtime is inspected (`reconcileIssuedDeletion`): gone ⇒ `deleted`; still there ⇒ issued
     * again on the evidence it was authorized on; still there with that evidence changed ⇒ kept
     * issued (the request may still act: review 9 #5) until the runtime's own bound on a removal
     * request has passed since `deletionIssuedAt`, then given up. A failed runtime call leaves
     * it issued unless the runtime definitively refused it.
     * `deleted`: the runtime was removed; nothing is observed or recovered again. Null: none.
     */
    deletionState: text("deletion_state", { enum: ["deleting", "deleting-issued", "deleted"] }),
    deletionToken: text("deletion_token"),
    deletionEvidenceVersion: bigint("deletion_evidence_version", { mode: "number" }),
    deletionAuthorizedAt: timestamp("deletion_authorized_at", { mode: "date", withTimezone: true }),
    deletionExpiresAt: timestamp("deletion_expires_at", { mode: "date", withTimezone: true }),
    /**
     * When the runtime was last asked to remove the executor (`issueDeletion`, the database's
     * clock; review 9 #5). An issued removal whose outcome is unknown and whose evidence changed
     * since is given up only once the runtime's own bound on a removal request (its
     * `removalFenceMs`) has passed since this instant: before that, the request may still act.
     */
    deletionIssuedAt: timestamp("deletion_issued_at", { mode: "date", withTimezone: true }),
    /**
     * Every request the runtime was sent for the current removal, in the order sent, each with its
     * own outcome (review 11 #3, decision 34): `id` is the token that sent it, `issuedAt` when (the
     * database's clock, microseconds since the epoch), `outcome` `unknown` until it is known —
     * `refused` (the runtime definitively did not act on it) or `done` (it removed the executor).
     * A refusal settles only its own request: while any request's outcome is `unknown` the removal
     * stays issued and exclusionary, until the runtime no longer has the executor or the runtime's
     * bound on every such request has passed since it was sent. Empty while nothing was sent; a
     * request sent by a writer from before this record is added for it by the table's trigger.
     */
    deletionRequests: jsonb("deletion_requests")
      .$type<readonly WorkspaceCaptureDeletionRequest[]>()
      .notNull()
      .default([]),
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
    /** The launch identity the attestation named, when it named one (it matched the run's). */
    completionLaunchId: text("completion_launch_id"),
    /** When the attesting store recorded the seal (its clock), when the attestation said. */
    completionSealedAt: timestamp("completion_sealed_at", { mode: "date", withTimezone: true }),
    /** The seal's executor-origin position, when the attestation carried it (decision 17). */
    completionOrigin: jsonb("completion_origin").$type<Readonly<Record<string, unknown>>>(),
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
     * Who is recovering the retained executor right now (review 9 #8): one recovery attempt per
     * executor at a time, across every worker and path (the recovery sweep, the deadline sweep's
     * urgent recovery). Held by `recoveryLeaseToken` until `recoveryLeaseUntil` (the database's
     * clock), longer than the attempt's own bound; released when the attempt ends, and taken
     * over once it lapses (its worker died). A leased executor is not listed due.
     */
    recoveryLeaseToken: text("recovery_lease_token"),
    recoveryLeaseUntil: timestamp("recovery_lease_until", { mode: "date", withTimezone: true }),
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
