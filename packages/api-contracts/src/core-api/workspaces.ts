import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";

import { BudgetExceededError } from "./budgets.js";
import { runCommandSchema, runSchema } from "./runs.js";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

export const workspaceStatusSchema = Schema.Literals([
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
  "stopped",
]);
export type WorkspaceStatus = typeof workspaceStatusSchema.Type;

export const workspaceRuntimeSchema = Schema.Struct({
  adapter: Schema.Literals(["docker", "k8s", "k3s", "cloudflare", "microvm"]),
  /**
   * The executor's identity on its runtime: the Docker container id, the Pod name, the MicroVM
   * id. This is the id a caller records at launch and names in a stop's `completion`.
   */
  resourceId: NonEmptyString,
  reference: NonEmptyString,
  status: Schema.Literals(["pending", "running", "ready", "failed", "stopped"]),
  endpoint: Schema.optional(Schema.String),
  /**
   * ISO-8601 instant the runtime itself ends the executor, whatever anyone asks: a Lambda
   * MicroVM's maximum duration from its start. `null` where the runtime imposes no lifetime
   * (Docker, Kubernetes). A caller holding unsaved work on the executor drains before it. Absent
   * only from control planes that predate it.
   */
  deadline: Schema.optional(Schema.NullOr(Schema.String)),
  /** The run (launch attempt) this executor belongs to. Absent from older control planes. */
  runId: Schema.optional(NonEmptyString),
  /** The launch identity the create named for this executor (`launchId`), when it named one. */
  launchId: Schema.optional(NonEmptyString),
});
export type WorkspaceRuntime = typeof workspaceRuntimeSchema.Type;

export const workspaceSshTargetSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  attemptId: NonEmptyString,
  runtime: Schema.Struct({
    adapter: Schema.Literals(["docker", "k8s", "k3s", "cloudflare", "microvm"]),
    resourceId: NonEmptyString,
    reference: NonEmptyString,
    status: Schema.Literals(["pending", "running", "ready", "failed", "stopped"]),
    endpoint: Schema.String,
  }),
});
export type WorkspaceSshTarget = typeof workspaceSshTargetSchema.Type;

export const workspacePublishedImageSchema = Schema.Struct({
  reference: NonEmptyString,
  digestReference: NonEmptyString,
  digest: NonEmptyString,
});

export const workspaceErrorSchema = Schema.Struct({
  message: Schema.String,
  code: Schema.optional(NonEmptyString),
});

export const githubWorkspaceSourceSelectionSchema = Schema.Struct({
  provider: Schema.Literal("github"),
  installationId: NonEmptyString,
  installationRepositoryId: NonEmptyString,
  ref: Schema.optional(NonEmptyString),
});
export type GitHubWorkspaceSourceSelection = typeof githubWorkspaceSourceSelectionSchema.Type;

// Connected-account selection (mirrors `newWorkspaceCredentialsSchema` in @sealant/validators):
// values are connected-account ids ("cacc_…") or per-provider account names; explicit per-provider
// entries win over the profile's bindings. Resolved server-side into opaque blueprint
// `credentialRefs` — no secret material ever appears in the request or the blueprint.
export const createWorkspaceCredentialsSchema = Schema.Struct({
  profileId: Schema.optional(NonEmptyString),
  claude: Schema.optional(NonEmptyString),
  codex: Schema.optional(NonEmptyString),
  github: Schema.optional(NonEmptyString),
});
export type CreateWorkspaceCredentials = typeof createWorkspaceCredentialsSchema.Type;

export const createWorkspaceRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  registryId: NonEmptyString,
  repository: NonEmptyString,
  tag: NonEmptyString,
  name: Schema.optional(NonEmptyString),
  sourceSelection: Schema.optional(githubWorkspaceSourceSelectionSchema),
  dotfilesSelection: Schema.optional(githubWorkspaceSourceSelectionSchema),
  credentials: Schema.optional(createWorkspaceCredentialsSchema),
  spec: Schema.Unknown,
  // The transient secret channel: validated by `parseWorkspaceSecretEnv`, encrypted at rest on
  // the build job until launch, delivered to the workspace daemon as a boot file, and NEVER part
  // of the blueprint/spec, the attempt snapshot, or any read response. See the SDK README.
  secretEnv: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  // The capture source's session credential (sealantd ADR-0015): required with a `capture`
  // workspace source and refused with any other. Sealed and delivered exactly like `secretEnv`,
  // reaching the daemon's boot secret file as `SEALANT_CAPTURE_TOKEN`; never the spec, the attempt
  // snapshot, or any read response. Not retained: a capture workspace cannot be restarted in place.
  captureToken: Schema.optional(NonEmptyString),
  // Per-create TTL override in seconds; when omitted the server default TTL (if configured)
  // applies. The reaper stops the workspace once the TTL elapses.
  ttlSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /**
   * Makes the create idempotent for this owner: a repeated create with the same key returns the
   * workspace the first one made (`replayed: true`) instead of creating another, so a caller that
   * lost the answer (a crash, a timeout) can repeat it or look the workspace up
   * (`GET /v1/workspaces?idempotencyKey=`). Scoped to `ownerUserId`. The `idempotency-key` header
   * means the same; this field wins when both are sent.
   */
  idempotencyKey: Schema.optional(NonEmptyString),
  /**
   * The caller's immutable identity for the ONE physical executor this create launches, minted
   * before create (a caller that makes the create idempotent can reuse its idempotency key). It is
   * recorded on the launch attempt and reported with the executor (`runtime.launchId`); a stop's
   * completion attestation that names a launch must name this one.
   */
  launchId: Schema.optional(NonEmptyString),
});
export type CreateWorkspaceRequest = typeof createWorkspaceRequestSchema.Type;

export const createWorkspaceHeadersSchema = Schema.Struct({
  "idempotency-key": Schema.optional(NonEmptyString),
});
export type CreateWorkspaceHeaders = typeof createWorkspaceHeadersSchema.Type;

/**
 * The `harnessId` stamped on runs created by the deterministic-exec endpoint, so consumers can tell
 * check runs apart from harness runs when listing/reading runs.
 */
export const execRunHarnessId = "exec";

/**
 * Deterministic exec: run an ORDERED LIST of commands in the workspace, recorded as ONE run (a
 * "check run") — e.g. a causal proof `base fails · head passes · revert fails` as three commands
 * with three recorded exit codes.
 *
 * Semantics differ deliberately from harness runs: every command executes IN ORDER regardless of
 * exit codes (a nonzero exit is a check DATUM, not an execution failure), and the run completes iff
 * every command executed and was recorded. The run's `exitCode` is the LAST command's; per-command
 * exit codes live in the execution record (`processExited` events). The run FAILS only when the
 * execution machinery broke (workspace gone, transport dropped mid-command) — so `status` answers
 * "can I trust these exit codes", not "did the checks pass".
 */
export const execWorkspaceRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  /** Commands execute sequentially in the workspace, each recorded like any other process. */
  commands: Schema.Array(runCommandSchema).check(Schema.isNonEmpty(), Schema.isMaxLength(32)),
});
export type ExecWorkspaceRequest = typeof execWorkspaceRequestSchema.Type;

/**
 * Bind a standby workspace's working directory, or a bindable extra mount, to one subdirectory of
 * its root (sealantd ADR-0014). `mountPath` defaults to the working directory; an empty `subpath`
 * unbinds. The reply is the workspace's full set of live bindings, which every relaunch re-applies.
 */
export const bindWorkspaceRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  mountPath: Schema.optional(NonEmptyString),
  subpath: Schema.String,
});
export type BindWorkspaceRequest = typeof bindWorkspaceRequestSchema.Type;

export const workspaceBindSchema = Schema.Struct({
  mountPath: NonEmptyString,
  subpath: NonEmptyString,
});
export const workspaceBindsSchema = Schema.Struct({
  binds: Schema.Array(workspaceBindSchema),
});
export type WorkspaceBinds = typeof workspaceBindsSchema.Type;

/** Which flush sealantd runs: `final` (the executor is ending) or `suspend` (a checkpoint). */
export const workspaceCaptureFlushKindSchema = Schema.Literals(["final", "suspend"]);
export type WorkspaceCaptureFlushKind = typeof workspaceCaptureFlushKindSchema.Type;

/**
 * Flush a capture-sourced workspace's captures (sealantd ADR-0015 `capture.flush`): a capture,
 * then everything staged is shipped and registered on the session channel. Synchronous over the
 * daemon's control connection, bounded by `deadlineMs`. The reply is the daemon's capture status.
 *
 * `kind: "final"` says the executor is ending: the daemon stops its managed processes (SIGTERM,
 * then SIGKILL after `graceMs`), snapshots both capture classes, ships, and reports `complete`.
 * Only `complete === true` means the executor's work is saved. After a final flush the daemon
 * refuses new work for good. A final flush that runs past its deadline answers `complete: false`
 * and keeps shipping in the daemon, so later status reads and repeated finals converge.
 * `kind: "suspend"` (the default) is a checkpoint: the executor keeps running.
 */
export const flushWorkspaceCaptureRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  /** `final` or `suspend` (the default). */
  kind: Schema.optional(workspaceCaptureFlushKindSchema),
  /** How long the daemon may take before it answers, in milliseconds. Absent: its own default. */
  deadlineMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /**
   * Final only: how long managed processes get between SIGTERM and SIGKILL, in milliseconds,
   * counted inside `deadlineMs`. Absent: the daemon's default.
   */
  graceMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type FlushWorkspaceCaptureRequest = typeof flushWorkspaceCaptureRequestSchema.Type;

/**
 * Read a capture-sourced workspace's capture status (sealantd `capture.status`) without flushing:
 * what a drain polls to show `saving · N left` and to know when the executor may go away.
 */
export const getWorkspaceCaptureStatusQuerySchema = Schema.Struct({
  ownerUserId: NonEmptyString,
});
export type GetWorkspaceCaptureStatusQuery = typeof getWorkspaceCaptureStatusQuerySchema.Type;

export const captureClassSchema = Schema.Literals(["small", "bulk"]);
export type CaptureClass = typeof captureClassSchema.Type;

/** One capture class's snaps (sealantd `CaptureClassSnaps`). */
export const captureClassSnapsSchema = Schema.Struct({
  class: captureClassSchema,
  /** Snaps of this class that failed since the daemon started. */
  snapsFailed: Schema.Number,
  /** The last snap's error, while the last snap failed; absent once one succeeds. */
  lastSnapError: Schema.optional(Schema.String),
  /** When the current run of failed snaps began (Unix ms), while the last snap failed. */
  snapFailingSinceUnixMs: Schema.optional(Schema.Number),
});
export type CaptureClassSnaps = typeof captureClassSnapsSchema.Type;

export const workspaceCaptureStatusSchema = Schema.Struct({
  epoch: Schema.Number,
  worktreeId: NonEmptyString,
  /** The newest capture the session channel has registered for this worktree. */
  headN: Schema.optional(Schema.Number),
  /** Captures staged on the executor and not yet registered: the unsaved queue. */
  pending: Schema.Number,
  stagedBytes: Schema.Number,
  uploadedObjects: Schema.Number,
  uploadedBytes: Schema.Number,
  registered: Schema.Number,
  fenced: Schema.Boolean,
  paused: Schema.Boolean,
  lastSnapUnixMs: Schema.optional(Schema.Number),
  /**
   * Capture classes the registrar refused for the session's byte quota: nothing of these ships
   * until the next epoch or re-plan, whatever `pending` says. Non-empty means work is NOT being
   * saved. Absent from control planes that predate it.
   */
  refused: Schema.optional(Schema.Array(captureClassSchema)),
  /**
   * Bytes still to ship, and bulk captures still pending (sealantd's `pending_bytes` /
   * `pending_bulk`). Every field below `refused` is absent until the daemon reports it (the
   * control plane's pinned sealantd wire predates them).
   */
  pendingBytes: Schema.optional(Schema.Number),
  pendingBulk: Schema.optional(Schema.Number),
  /**
   * The daemon's own account of its last FINAL flush: true only when it quiesced every managed
   * process, snapshotted both capture classes and registered everything. The only proof that an
   * executor may go away; `pending === 0` alone is not. Absent until sealantd reports it (read
   * absent as not complete).
   */
  complete: Schema.optional(Schema.Boolean),
  /**
   * Why the last final flush is not complete (`not-final`, `in-progress`, `processes-remain`,
   * `sweep-unavailable`, `snapshot-failed`, `unreadable`, `fenced`, `conflict`, `deadline`,
   * `ship-failed`, `pending`, `internal`). A class whose last snap failed is `snapshot-failed`.
   */
  incompleteReason: Schema.optional(Schema.String),
  /**
   * Paths the last snap of each class could not read (listed, stat'ed or opened), summed over
   * both classes. Never taken as deleted: an automatic snap carries a path's last captured
   * content forward, a final snap fails instead.
   */
  unreadable: Schema.optional(Schema.Number),
  /** Of `unreadable`, the paths whose last captured content was carried forward. */
  carried: Schema.optional(Schema.Number),
  /**
   * The first unreadable paths (at most 20), virtual: `tree/<path>` under the worktree,
   * `.git/<path>`, `harness/<path>`; small class first.
   */
  unreadablePaths: Schema.optional(Schema.Array(Schema.String)),
  /**
   * A capture the registrar refused to register that the executor is working through:
   * `missing-objects` (an object it names is not in the store) or `unrestorable` (a section's
   * tree would not restore). Nothing is dropped: its objects are uploaded again and it is
   * rebuilt from disk in its place.
   */
  registerRefused: Schema.optional(Schema.String),
  /** That refused capture's chain position. */
  registerRefusedN: Schema.optional(Schema.Number),
  /** The first keys (at most 20) the registrar named as missing. */
  registerMissing: Schema.optional(Schema.Array(Schema.String)),
  /** Register refusals the daemon has seen since it started. */
  registerRefusals: Schema.optional(Schema.Number),
  /** The refused capture waits to be rebuilt from disk; nothing behind it registers first. */
  repairing: Schema.optional(Schema.Boolean),
  /**
   * A bulk build is in progress: its capture is not queued yet, so `pending` and `pendingBulk`
   * do not count it (`pendingBytes` counts what it has staged). A drain is not done while true.
   */
  bulkBuilding: Schema.optional(Schema.Boolean),
  /**
   * Each captured class's snaps: how many failed since the daemon started, and the last one's
   * error while it fails. A snap that fails stages nothing: what changed since the last capture
   * is on the executor's disk only.
   */
  snaps: Schema.optional(Schema.Array(captureClassSnapsSchema)),
  /**
   * Derived from `snaps`: the error of the class that has been failing longest. Present means the
   * executor's newest work is NOT being captured, whatever `pending` says.
   */
  lastSnapError: Schema.optional(Schema.String),
  /** Derived from `snaps`: when the earliest current run of failed snaps began (Unix ms). */
  snapFailingSinceUnixMs: Schema.optional(Schema.Number),
  /** Derived from `snaps`: failed snaps of every class since the daemon started. */
  snapsFailed: Schema.optional(Schema.Number),
});
export type WorkspaceCaptureStatus = typeof workspaceCaptureStatusSchema.Type;

/**
 * Re-plan a capture-sourced workspace (sealantd 0.15 `capture.replan`, the claim hook): the daemon
 * asks the session channel for its plan again with no worktree named, delta-materialises the
 * answer over what is on disk, and captures under the answered worktree and epoch from then on.
 * Synchronous over the daemon's control connection. Idempotent: `unchanged` is true when the
 * answer named the worktree and epoch already in force.
 */
export const replanWorkspaceCaptureRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
});
export type ReplanWorkspaceCaptureRequest = typeof replanWorkspaceCaptureRequestSchema.Type;

export const workspaceCaptureReplannedSchema = Schema.Struct({
  worktreeId: NonEmptyString,
  epoch: Schema.Number,
  headN: Schema.optional(Schema.Number),
  headCaptureId: Schema.optional(NonEmptyString),
  filesWritten: Schema.Number,
  bytesWritten: Schema.Number,
  filesSkipped: Schema.Number,
  bytesSkipped: Schema.Number,
  removed: Schema.Number,
  unchanged: Schema.Boolean,
});
export type WorkspaceCaptureReplanned = typeof workspaceCaptureReplannedSchema.Type;

export const renameWorkspaceRequestSchema = Schema.Struct({
  name: NonEmptyString,
  /** The workspace's owner. Required by the control plane: a rename that names none finds nothing. */
  ownerUserId: Schema.optional(NonEmptyString),
});
export type RenameWorkspaceRequest = typeof renameWorkspaceRequestSchema.Type;

// Lifecycle actions are owner-scoped like execWorkspace: ownerUserId rides in the payload and a
// mismatch yields a uniform 404 (existence is not leaked).
export const stopWorkspaceRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  /**
   * End the workspace WITHOUT saving its unsaved captures. A capture-sourced workspace is
   * otherwise drained before it stops, and kept running for as long as its work cannot be
   * confirmed saved; this is the owner's explicit way out. The request is recorded (who, when)
   * and every stop path honours it: the runtime is terminated at once, and the workspace's
   * `captureDrain` reads `discarded`. Accepted on a workspace already stopped whose runtime is
   * still up (a kept one). Owner only.
   */
  discardUnsaved: Schema.optional(Schema.Boolean),
  /**
   * The caller's attestation that its capture store holds a SEALED final capture of this
   * workspace's current executor: a FINAL flush that completed (every writer stopped, both
   * classes snapshotted, everything registered) and was recorded durably by the store. It is
   * permission to remove that executor's disk once it has ended, even when this control plane
   * never read `complete: true` from it itself (the FINAL reply was lost, the daemon exited
   * before a drain reached it). Accepted only when `executorId` names the current executor — the
   * run id, or the runtime's `resourceId` / `reference` (`workspace.details().runtime`) — and
   * `epoch` is not older than any the executor reported; otherwise ignored, and the executor is
   * kept as before. Never a reason to skip the drain of a running executor.
   */
  completion: Schema.optional(
    Schema.Struct({
      /** The sealed capture's chain position (`n`). */
      captureN: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      /** The capture lease epoch the seal was made under. */
      epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      /** The executor the seal names: run id, or runtime `resourceId` / `reference`. */
      executorId: NonEmptyString,
      /**
       * The launch identity the seal names (`final_seal.executor`). Required when the create named
       * a `launchId`, and then it must be that one; an attestation without it, or naming another
       * launch, is ignored (a seal never transfers between executors).
       */
      launchId: Schema.optional(NonEmptyString),
    }),
  ),
});
export type StopWorkspaceRequest = typeof stopWorkspaceRequestSchema.Type;

export const stopWorkspaceResponseSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  status: workspaceStatusSchema,
  /**
   * What became of a `completion` attestation on the request: `accepted` (recorded; it lets the
   * executor's disk go once it has ended) or `ignored` (it does not name this executor, or is for
   * an older epoch; `detail` says which). Absent when the request carried none.
   */
  completion: Schema.optional(
    Schema.Struct({
      outcome: Schema.Literals(["accepted", "ignored"]),
      detail: Schema.optional(Schema.String),
    }),
  ),
});
export type StopWorkspaceResponse = typeof stopWorkspaceResponseSchema.Type;

/** Owner-scoped: ask the control plane to recover the workspace's retained executor now. */
export const recoverWorkspaceRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
});
export type RecoverWorkspaceRequest = typeof recoverWorkspaceRequestSchema.Type;

/**
 * `requested`: the workspace's executor is retained (its disk holds work not confirmed saved) and
 * a recovery attempt is due now; `recoverable` says whether its runtime can restart it on its own
 * disk (Docker) or only report it (Kubernetes, MicroVM). `not-retained`: nothing is retained for
 * the workspace's current run; nothing was done.
 */
export const recoverWorkspaceResponseSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  state: Schema.Literals(["requested", "not-retained"]),
  recoverable: Schema.optional(Schema.Boolean),
});
export type RecoverWorkspaceResponse = typeof recoverWorkspaceResponseSchema.Type;

export const restartWorkspaceRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
});
export type RestartWorkspaceRequest = typeof restartWorkspaceRequestSchema.Type;

export const restartWorkspaceResponseSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  /** The new attempt driving the fresh launch. */
  runId: NonEmptyString,
  status: workspaceStatusSchema,
});
export type RestartWorkspaceResponse = typeof restartWorkspaceResponseSchema.Type;

export const expireWorkspaceRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  // Seconds from now until the workspace expires; null clears the TTL (never expires); omitted =
  // expire immediately (the reaper stops it on its next tick).
  ttlSeconds: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
});
export type ExpireWorkspaceRequest = typeof expireWorkspaceRequestSchema.Type;

export const expireWorkspaceResponseSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  expiresAt: Schema.NullOr(Schema.String),
});
export type ExpireWorkspaceResponse = typeof expireWorkspaceResponseSchema.Type;

export const renameWorkspaceResponseSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  name: NonEmptyString,
  updatedAt: Schema.String,
});
export type RenameWorkspaceResponse = typeof renameWorkspaceResponseSchema.Type;

export const createWorkspaceResponseSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  name: NonEmptyString,
  status: workspaceStatusSchema,
  registryId: NonEmptyString,
  repository: NonEmptyString,
  tag: NonEmptyString,
  /** The launch attempt this create started (or, replayed, the workspace's latest). */
  runId: Schema.optional(NonEmptyString),
  /**
   * The executor, once one exists: on a fresh create there is none yet (the launch is
   * asynchronous); a replayed create carries the workspace's current one.
   */
  runtime: Schema.optional(workspaceRuntimeSchema),
  /** `true` when an earlier create with the same `idempotencyKey` made this workspace. */
  replayed: Schema.optional(Schema.Boolean),
  /** The launch identity the create named (`launchId`), recorded on its attempt. */
  launchId: Schema.optional(NonEmptyString),
});
export type CreateWorkspaceResponse = typeof createWorkspaceResponseSchema.Type;

/**
 * What became of an idempotent create, by its key (owner-scoped):
 *
 *  - `pending`: a create with the key started and has not committed — it may still be in flight,
 *    or it died before it committed. A repeat of the create finishes it; `cancel` makes sure it
 *    never does. `workspaceId` names a half-made workspace a create from before this record
 *    left, which a repeat of the create completes.
 *  - `found`: the create committed; `workspaceId` (and `runId`, `launchId`) name what it made.
 *  - `cancelled`: the key was cancelled; no create with it ever commits.
 *  - `none`: no create with the key has reached this control plane (yet). Point-in-time only: a
 *    delayed request can still arrive — `cancel` is the answer that stays true.
 */
export const workspaceCreateStateSchema = Schema.Struct({
  idempotencyKey: NonEmptyString,
  state: Schema.Literals(["pending", "found", "cancelled", "none"]),
  workspaceId: Schema.optional(NonEmptyString),
  runId: Schema.optional(NonEmptyString),
  launchId: Schema.optional(NonEmptyString),
});
export type WorkspaceCreateState = typeof workspaceCreateStateSchema.Type;

export const getWorkspaceCreateQuerySchema = Schema.Struct({
  ownerUserId: NonEmptyString,
});
export type GetWorkspaceCreateQuery = typeof getWorkspaceCreateQuerySchema.Type;

/** Owner-scoped: cancel the create with this key, so it never commits. */
export const cancelWorkspaceCreateRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
});
export type CancelWorkspaceCreateRequest = typeof cancelWorkspaceCreateRequestSchema.Type;

export const workspaceSummarySchema = Schema.Struct({
  workspaceId: NonEmptyString,
  name: NonEmptyString,
  ownerUserId: NonEmptyString,
  status: workspaceStatusSchema,
  registryId: Schema.optional(NonEmptyString),
  repository: Schema.optional(NonEmptyString),
  tag: Schema.optional(NonEmptyString),
  runtime: Schema.optional(workspaceRuntimeSchema),
  publishedImage: Schema.optional(workspacePublishedImageSchema),
  error: Schema.optional(workspaceErrorSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
});
export type WorkspaceSummary = typeof workspaceSummarySchema.Type;

/**
 * What the control plane last OBSERVED of a capture-sourced workspace's drain — the FINAL flush
 * and queue polling every platform stop runs before it removes the runtime. A stop request is
 * not a stop: until the runtime is gone, this is what is happening.
 *
 *  - `draining`: the queue is still moving; the stop continues on the server.
 *  - `kept`: nothing will stop the runtime — the work is not confirmed saved (the queue stalled,
 *    a class was refused, the daemon is silent while the executor runs, or the daemon did not
 *    report its final flush complete). `detail` says which.
 *  - `saved`: the daemon reported its final flush complete; the runtime is being removed.
 *  - `gone`: the daemon is silent and the runtime reports the executor ended.
 *  - `stop-failed`: the drain let the stop through but removing the runtime failed (`detail`
 *    has the error); the control plane retries the stop.
 *  - `stopped`: the runtime was removed after its drain let it go.
 *  - `discarded`: the owner discarded the unsaved captures (`stop({ discardUnsaved: true })`);
 *    the runtime was terminated without a drain. `discard` records who asked, and when.
 *
 * `preservationStartsAt` is when the control plane starts that drain on its own ahead of the
 * runtime's deadline (`runtime.deadline`), once it has planned one.
 */
export const workspaceCaptureDrainSchema = Schema.Struct({
  state: Schema.Literals([
    "draining",
    "kept",
    "saved",
    "gone",
    "stop-failed",
    "stopped",
    "discarded",
  ]),
  detail: Schema.optional(Schema.String),
  /** ISO-8601: when this was observed. */
  observedAt: Schema.optional(Schema.String),
  /** ISO-8601: when the deadline sweep starts (or started) the final drain. */
  preservationStartsAt: Schema.optional(Schema.String),
  /** The owner's request to discard the unsaved captures: who asked, and when (ISO-8601). */
  discard: Schema.optional(
    Schema.Struct({ requestedBy: NonEmptyString, requestedAt: Schema.String }),
  ),
  /**
   * The executor is RETAINED: kept because its disk holds work not confirmed saved. `since` and
   * `reason` say when and why; recovery is attempted on a backoff (`recoveryAttempts`,
   * `nextRecoveryAt`, `lastRecoveryError`); `recoverable` says whether its runtime can restart it
   * on its own disk (Docker) or only report it (Kubernetes, MicroVM). Absent when nothing is
   * retained.
   */
  retained: Schema.optional(
    Schema.Struct({
      since: Schema.String,
      reason: Schema.String,
      recoverable: Schema.Boolean,
      recoveryAttempts: Schema.Int,
      nextRecoveryAt: Schema.optional(Schema.String),
      lastRecoveryError: Schema.optional(Schema.String),
    }),
  ),
  /**
   * The executor this observation is about: the run and its runtime identity (`resourceId` is
   * the id a stop's `completion` names).
   */
  executor: Schema.optional(
    Schema.Struct({
      runId: NonEmptyString,
      adapter: NonEmptyString,
      resourceId: NonEmptyString,
      reference: Schema.optional(NonEmptyString),
    }),
  ),
  /** The latest `completion` attestation accepted for this executor (see `stop`). */
  completion: Schema.optional(
    Schema.Struct({
      executorId: NonEmptyString,
      epoch: Schema.Int,
      captureN: Schema.Int,
      attestedAt: Schema.String,
      launchId: Schema.optional(NonEmptyString),
    }),
  ),
});
export type WorkspaceCaptureDrain = typeof workspaceCaptureDrainSchema.Type;

export const workspaceDetailsSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  name: NonEmptyString,
  ownerUserId: NonEmptyString,
  status: workspaceStatusSchema,
  registryId: Schema.optional(NonEmptyString),
  repository: Schema.optional(NonEmptyString),
  tag: Schema.optional(NonEmptyString),
  runtime: Schema.optional(workspaceRuntimeSchema),
  publishedImage: Schema.optional(workspacePublishedImageSchema),
  error: Schema.optional(workspaceErrorSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
  spec: Schema.optional(Schema.Unknown),
  /**
   * The current runtime's capture drain as last observed (see `workspaceCaptureDrainSchema`).
   * Absent while no drain or preservation schedule exists, and from older control planes.
   */
  captureDrain: Schema.optional(workspaceCaptureDrainSchema),
});
export type WorkspaceDetails = typeof workspaceDetailsSchema.Type;

/**
 * Owner scoping on a single read: the workspace must belong to `ownerUserId` (uniform 404).
 * Optional on the wire for older callers; the control plane requires it.
 */
export const getWorkspaceQuerySchema = Schema.Struct({
  ownerUserId: Schema.optional(NonEmptyString),
});
export type GetWorkspaceQuery = typeof getWorkspaceQuerySchema.Type;

export const listWorkspacesQuerySchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  status: Schema.optional(workspaceStatusSchema),
  limit: Schema.optional(NonEmptyString),
  /** Only the owner's workspace created with this `idempotencyKey` (none or one item). */
  idempotencyKey: Schema.optional(NonEmptyString),
});
export type ListWorkspacesQuery = typeof listWorkspacesQuerySchema.Type;

export const listWorkspacesResponseSchema = Schema.Struct({
  items: Schema.Array(workspaceSummarySchema),
});
export type ListWorkspacesResponse = typeof listWorkspacesResponseSchema.Type;

export const listWorkspaceAttemptsQuerySchema = Schema.Struct({
  ownerUserId: Schema.optional(NonEmptyString),
  limit: Schema.optional(NonEmptyString),
});
export type ListWorkspaceAttemptsQuery = typeof listWorkspaceAttemptsQuerySchema.Type;

export const workspaceAttemptSummarySchema = Schema.Struct({
  attemptId: NonEmptyString,
  relation: Schema.Literals(["launch", "rebuild", "retry", "resume"]),
  status: workspaceStatusSchema,
  triggerType: Schema.Literals(["manual", "schedule", "api", "retry"]),
  triggerRef: Schema.optional(NonEmptyString),
  runtime: Schema.optional(workspaceRuntimeSchema),
  publishedImage: Schema.optional(workspacePublishedImageSchema),
  error: Schema.optional(workspaceErrorSchema),
  spec: Schema.optional(Schema.Unknown),
  queuedAt: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  linkedAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type WorkspaceAttemptSummary = typeof workspaceAttemptSummarySchema.Type;

export const listWorkspaceAttemptsResponseSchema = Schema.Struct({
  items: Schema.Array(workspaceAttemptSummarySchema),
});
export type ListWorkspaceAttemptsResponse = typeof listWorkspaceAttemptsResponseSchema.Type;

export const listWorkspaceEventsQuerySchema = Schema.Struct({
  ownerUserId: Schema.optional(NonEmptyString),
  limit: Schema.optional(NonEmptyString),
});
export type ListWorkspaceEventsQuery = typeof listWorkspaceEventsQuerySchema.Type;

export const workspaceEventTypeSchema = Schema.Literals([
  "workspace.created",
  "attempt.queued",
  "attempt.running",
  "attempt.succeeded",
  "attempt.failed",
  "attempt.cancelled",
  "image.published",
  "runtime.pending",
  "runtime.running",
  "runtime.ready",
  "runtime.failed",
  "runtime.stopped",
]);
export type WorkspaceEventType = typeof workspaceEventTypeSchema.Type;

export const workspaceEventSchema = Schema.Struct({
  eventId: NonEmptyString,
  workspaceId: NonEmptyString,
  attemptId: Schema.optional(NonEmptyString),
  type: workspaceEventTypeSchema,
  occurredAt: Schema.String,
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
});
export type WorkspaceEvent = typeof workspaceEventSchema.Type;

export const listWorkspaceEventsResponseSchema = Schema.Struct({
  items: Schema.Array(workspaceEventSchema),
});
export type ListWorkspaceEventsResponse = typeof listWorkspaceEventsResponseSchema.Type;

export const workspaceGatewayHeadersSchema = Schema.Struct({
  // Authenticates the gateway as a trusted caller of this internal endpoint.
  "x-sealant-gateway-token": Schema.optional(NonEmptyString),
  // Identifies the client principal (the SSH key's owner). The API authorizes principal x workspace
  // before returning a control target (gateway-spec §3.4).
  "x-sealant-principal-id": Schema.optional(NonEmptyString),
});
export type WorkspaceGatewayHeaders = typeof workspaceGatewayHeadersSchema.Type;

export class WorkspaceBadRequestError extends Schema.TaggedErrorClass<WorkspaceBadRequestError>()(
  "WorkspaceBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

/**
 * Kubernetes-only create-time inputs (cluster env sources `runtime.envFrom`, a workspace
 * `kubernetes.serviceAccountName`) on a deployment whose workspaces do not run on Kubernetes.
 * Refused synchronously at POST /v1/workspaces — no workspace row, no build job, no failure
 * minutes later. The stable `code` doubles as the SDK consumer's capability probe: mapping this
 * code is how a caller learns the install cannot resolve cluster bindings, instead of trusting a
 * config flag that can lie.
 */
export class WorkspaceRuntimeEnvReferencesUnsupportedError extends Schema.TaggedErrorClass<WorkspaceRuntimeEnvReferencesUnsupportedError>()(
  "WorkspaceRuntimeEnvReferencesUnsupportedError",
  {
    message: Schema.String,
    code: Schema.Literals(["runtime-env-references-unsupported"]),
  },
  { httpApiStatus: 422 },
) {}

/**
 * `services.docker` requested on an install whose workspace runtime cannot serve it. Kubernetes
 * needs its operator-enabled rootless sidecar. Lambda MicroVMs need a separate Docker-capable
 * image, leaving the default image at its restricted Linux capability set. Refused synchronously
 * at POST /v1/workspaces; the stable `code` is the consumer's capability probe.
 */
export class WorkspaceDockerServiceUnsupportedError extends Schema.TaggedErrorClass<WorkspaceDockerServiceUnsupportedError>()(
  "WorkspaceDockerServiceUnsupportedError",
  {
    message: Schema.String,
    code: Schema.Literals(["workspace-docker-unsupported"]),
  },
  { httpApiStatus: 422 },
) {}

export class WorkspaceUnauthorizedError extends Schema.TaggedErrorClass<WorkspaceUnauthorizedError>()(
  "WorkspaceUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {}

export class WorkspaceForbiddenError extends Schema.TaggedErrorClass<WorkspaceForbiddenError>()(
  "WorkspaceForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

export class WorkspaceNotFoundError extends Schema.TaggedErrorClass<WorkspaceNotFoundError>()(
  "WorkspaceNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class WorkspaceConflictError extends Schema.TaggedErrorClass<WorkspaceConflictError>()(
  "WorkspaceConflictError",
  {
    message: Schema.String,
    /** A stable reason, where one applies (`create-cancelled`: the create's key was cancelled). */
    code: Schema.optional(NonEmptyString),
  },
  { httpApiStatus: 409 },
) {}

export class WorkspaceBadGatewayError extends Schema.TaggedErrorClass<WorkspaceBadGatewayError>()(
  "WorkspaceBadGatewayError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {}

export class WorkspaceServiceUnavailableError extends Schema.TaggedErrorClass<WorkspaceServiceUnavailableError>()(
  "WorkspaceServiceUnavailableError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class WorkspaceInternalServerError extends Schema.TaggedErrorClass<WorkspaceInternalServerError>()(
  "WorkspaceInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

const workspaceIdParams = Schema.Struct({ workspaceId: NonEmptyString });
const idempotencyKeyParams = Schema.Struct({ idempotencyKey: NonEmptyString });

export const WorkspacesGroup = HttpApiGroup.make("workspaces")
  .add(
    HttpApiEndpoint.post("createWorkspace", "/", {
      headers: createWorkspaceHeadersSchema,
      payload: createWorkspaceRequestSchema,
      success: createWorkspaceResponseSchema.pipe(HttpApiSchema.status(202)),
      error: [
        BudgetExceededError,
        WorkspaceBadRequestError,
        WorkspaceRuntimeEnvReferencesUnsupportedError,
        WorkspaceDockerServiceUnsupportedError,
        WorkspaceForbiddenError,
        WorkspaceNotFoundError,
        // Selected connected account exists but is not usable (status "invalid").
        WorkspaceConflictError,
        WorkspaceBadGatewayError,
        WorkspaceServiceUnavailableError,
        WorkspaceInternalServerError,
      ],
    }),
  )
  .add(
    // What became of an idempotent create, by its key (owner-scoped).
    HttpApiEndpoint.get("getWorkspaceCreate", "/idempotency-keys/:idempotencyKey", {
      params: idempotencyKeyParams,
      query: getWorkspaceCreateQuerySchema,
      success: workspaceCreateStateSchema,
      error: [WorkspaceBadRequestError, WorkspaceInternalServerError],
    }),
  )
  .add(
    // Cancel an idempotent create by its key: a create with it never commits afterwards (a
    // delayed original request included). `found` when it had already committed.
    HttpApiEndpoint.post("cancelWorkspaceCreate", "/idempotency-keys/:idempotencyKey/cancel", {
      params: idempotencyKeyParams,
      payload: cancelWorkspaceCreateRequestSchema,
      success: workspaceCreateStateSchema,
      error: [WorkspaceBadRequestError, WorkspaceInternalServerError],
    }),
  )
  .add(
    // Synchronous: the daemon applies the bind over the control connection before this answers.
    HttpApiEndpoint.post("bindWorkspace", "/:workspaceId/bind", {
      params: workspaceIdParams,
      payload: bindWorkspaceRequestSchema,
      success: workspaceBindsSchema,
      error: [
        WorkspaceBadRequestError,
        WorkspaceNotFoundError,
        // No live runtime to bind in (never launched, mid-launch, or the daemon refused).
        WorkspaceConflictError,
        WorkspaceInternalServerError,
      ],
    }),
  )
  .add(
    // Synchronous: the daemon flushes over the control connection before this answers.
    HttpApiEndpoint.post("flushWorkspaceCapture", "/:workspaceId/capture/flush", {
      params: workspaceIdParams,
      payload: flushWorkspaceCaptureRequestSchema,
      success: workspaceCaptureStatusSchema,
      error: [
        // Not a capture-sourced workspace.
        WorkspaceBadRequestError,
        WorkspaceNotFoundError,
        // No live runtime to flush (never launched, mid-launch, or the daemon refused).
        WorkspaceConflictError,
        WorkspaceInternalServerError,
      ],
    }),
  )
  .add(
    // Synchronous: one `capture.status` round trip over the control connection; flushes nothing.
    HttpApiEndpoint.get("getWorkspaceCaptureStatus", "/:workspaceId/capture", {
      params: workspaceIdParams,
      query: getWorkspaceCaptureStatusQuerySchema,
      success: workspaceCaptureStatusSchema,
      error: [
        // Not a capture-sourced workspace.
        WorkspaceBadRequestError,
        WorkspaceNotFoundError,
        // No live runtime to ask (never launched, mid-launch, gone, or the daemon refused).
        WorkspaceConflictError,
        WorkspaceInternalServerError,
      ],
    }),
  )
  .add(
    // Synchronous: the daemon re-plans and delta-materialises over the control connection before
    // this answers.
    HttpApiEndpoint.post("replanWorkspaceCapture", "/:workspaceId/capture/replan", {
      params: workspaceIdParams,
      payload: replanWorkspaceCaptureRequestSchema,
      success: workspaceCaptureReplannedSchema,
      error: [
        // Not a capture-sourced workspace.
        WorkspaceBadRequestError,
        WorkspaceNotFoundError,
        // No live runtime to re-plan (never launched, mid-launch, or the daemon refused).
        WorkspaceConflictError,
        WorkspaceInternalServerError,
      ],
    }),
  )
  .add(
    // Async like createWorkspace: 202 + the queued run resource; poll `GET /v1/runs/:runId` to
    // completion, then read exit codes / scrollback from the run record.
    HttpApiEndpoint.post("execWorkspace", "/:workspaceId/exec", {
      params: workspaceIdParams,
      payload: execWorkspaceRequestSchema,
      success: runSchema.pipe(HttpApiSchema.status(202)),
      error: [
        WorkspaceBadRequestError,
        WorkspaceNotFoundError,
        // The workspace has never launched a runtime — nothing to exec in yet.
        WorkspaceConflictError,
        WorkspaceInternalServerError,
      ],
    }),
  )
  .add(
    // Async: 202 = the stop was accepted and enqueued; the worker removes the container and the
    // workspace transitions to "stopped". Idempotent — stopping a stopped workspace is a no-op 202.
    HttpApiEndpoint.post("stopWorkspace", "/:workspaceId/stop", {
      params: workspaceIdParams,
      payload: stopWorkspaceRequestSchema,
      success: stopWorkspaceResponseSchema.pipe(HttpApiSchema.status(202)),
      error: [
        WorkspaceBadRequestError,
        WorkspaceNotFoundError,
        // The workspace has never launched a runtime — nothing to stop yet.
        WorkspaceConflictError,
        WorkspaceBadGatewayError,
        WorkspaceInternalServerError,
      ],
    }),
  )
  .add(
    // Async: 202 = a recovery attempt of the workspace's retained executor is due now; the worker
    // restarts it on its own disk where the runtime can, drains it with a FINAL flush and only
    // then removes it. Nothing retained = `not-retained`, nothing done.
    HttpApiEndpoint.post("recoverWorkspace", "/:workspaceId/recover", {
      params: workspaceIdParams,
      payload: recoverWorkspaceRequestSchema,
      success: recoverWorkspaceResponseSchema.pipe(HttpApiSchema.status(202)),
      error: [
        WorkspaceBadRequestError,
        WorkspaceNotFoundError,
        WorkspaceConflictError,
        WorkspaceInternalServerError,
      ],
    }),
  )
  .add(
    // Async: 202 + the new attempt id. Restart = stop the current runtime (if any) and drive a
    // fresh launch from the same resolved spec — a new container, no filesystem carry-over.
    HttpApiEndpoint.post("restartWorkspace", "/:workspaceId/restart", {
      params: workspaceIdParams,
      payload: restartWorkspaceRequestSchema,
      success: restartWorkspaceResponseSchema.pipe(HttpApiSchema.status(202)),
      error: [
        BudgetExceededError,
        WorkspaceBadRequestError,
        WorkspaceNotFoundError,
        // The workspace has never launched (no spec to relaunch from) or is mid-launch.
        WorkspaceConflictError,
        WorkspaceBadGatewayError,
        WorkspaceInternalServerError,
      ],
    }),
  )
  .add(
    // Synchronous: sets (or clears) the workspace TTL column; the worker reaper enforces it.
    HttpApiEndpoint.post("expireWorkspace", "/:workspaceId/expire", {
      params: workspaceIdParams,
      payload: expireWorkspaceRequestSchema,
      success: expireWorkspaceResponseSchema,
      error: [WorkspaceBadRequestError, WorkspaceNotFoundError, WorkspaceInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.patch("renameWorkspace", "/:workspaceId/name", {
      params: workspaceIdParams,
      payload: renameWorkspaceRequestSchema,
      success: renameWorkspaceResponseSchema,
      error: [WorkspaceNotFoundError, WorkspaceInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listWorkspaces", "/", {
      query: listWorkspacesQuerySchema,
      success: listWorkspacesResponseSchema,
      error: [WorkspaceBadRequestError, WorkspaceInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getWorkspace", "/:workspaceId", {
      params: workspaceIdParams,
      query: getWorkspaceQuerySchema,
      success: workspaceDetailsSchema,
      error: [WorkspaceNotFoundError, WorkspaceInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listWorkspaceAttempts", "/:workspaceId/attempts", {
      params: workspaceIdParams,
      query: listWorkspaceAttemptsQuerySchema,
      success: listWorkspaceAttemptsResponseSchema,
      error: [WorkspaceBadRequestError, WorkspaceNotFoundError, WorkspaceInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listWorkspaceEvents", "/:workspaceId/events", {
      params: workspaceIdParams,
      query: listWorkspaceEventsQuerySchema,
      success: listWorkspaceEventsResponseSchema,
      error: [WorkspaceBadRequestError, WorkspaceNotFoundError, WorkspaceInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getWorkspaceSshTarget", "/:workspaceId/ssh-target", {
      params: workspaceIdParams,
      headers: workspaceGatewayHeadersSchema,
      success: workspaceSshTargetSchema,
      error: [
        WorkspaceUnauthorizedError,
        WorkspaceNotFoundError,
        WorkspaceConflictError,
        WorkspaceServiceUnavailableError,
        WorkspaceInternalServerError,
      ],
    }),
  )
  .annotate(
    OpenApi.Description,
    "Workspace lifecycle, attempts, events, and runtime routing endpoints.",
  );
