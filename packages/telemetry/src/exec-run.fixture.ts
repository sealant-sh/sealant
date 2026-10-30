/**
 * A scripted workspace for exec recorder tests, typed end to end: a daemon session, the telemetry
 * sink, and a run repository that keeps one run's row. A command's first argument says how the
 * daemon answers it: an exit code, `hang` (it never exits), `lost` (the exec's answer is lost) or
 * `refused` (the daemon refuses it, error 3). Every other exec (the changes reading, a sync-back
 * read) exits with `readExitCode`. A call nothing scripts dies, naming itself.
 */
import { create } from "@bufbuild/protobuf";
import {
  ConnectedAccountRepo,
  type ConnectedAccountRepoService,
  type CreateRunInput,
  type Run,
  type RunExecClaim,
  RunRepo,
  type RunRepoService,
  RunRepoUnexpectedError,
  WorkspaceAttemptRepo,
  type WorkspaceAttemptRepoService,
  type Workspace,
  WorkspaceRepo,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstance,
  WorkspaceRuntimeInstanceRepo,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import {
  CapabilitiesSchema,
  type EventEnvelope,
  EventEnvelopeSchema,
  type ExecAccepted,
  ExecAcceptedSchema,
  HealthReportSchema,
} from "@sealant/runtime-protocol";
import {
  SealantControlError,
  type SealantError,
  type SealantExecOptions,
  SealantRuntime,
  type SealantSession,
  type SealantTarget,
  type SyncBackWorkspaceCredentialsInput,
  TransportError,
} from "@sealant/workspaces";
import { Deferred, Effect, Layer, Stream } from "effect";

import { TelemetrySink, type TelemetrySinkService } from "./sink.js";

export const FAKE_TARGET: SealantTarget = {
  kind: "docker-exec",
  containerId: "c1",
  socketPath: "/s",
};

const unscripted = (call: string) => () => Effect.die(`unscripted call ${call}`);

/** A credentials cipher, as an API or worker with SEALANT_CREDENTIALS_KEY holds one. */
export const FAKE_CIPHER: NonNullable<SyncBackWorkspaceCredentialsInput["credentialCipher"]> = {
  encrypt: unscripted("encrypt"),
  decrypt: unscripted("decrypt"),
};

/** The daemon's `processExited` for one process. */
export const exitedEvent = (
  processId: string,
  exitCode: number,
  executionId?: string,
): EventEnvelope =>
  create(EventEnvelopeSchema, {
    schemaVersion: 1,
    eventId: `evt_${processId}`,
    runtimeId: "rt_1",
    sequence: 1n,
    observedAt: 1n,
    monotonicTimestamp: 1n,
    captureMethod: 1,
    confidence: 1,
    processId,
    ...(executionId === undefined ? {} : { executionId }),
    payload: { case: "processExited", value: { exitCode, reason: 1 } },
  });

const refused = (operation: RunRepoUnexpectedError["operation"]) =>
  Effect.fail(
    new RunRepoUnexpectedError({ operation, message: "the database refused it", cause: 0 }),
  );
const newRow = (input: CreateRunInput): Run => ({
  id: input.id,
  workspaceId: input.workspaceId,
  attemptId: null,
  ownerUserId: input.ownerUserId,
  harnessId: input.harnessId,
  mode: input.mode ?? "one-shot",
  status: "queued",
  prompt: null,
  command: null,
  metadata: null,
  processUser: input.processUser ?? null,
  exitCode: null,
  errorMessage: null,
  diff: null,
  changedFiles: null,
  changesReadFailedAt: null,
  recordDeletedAt: null,
  startedAt: null,
  finishedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

export interface FakeExecWorldOptions {
  /** How many health reads fail before the daemon answers. */
  readonly healthFailures?: number;
  /** The exit code of every exec that is not a run's command. */
  readonly readExitCode?: number;
  /** How many of those execs lose their answer before the daemon answers them. */
  readonly readFailures?: number;
  readonly failCreate?: boolean;
  /** `markRunCompleted` and `markRunFailed` fail; reads still answer. */
  readonly failTerminalWrites?: boolean;
  readonly failRead?: boolean;
  /** The credential sync-back's first read: answers (nothing to sync) or never answers. */
  readonly syncBack?: "answers" | "hangs";
}

export const fakeExecWorld = (options: FakeExecWorldOptions = {}) => {
  const sent: SealantExecOptions[] = [];
  /** What happened, in order: `create`, `claim`, `completed`, `failed`, `sync-back`, ... */
  const steps: string[] = [];
  const epochs: Array<{ readonly suspicious: boolean }> = [];
  const hanging = Deferred.makeUnsafe<void>();
  let healthReads = 0;
  let readsFailed = 0;
  let row: Run | undefined;

  const outcomeOf = (exec: SealantExecOptions) =>
    exec.executionId === undefined ? String(options.readExitCode ?? 1) : (exec.args?.[0] ?? "0");

  const session: SealantSession = {
    health: Effect.suspend(() => {
      healthReads += 1;
      return healthReads <= (options.healthFailures ?? 0)
        ? Effect.fail(new TransportError({ operation: "health", message: "not up", cause: 0 }))
        : Effect.succeed(create(HealthReportSchema, { runtimeId: "rt_1" }));
    }),
    capabilities: Effect.succeed(create(CapabilitiesSchema, { supports: [] })),
    exec: (exec) =>
      Effect.suspend((): Effect.Effect<ExecAccepted, SealantError> => {
        sent.push(exec);
        if (exec.executionId === undefined && readsFailed < (options.readFailures ?? 0)) {
          readsFailed += 1;
          return Effect.fail(
            new TransportError({ operation: "exec", message: "bridge closed", cause: 0 }),
          );
        }
        const outcome = outcomeOf(exec);
        if (outcome === "lost") {
          return Effect.fail(
            new TransportError({ operation: "exec", message: "bridge closed", cause: 0 }),
          );
        }
        if (outcome === "refused") {
          return Effect.fail(
            new SealantControlError({ operation: "exec", code: 3, message: "no such file" }),
          );
        }
        return Effect.succeed(
          create(ExecAcceptedSchema, { processId: `proc_${String(sent.length)}`, pid: 7 }),
        );
      }),
    events: Stream.suspend(() => {
      const last = sent.at(-1);
      const processId = `proc_${String(sent.length)}`;
      const outcome = last === undefined ? "0" : outcomeOf(last);
      if (outcome === "hang") {
        return Stream.fromEffect(Deferred.succeed(hanging, undefined)).pipe(
          Stream.flatMap(() => Stream.never),
        );
      }
      return Stream.make(exitedEvent(processId, Number(outcome), last?.executionId));
    }),
    writeStdin: unscripted("writeStdin"),
    closeStdin: unscripted("closeStdin"),
    signalProcess: unscripted("signalProcess"),
    openSession: unscripted("openSession"),
    closeSession: unscripted("closeSession"),
    resizePty: unscripted("resizePty"),
    listSessions: Effect.die("unscripted call listSessions"),
    writeSessionInput: unscripted("writeSessionInput"),
    attachSession: unscripted("attachSession"),
    openForward: unscripted("openForward"),
    closeForward: unscripted("closeForward"),
    bindMount: unscripted("bindMount"),
    captureFlush: unscripted("captureFlush"),
    captureStatus: unscripted("captureStatus"),
    captureReplan: unscripted("captureReplan"),
    dotfilesApply: unscripted("dotfilesApply"),
    shutdown: unscripted("shutdown"),
  };

  const sink: TelemetrySinkService = {
    openEpoch: () => Effect.succeed({ epochId: "tep_1", resumeFromSequence: null }),
    appendBatch: () => Effect.succeed([]),
    insertLossSpan: () => Effect.void,
    closeEpoch: (input) =>
      Effect.sync(() => {
        epochs.push({ suspicious: input.suspicious });
      }),
    getMaxSequence: () => Effect.succeed(null),
    streamRawLog: () => Stream.empty,
  };

  const update = (step: string, change: Partial<Run>) =>
    Effect.sync(() => {
      steps.push(step);
      if (row !== undefined) row = { ...row, ...change };
      return row ?? null;
    });
  const terminal = (step: "markRunCompleted" | "markRunFailed", change: Partial<Run>) =>
    options.failTerminalWrites === true
      ? Effect.sync(() => steps.push(`${step} refused`)).pipe(Effect.andThen(refused(step)))
      : update(step === "markRunCompleted" ? "completed" : "failed", change);
  const runs: RunRepoService = {
    createRun: (input) =>
      options.failCreate === true
        ? refused("createRun")
        : Effect.sync(() => {
            steps.push("create");
            row = newRow(input);
            return row;
          }),
    getRunById: () => (options.failRead === true ? refused("getRunById") : Effect.sync(() => row)),
    listRuns: unscripted("listRuns"),
    markRunRunning: unscripted("markRunRunning"),
    claimRunForExec: () =>
      update("claim", { status: "running" }).pipe(
        Effect.map(
          (run): RunExecClaim =>
            run === null ? { outcome: "not-found" } : { outcome: "claimed", run },
        ),
      ),
    markRunCompleted: (input) =>
      terminal("markRunCompleted", {
        status: "completed",
        exitCode: input.exitCode,
        ...(input.diff === undefined ? {} : { diff: input.diff }),
        ...(input.changedFiles === undefined ? {} : { changedFiles: [...input.changedFiles] }),
      }),
    // As the repository: a settled run is never written over as failed.
    markRunFailed: (input) =>
      row !== undefined && row.status !== "queued" && row.status !== "running"
        ? Effect.sync(() => {
            steps.push("failure write skipped: settled");
            return null;
          })
        : terminal("markRunFailed", {
            status: "failed",
            errorMessage: input.errorMessage ?? null,
            ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
            ...(input.diff === undefined ? {} : { diff: input.diff }),
            ...(input.changedFiles === undefined ? {} : { changedFiles: [...input.changedFiles] }),
          }),
  };

  const attempts: WorkspaceAttemptRepoService = {
    createQueuedAttempt: unscripted("createQueuedAttempt"),
    getAttemptById: unscripted("getAttemptById"),
    getAttemptSnapshotByRunId: () =>
      options.syncBack === "hangs"
        ? Effect.sync(() => steps.push("sync-back")).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => steps.push("sync-back stopped"))),
          )
        : Effect.sync(() => {
            steps.push("sync-back");
            return undefined;
          }),
    setAttemptSnapshot: unscripted("setAttemptSnapshot"),
    markAttemptRunning: unscripted("markAttemptRunning"),
    markAttemptSucceeded: unscripted("markAttemptSucceeded"),
    markAttemptFailed: unscripted("markAttemptFailed"),
    markAttemptCancelled: unscripted("markAttemptCancelled"),
    listAttempts: unscripted("listAttempts"),
  };

  const accounts: ConnectedAccountRepoService = {
    createConnectedAccount: unscripted("createConnectedAccount"),
    getById: unscripted("getById"),
    getByOwnerProviderName: unscripted("getByOwnerProviderName"),
    listByOwner: unscripted("listByOwner"),
    listByOwnerProvider: unscripted("listByOwnerProvider"),
    hasApiKeyHistory: unscripted("hasApiKeyHistory"),
    withOwnerLock: unscripted("withOwnerLock"),
    getDefault: unscripted("getDefault"),
    setDefault: unscripted("setDefault"),
    backfillDefaults: Effect.die("unscripted call backfillDefaults"),
    listActiveByProviderKind: unscripted("listActiveByProviderKind"),
    listKindUnchecked: unscripted("listKindUnchecked"),
    replacePayload: unscripted("replacePayload"),
    updateSyncState: unscripted("updateSyncState"),
    markInvalid: unscripted("markInvalid"),
    claimRefresh: unscripted("claimRefresh"),
    releaseRefresh: unscripted("releaseRefresh"),
    archiveAndClearDefault: unscripted("archiveAndClearDefault"),
    restore: unscripted("restore"),
    setProfileBinding: unscripted("setProfileBinding"),
    clearProfileBinding: unscripted("clearProfileBinding"),
    listProfileBindings: unscripted("listProfileBindings"),
    listBindingsForAccount: unscripted("listBindingsForAccount"),
    getBindingsForProfileWithAccounts: unscripted("getBindingsForProfileWithAccounts"),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(SealantRuntime, {
      connect: () => Effect.succeed(session),
      openForwardConnection: unscripted("openForwardConnection"),
    }),
    Layer.succeed(TelemetrySink, sink),
    Layer.succeed(RunRepo, runs),
    Layer.succeed(WorkspaceAttemptRepo, attempts),
    Layer.succeed(ConnectedAccountRepo, accounts),
  );

  return {
    layer,
    sent,
    steps,
    epochs,
    hanging,
    healthReads: () => healthReads,
    row: () => row,
  };
};

export const FAKE_WORKSPACE_ID = "wks_1";

/**
 * A workspace and its docker executor, launched by `run_launch`, for the paths that resolve a
 * run's runtime from the database. With `ready: false` the executor is not ready; with
 * `answers: false` the workspace's row is never read back.
 */
export const fakeWorkspaceRepos = (
  ownerUserId: string,
  options: { readonly ready?: boolean; readonly answers?: boolean } = {},
) => {
  const workspace: Workspace = {
    id: FAKE_WORKSPACE_ID,
    name: "",
    ownerUserId,
    repositoryId: null,
    repositoryProfileRevisionId: null,
    profileRevisionId: null,
    requestedByUserId: null,
    status: "ready",
    latestRunId: "run_launch",
    expiresAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    archivedAt: null,
    binds: [],
    idempotencyKey: null,
    sshUser: null,
  };
  const instance: WorkspaceRuntimeInstance = {
    runId: "run_launch",
    status: options.ready === false ? "pending" : "ready",
    adapter: "docker",
    resourceId: "container-1",
    launchCredentialInjections: [],
    reference: "container-1",
    endpoint: null,
    errorCode: null,
    errorMessage: null,
    stopReason: null,
    launchedAt: null,
    finishedAt: null,
    removedAt: null,
    runtimeDeadlineAt: null,
    sourceKind: null,
    launchOwner: null,
    launchLeaseExpiresAt: null,
    daemonImage: null,
    daemonRecoveryBoot: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  const workspaces: WorkspaceRepoService = {
    createWorkspace: unscripted("createWorkspace"),
    getWorkspaceByAttemptId: unscripted("getWorkspaceByAttemptId"),
    getWorkspaceById: (id) =>
      options.answers === false
        ? Effect.never
        : Effect.succeed(id === workspace.id ? workspace : undefined),
    getWorkspaceByIdempotencyKey: unscripted("getWorkspaceByIdempotencyKey"),
    linkWorkspaceAttempt: unscripted("linkWorkspaceAttempt"),
    listWorkspaces: unscripted("listWorkspaces"),
    listWorkspaceAttemptLinks: unscripted("listWorkspaceAttemptLinks"),
    setWorkspaceName: unscripted("setWorkspaceName"),
    setWorkspaceBinds: unscripted("setWorkspaceBinds"),
    setWorkspaceSshUser: unscripted("setWorkspaceSshUser"),
    setWorkspaceExpiry: unscripted("setWorkspaceExpiry"),
    setWorkspaceStatus: unscripted("setWorkspaceStatus"),
  };

  const instances: WorkspaceRuntimeInstanceRepoService = {
    upsertRuntimeInstance: unscripted("upsertRuntimeInstance"),
    markExited: unscripted("markExited"),
    markStopRequested: unscripted("markStopRequested"),
    markStopped: unscripted("markStopped"),
    markRemoved: unscripted("markRemoved"),
    getRuntimeInstanceByRunId: () => Effect.succeed(instance),
    listRuntimeInstancesByRunIds: unscripted("listRuntimeInstancesByRunIds"),
    listRunningInstances: unscripted("listRunningInstances"),
    listRetainedLaunches: unscripted("listRetainedLaunches"),
    listStrandedLaunches: unscripted("listStrandedLaunches"),
    adoptStrandedLaunch: unscripted("adoptStrandedLaunch"),
    listUnidentifiedStrandedLaunches: unscripted("listUnidentifiedStrandedLaunches"),
    identifyStrandedLaunch: unscripted("identifyStrandedLaunch"),
    failLostLaunch: unscripted("failLostLaunch"),
    preemptLaunch: unscripted("preemptLaunch"),
    renewLaunchLease: unscripted("renewLaunchLease"),
    listPreservationCandidates: unscripted("listPreservationCandidates"),
    listUnsettledCaptureExecutors: unscripted("listUnsettledCaptureExecutors"),
    listStoppedWithRemains: unscripted("listStoppedWithRemains"),
  };
  return Layer.mergeAll(
    Layer.succeed(WorkspaceRepo, workspaces),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, instances),
  );
};
