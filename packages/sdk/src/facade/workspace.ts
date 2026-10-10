/**
 * The `Workspace` facade — a live, disposable environment as the SDK exposes it. `status()`/`ready()`/
 * `events()` poll the control-plane workspace endpoint; `harness.run()`/`harness.start()` are the
 * server-side execution paths (filled in by the run-execution module). `harness.session()` and the
 * lifecycle verbs are typed now and reject until their endpoints land (Phase 3).
 */
import type {
  WorkspaceRuntime as WireWorkspaceRuntime,
  WorkspaceCaptureDrain as WireWorkspaceCaptureDrain,
  CaptureClassSnaps as WireCaptureClassSnaps,
  CaptureExecutorOrigin,
  WorkspaceCaptureStatus as WireWorkspaceCaptureStatus,
  WorkspaceDetails,
  WorkspaceCredentialHome as WireWorkspaceCredentialHome,
  WorkspaceDetails as WireWorkspaceDetails,
} from "@sealant/api-contracts";
import { sessionArgvIssue } from "@sealant/api-contracts";

import { applyDotfiles } from "../effect/apply-dotfiles.js";
import { execWorkspace } from "../effect/exec-workspace.js";
import {
  bindWorkspaceOp,
  flushWorkspaceCaptureOp,
  getWorkspaceCaptureStatusOp,
  createSessionAsUserOp,
  createSessionOp,
  expireWorkspaceOp,
  clearWorkspaceSshUserOp,
  getSessionOp,
  getWorkspaceOp,
  listSessionsOp,
  replanWorkspaceCaptureOp,
  recoverWorkspaceOp,
  restartWorkspaceOp,
  listWorkspaceCredentialsOp,
  putWorkspaceCredentialsOp,
  releaseWorkspaceCredentialsOp,
  stopWorkspaceOp,
} from "../effect/operations.js";
import { SealantApiError, SealantError, SealantNotImplementedError } from "../errors.js";
import { mapAccountRef } from "../internal/credentials.js";
import { parseTtlSeconds } from "../internal/duration.js";
import { requireProcessUser } from "../internal/process-user.js";
import type {
  Harness,
  HarnessRunner,
  InteractiveSession,
  SessionOptions,
  Workspace,
  WorkspaceEvent,
  WorkspaceForward,
  WorkspaceLaunch,
  WorkspaceRuntimeInfo,
  WorkspaceForwardOptions,
  WorkspaceCredentialHome,
  WorkspaceCredentialsAccountChoice,
  WorkspaceImage,
  WorkspacePhase,
  WorkspaceReadyOptions,
  WorkspaceSessions,
  WorkspaceCaptureDrain,
  WorkspaceCaptureClassSnaps,
  WorkspaceCaptureOrigin,
  WorkspaceCaptureStatus,
  WorkspaceStatus,
  WorkspaceStopOptions,
  WorkspaceStopResult,
} from "../types.js";
import type { SdkContext } from "./context.js";
import { makeInteractiveSession } from "./session.js";

export interface WorkspaceInit {
  readonly id: string;
  readonly name: string;
  readonly status: WorkspaceStatus;
  /** Present when the handle came from `create()` (needed by `harness.run()`). */
  readonly harness?: Harness;
  /**
   * This handle created the workspace (`workspaces.create()`), so a readiness timeout on it is
   * an abandoned launch the SDK owns: `ready()` stops the workspace before it throws.
   */
  readonly created?: boolean;
  /** What the create answered of the launch (run, executor when known, replayed). */
  readonly launch?: WorkspaceLaunch;
  /** `ready()`'s bounds for this handle, from `create()` (see `WorkspaceReadyOptions`). */
  readonly readyTimeoutMs?: number;
  readonly imageBuildTimeoutMs?: number;
}

/** The wire runtime as the SDK reports it. */
export const toRuntimeInfo = (runtime: WireWorkspaceRuntime): WorkspaceRuntimeInfo => ({
  kind: runtime.adapter,
  resourceId: runtime.resourceId,
  reference: runtime.reference,
  status: runtime.status,
  ...(runtime.runId === undefined ? {} : { runId: runtime.runId }),
  ...(runtime.launchId === undefined ? {} : { launchId: runtime.launchId }),
  deadline: runtime.deadline ?? null,
});

// Terminal statuses a workspace can never leave: ready()/events() fail fast (or end the stream)
// on these instead of polling out their deadline. "stopped" is terminal too — a TTL expiry or a
// concurrent stop while ready() polls must surface immediately, not as a 10-minute timeout.
// "retained" too: the executor ended and is kept for recovery; it never becomes ready.
const FAILED_STATUSES = new Set<WorkspaceStatus>(["failed", "cancelled", "stopped", "retained"]);
const READY_POLL_INTERVAL_MS = 2_000;
/**
 * `ready()` looks again soon, then less often: a Docker launch is ready in about four seconds, and
 * a fixed 2 s interval answered up to 2 s after it was (1 s on average) on every launch.
 */
const READY_FIRST_POLL_MS = 100;
const READY_MAX_POLL_MS = 1_000;
/** `ready()`'s default readiness bound: the launch outside an image build (queued, booting). */
export const READY_TIMEOUT_MS = 10 * 60 * 1_000;
/**
 * `ready()` gives up on an image build that reported no new progress for this long, or for the
 * control plane's own stall bound plus `IMAGE_BUILD_STALL_GRACE_MS`, whichever is longer. The
 * control plane fails a stalled build itself; this covers a worker that died mid-build and was
 * never replaced. A build that never reported progress (a builder that reports none, a worker
 * that died before its first write) is given up on this long after it started, unless the caller
 * set `imageBuildTimeoutMs`.
 */
export const IMAGE_BUILD_STALL_GUARD_MS = 20 * 60 * 1_000;
const IMAGE_BUILD_STALL_GRACE_MS = 5 * 60 * 1_000;
const STOP_POLL_INTERVAL_MS = 1_000;
const STOP_TIMEOUT_MS = 60 * 1_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The `harness.run()`/`harness.start()` implementations are injected by the run-execution module to
 * avoid a static dependency cycle (workspace <-> run execution). Until they are registered, both
 * report that the feature is not wired in this build.
 */
export type RunHarnessFn = (
  ctx: SdkContext,
  init: WorkspaceInit,
  prompt: string,
  options?: import("../types.js").RunOptions,
) => Promise<import("../types.js").Run>;

export interface HarnessExecutors {
  /** BLOCKING `harness.run()`: resolves once the run is terminal. */
  readonly run: RunHarnessFn;
  /** NON-BLOCKING `harness.start()`: returns the live handle immediately. */
  readonly start: RunHarnessFn;
}

let harnessExecutors: HarnessExecutors | undefined;
export const registerHarnessExecutors = (executors: HarnessExecutors): void => {
  harnessExecutors = executors;
};

// Launch commands for the built-in harnesses — used when a RE-FETCHED handle (no client harness
// value) opens a harness session; the workspace's own spec names the harness id.
const BUILTIN_LAUNCH_COMMANDS: Record<string, string> = {
  opencode: "opencode",
  codex: "codex",
  "claude-code": "claude",
  pi: "pi",
};

/** Wire → public snaps of one capture class. */
const toClassSnaps = (snaps: WireCaptureClassSnaps): WorkspaceCaptureClassSnaps => ({
  class: snaps.class,
  snapsFailed: snaps.snapsFailed,
  ...(snaps.lastSnapError === undefined ? {} : { lastSnapError: snaps.lastSnapError }),
  ...(snaps.snapFailingSinceUnixMs === undefined
    ? {}
    : { snapFailingSinceUnixMs: snaps.snapFailingSinceUnixMs }),
});

/**
 * Wire → public capture status; `refused` is empty from a control plane that predates it, and
 * every other field the control plane does not send stays absent.
 */
const toCaptureStatus = (status: WireWorkspaceCaptureStatus): WorkspaceCaptureStatus => ({
  epoch: status.epoch,
  worktreeId: status.worktreeId,
  ...(status.headN === undefined ? {} : { headN: status.headN }),
  pending: status.pending,
  stagedBytes: status.stagedBytes,
  uploadedObjects: status.uploadedObjects,
  uploadedBytes: status.uploadedBytes,
  registered: status.registered,
  fenced: status.fenced,
  paused: status.paused,
  ...(status.lastSnapUnixMs === undefined ? {} : { lastSnapUnixMs: status.lastSnapUnixMs }),
  refused: status.refused ?? [],
  ...(status.pendingBytes === undefined ? {} : { pendingBytes: status.pendingBytes }),
  ...(status.pendingBulk === undefined ? {} : { pendingBulk: status.pendingBulk }),
  ...(status.complete === undefined ? {} : { complete: status.complete }),
  ...(status.incompleteReason === undefined ? {} : { incompleteReason: status.incompleteReason }),
  ...(status.unreadable === undefined ? {} : { unreadable: status.unreadable }),
  ...(status.carried === undefined ? {} : { carried: status.carried }),
  ...(status.unreadablePaths === undefined ? {} : { unreadablePaths: status.unreadablePaths }),
  ...(status.registerRefused === undefined ? {} : { registerRefused: status.registerRefused }),
  ...(status.registerRefusedN === undefined ? {} : { registerRefusedN: status.registerRefusedN }),
  ...(status.registerMissing === undefined ? {} : { registerMissing: status.registerMissing }),
  ...(status.registerRefusals === undefined ? {} : { registerRefusals: status.registerRefusals }),
  ...(status.repairing === undefined ? {} : { repairing: status.repairing }),
  ...(status.bulkBuilding === undefined ? {} : { bulkBuilding: status.bulkBuilding }),
  ...(status.snaps === undefined ? {} : { snaps: status.snaps.map(toClassSnaps) }),
  ...(status.lastSnapError === undefined ? {} : { lastSnapError: status.lastSnapError }),
  ...(status.snapFailingSinceUnixMs === undefined
    ? {}
    : { snapFailingSinceUnixMs: status.snapFailingSinceUnixMs }),
  ...(status.snapsFailed === undefined ? {} : { snapsFailed: status.snapsFailed }),
  ...(status.origin === undefined ? {} : { origin: toCaptureOrigin(status.origin) }),
  ...(status.overdue === undefined
    ? {}
    : {
        overdue: {
          step: status.overdue.step,
          startedUnixMs: status.overdue.startedUnixMs,
          runningMs: status.overdue.runningMs,
          boundMs: status.overdue.boundMs,
        },
      }),
  ...(status.ownerMap === undefined ? {} : { ownerMap: status.ownerMap }),
});

/** Wire → public executor-origin position. */
const toCaptureOrigin = (origin: CaptureExecutorOrigin): WorkspaceCaptureOrigin => ({
  epoch: origin.epoch,
  launch: origin.launch,
  bootId: origin.bootId,
  bootGeneration: origin.bootGeneration,
  observation: origin.observation,
  ...(origin.headN === undefined ? {} : { headN: origin.headN }),
});

/** The wire's launch phase. */
type WirePhase = NonNullable<WireWorkspaceDetails["phase"]>;

/** The wire's published image. */
type WirePublishedImage = NonNullable<WireWorkspaceDetails["publishedImage"]>;

/** Wire → public launch phase. */
export const toWorkspacePhase = (phase: WirePhase): WorkspacePhase => ({
  name: phase.name,
  ...(phase.since === undefined ? {} : { since: phase.since }),
  ...(phase.imageBuild === undefined
    ? {}
    : {
        imageBuild: {
          ...(phase.imageBuild.step === undefined ? {} : { step: phase.imageBuild.step }),
          ...(phase.imageBuild.steps === undefined ? {} : { steps: phase.imageBuild.steps }),
          ...(phase.imageBuild.stepName === undefined
            ? {}
            : { stepName: phase.imageBuild.stepName }),
          progressAt: phase.imageBuild.progressAt,
          ...(phase.imageBuild.stallTimeoutMs === undefined
            ? {}
            : { stallTimeoutMs: phase.imageBuild.stallTimeoutMs }),
        },
      }),
});

/** `Building the workspace image (step 2/12: RUN apt-get …)`, `Booting the workspace`. */
export const describeWorkspacePhase = (phase: WorkspacePhase): string => {
  switch (phase.name) {
    case "queued":
      return "Waiting for a worker to take the launch";
    case "boot":
      return "Booting the workspace";
    case "image-build": {
      const build = phase.imageBuild;
      if (build?.step === undefined || build.steps === undefined) {
        return "Building the workspace image";
      }
      return `Building the workspace image (step ${String(build.step)}/${String(build.steps)}${
        build.stepName === undefined ? "" : `: ${build.stepName}`
      })`;
    }
  }
};

/** `at step 2/12 (RUN apt-get …)`, or `before its first step`. */
const describeBuildStep = (phase: WorkspacePhase | undefined): string => {
  const build = phase?.imageBuild;
  if (build?.step === undefined || build.steps === undefined) return "before its first step";
  return `at step ${String(build.step)}/${String(build.steps)}${
    build.stepName === undefined ? "" : ` (${build.stepName})`
  }`;
};

/** Two phases name the same place in the launch (same phase, same build step). */
const samePhaseStep = (a: WorkspacePhase | undefined, b: WorkspacePhase | undefined): boolean =>
  a?.name === b?.name &&
  a?.imageBuild?.step === b?.imageBuild?.step &&
  a?.imageBuild?.steps === b?.imageBuild?.steps;

/** `12 min`, `90 s`. */
const formatWait = (ms: number): string =>
  ms >= 120_000 ? `${String(Math.round(ms / 60_000))} min` : `${String(Math.round(ms / 1000))} s`;

/** Wire → public published image. */
export const toWorkspaceImage = (image: WirePublishedImage): WorkspaceImage => ({
  reference: image.reference,
  digestReference: image.digestReference,
  digest: image.digest,
  ...(image.personLayout === undefined
    ? {}
    : {
        personLayout: {
          ...image.personLayout,
          missing: [...image.personLayout.missing],
          unknown: [...image.personLayout.unknown],
        },
      }),
});

/** Wire → public credential home. */
const toCredentialHome = (home: WireWorkspaceCredentialHome): WorkspaceCredentialHome => ({
  home: home.home,
  onBehalfOf: home.onBehalfOfUserId,
  accounts: {
    ...(home.accounts.claude === undefined ? {} : { claude: { ...home.accounts.claude } }),
    ...(home.accounts.codex === undefined ? {} : { codex: { ...home.accounts.codex } }),
    ...(home.accounts.github === undefined ? {} : { github: { ...home.accounts.github } }),
    ...(home.accounts.pi === undefined ? {} : { pi: { ...home.accounts.pi } }),
    ...(home.accounts.opencode === undefined ? {} : { opencode: { ...home.accounts.opencode } }),
  },
});

/** A provider's choice → its wire value: `null` removes, `false`/absent leaves it out. */
const accountChoice = (
  choice: WorkspaceCredentialsAccountChoice | undefined,
): string | null | undefined => (choice === null ? null : mapAccountRef(choice));

/** Wire → public drain observation. */
const toCaptureDrain = (drain: WireWorkspaceCaptureDrain): WorkspaceCaptureDrain => ({
  state: drain.state,
  ...(drain.executor === undefined
    ? {}
    : {
        executor: {
          runId: drain.executor.runId,
          kind: drain.executor.adapter,
          resourceId: drain.executor.resourceId,
          ...(drain.executor.reference === undefined
            ? {}
            : { reference: drain.executor.reference }),
          ...(drain.executor.launchId === undefined ? {} : { launchId: drain.executor.launchId }),
        },
      }),
  ...(drain.detail === undefined ? {} : { detail: drain.detail }),
  ...(drain.observedAt === undefined ? {} : { observedAt: drain.observedAt }),
  ...(drain.preservationStartsAt === undefined
    ? {}
    : { preservationStartsAt: drain.preservationStartsAt }),
  ...(drain.discard === undefined
    ? {}
    : {
        discard: { requestedBy: drain.discard.requestedBy, requestedAt: drain.discard.requestedAt },
      }),
  ...(drain.retained === undefined
    ? {}
    : {
        retained: {
          since: drain.retained.since,
          reason: drain.retained.reason,
          recoverable: drain.retained.recoverable,
          recoveryAttempts: drain.retained.recoveryAttempts,
          ...(drain.retained.nextRecoveryAt === undefined
            ? {}
            : { nextRecoveryAt: drain.retained.nextRecoveryAt }),
          ...(drain.retained.lastRecoveryError === undefined
            ? {}
            : { lastRecoveryError: drain.retained.lastRecoveryError }),
        },
      }),
  ...(drain.completion === undefined
    ? {}
    : {
        completion: {
          executorId: drain.completion.executorId,
          epoch: drain.completion.epoch,
          captureN: drain.completion.captureN,
          attestedAt: drain.completion.attestedAt,
          ...(drain.completion.launchId === undefined
            ? {}
            : { launchId: drain.completion.launchId }),
          ...(drain.completion.sealedAt === undefined
            ? {}
            : { sealedAt: drain.completion.sealedAt }),
          ...(drain.completion.origin === undefined
            ? {}
            : { origin: toCaptureOrigin(drain.completion.origin) }),
        },
      }),
});

const REASONED_REFUSALS: ReadonlySet<string> = new Set([
  "RequestRefusedError",
  "SessionBadRequestError",
]);

/**
 * A control plane older than this SDK refuses an argument that is empty or untrimmed with an empty
 * `400` (and logs the argument). Said here, where the argv is known, so the caller learns why.
 */
const olderControlPlaneRefusal = (
  argv: readonly string[],
  error: SealantApiError,
): SealantApiError => {
  const relaxed = argv.findIndex(
    (word, index) => index > 0 && (word.length === 0 || word.trim() !== word),
  );
  const message =
    relaxed === -1
      ? "The control plane refused the session with an empty 400 and gave no reason; a control plane older than this SDK does not say which field it refused."
      : `The control plane refused the session with an empty 400. argv[${relaxed}] is empty or has leading or trailing whitespace, and a control plane older than this SDK refuses such an argument; upgrade the control plane.`;
  return new SealantApiError(message, {
    code: error.code,
    ...(error.status === undefined ? {} : { status: error.status }),
    cause: error,
  });
};

export const makeWorkspace = (ctx: SdkContext, init: WorkspaceInit): Workspace => {
  const openSession = async (
    argv: readonly string[],
    options?: SessionOptions,
  ): Promise<InteractiveSession> => {
    // The contract's own rule, checked before anything is asked, with the same value-free reason.
    const refused = sessionArgvIssue(argv);
    if (refused !== undefined) throw new SealantError(refused, { code: "invalid_argv" });
    if (options?.user !== undefined) await requireProcessUser(ctx, options.user);
    const request = {
      workspaceId: init.id,
      ownerUserId: ctx.config.hostLocal.ownerUserId,
      argv: [...argv],
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options?.env === undefined ? {} : { env: options.env }),
      ...(options?.cols === undefined ? {} : { cols: options.cols }),
      ...(options?.rows === undefined ? {} : { rows: options.rows }),
      ...(options?.term === undefined ? {} : { term: options.term }),
      ...(options?.mode === undefined ? {} : { mode: options.mode }),
      ...(options?.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
    };
    // As a user: its own route, so a control plane that cannot open one answers 404, never opens
    // it as the workspace's own user.
    const created = await ctx.runtime
      .run(
        options?.user === undefined
          ? createSessionOp(request)
          : createSessionAsUserOp({ ...request, user: options.user }),
      )
      .catch((error: unknown) => {
        // A control plane with the rule answers a typed 400 with its reason (`RequestRefusedError`
        // for a request it cannot decode, `SessionBadRequestError` for one it refuses); an empty
        // 400 is one from before it.
        if (
          error instanceof SealantApiError &&
          error.status === 400 &&
          !REASONED_REFUSALS.has(error.code)
        ) {
          throw olderControlPlaneRefusal(argv, error);
        }
        throw error;
      });
    return makeInteractiveSession(ctx, created);
  };

  const sessions: WorkspaceSessions = {
    open: (argv, options) => openSession(argv, options),

    get: async (sessionId) => {
      const wire = await ctx.runtime.run(getSessionOp(sessionId, ctx.config.hostLocal.ownerUserId));
      if (wire.workspaceId !== init.id) {
        throw new SealantError(`Session ${sessionId} does not belong to workspace ${init.id}.`, {
          code: "session_not_found",
        });
      }
      return makeInteractiveSession(ctx, wire);
    },

    list: async () => {
      const response = await ctx.runtime.run(
        listSessionsOp({
          ownerUserId: ctx.config.hostLocal.ownerUserId,
          workspaceId: init.id,
        }),
      );
      return response.items.map((item) => makeInteractiveSession(ctx, item));
    },
  };

  /** The harness's interactive launch argv — client value when present, else from the spec. */
  const resolveHarnessLaunchArgv = async (): Promise<readonly string[]> => {
    if (init.harness !== undefined) {
      return [init.harness.launchCommand ?? init.harness.id];
    }
    const details = await ctx.runtime.run(
      getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
    );
    const spec = details.spec as { harness?: { id?: string } } | undefined;
    const harnessId = spec?.harness?.id;
    if (harnessId === undefined) {
      throw new SealantError(
        `Workspace ${init.id} has no harness in its spec; open a session with workspace.sessions.open(argv) instead.`,
        { code: "harness_required" },
      );
    }
    return [BUILTIN_LAUNCH_COMMANDS[harnessId] ?? harnessId];
  };

  const harness: HarnessRunner = {
    run: (prompt, options) => {
      if (harnessExecutors === undefined) {
        return Promise.reject(
          new SealantNotImplementedError("harness.run (run execution not wired in this build)"),
        );
      }
      return harnessExecutors.run(ctx, init, prompt, options);
    },
    start: (prompt, options) => {
      if (harnessExecutors === undefined) {
        return Promise.reject(
          new SealantNotImplementedError("harness.start (run execution not wired in this build)"),
        );
      }
      return harnessExecutors.start(ctx, init, prompt, options);
    },
    session: async (options) => {
      const argv = await resolveHarnessLaunchArgv();
      return openSession(argv, options);
    },
  };

  const readCaptureStatus = async (): Promise<WorkspaceCaptureStatus> =>
    toCaptureStatus(
      await ctx.runtime.run(
        getWorkspaceCaptureStatusOp(init.id, { ownerUserId: ctx.config.hostLocal.ownerUserId }),
      ),
    );

  /** Ask the control plane to stop the workspace; true once the request was accepted. */
  const requestStop = async (): Promise<boolean> => {
    try {
      await ctx.runtime.run(
        stopWorkspaceOp(init.id, { ownerUserId: ctx.config.hostLocal.ownerUserId }),
      );
      return true;
    } catch {
      return false;
    }
  };

  // What the handle knows of its launch; `ready()` adds the executor it saw become ready.
  let launch: WorkspaceLaunch | undefined = init.launch;

  const workspace: Workspace = {
    id: init.id,
    name: init.name,

    get launch() {
      return launch;
    },

    runtime: async () => {
      const details: WorkspaceDetails = await ctx.runtime.run(
        getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
      );
      return details.runtime === undefined ? null : toRuntimeInfo(details.runtime);
    },

    image: async () => {
      const details: WorkspaceDetails = await ctx.runtime.run(
        getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
      );
      return details.publishedImage === undefined ? null : toWorkspaceImage(details.publishedImage);
    },

    processUser: async () => {
      const details: WorkspaceDetails = await ctx.runtime.run(
        getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
      );
      return details.processUser ?? "unknown";
    },

    status: async () => {
      const details: WorkspaceDetails = await ctx.runtime.run(
        getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
      );
      return details.status;
    },

    runtimeDeadline: async () => {
      const details: WorkspaceDetails = await ctx.runtime.run(
        getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
      );
      return details.runtime?.deadline ?? null;
    },

    phase: async () => {
      const details: WorkspaceDetails = await ctx.runtime.run(
        getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
      );
      return details.phase === undefined ? null : toWorkspacePhase(details.phase);
    },

    ready: async (options?: WorkspaceReadyOptions) => {
      // Bounded by phase: the readiness bound is spent only outside an image build (queued,
      // booting), so a first launch on a new image is not failed by a slow package mirror. The
      // build has its own bound (none by default) and fails when it stops making progress. A
      // control plane that reports no phase counts everything against the readiness bound.
      const readyTimeoutMs = options?.readyTimeoutMs ?? init.readyTimeoutMs ?? READY_TIMEOUT_MS;
      const imageBuildTimeoutMs = options?.imageBuildTimeoutMs ?? init.imageBuildTimeoutMs;
      for (const [name, value] of [
        ["readyTimeoutMs", readyTimeoutMs],
        ["imageBuildTimeoutMs", imageBuildTimeoutMs],
      ] as const) {
        if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
          throw new SealantError(`${name} must be a positive number of milliseconds.`, {
            code: "invalid_options",
          });
        }
      }
      const startedAt = Date.now();
      let buildMs = 0;
      let lastPollAt = startedAt;
      let building = false;
      // The build's last reported output, and when THIS client saw it change: the stall guard
      // runs on the client's own clock, never on the control plane's timestamps.
      let progressAt: string | undefined;
      let progressSeenAt = startedAt;
      let wait = READY_FIRST_POLL_MS;

      /** Give up on the launch: stop it when this handle created it, then throw. */
      const giveUp = async (message: string, code: string): Promise<never> => {
        // A workspace this handle created and nobody will ever use: request a stop, so its
        // runtime does not keep running (and billing) to the platform's lifetime cap.
        // Best-effort: the bound is what the caller must see, whatever the request answers.
        // The request being accepted is all that is known — not that anything has stopped.
        const accepted = init.created === true ? await requestStop() : undefined;
        throw new SealantError(
          `${message}${
            accepted === undefined
              ? ""
              : accepted
                ? " A stop was requested; the workspace has not been observed stopped."
                : " Requesting a stop failed; stop it yourself."
          }`,
          { code },
        );
      };

      for (;;) {
        const details: WorkspaceDetails = await ctx.runtime.run(
          getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
        );
        const now = Date.now();
        // The time since the last look was spent building when the last look saw a build.
        if (building) buildMs += now - lastPollAt;
        lastPollAt = now;
        // Gate on the coarse "ready" status, which the control plane now emits ONLY after the
        // in-workspace daemon's control socket is accepting (readiness probe in the launch path).
        // This is honest: when ready() resolves, harness.run() can connect without racing the socket.
        if (details.status === "ready") {
          if (launch !== undefined) {
            launch = {
              ...launch,
              ...(details.runtime === undefined ? {} : { runtime: toRuntimeInfo(details.runtime) }),
              ...(details.publishedImage === undefined
                ? {}
                : { image: toWorkspaceImage(details.publishedImage) }),
              ...(details.processUser === undefined ? {} : { processUser: details.processUser }),
            };
          }
          return workspace;
        }
        if (FAILED_STATUSES.has(details.status)) {
          const reason = details.error === undefined ? "" : `: ${details.error.message}`;
          throw new SealantError(
            `Workspace ${init.id} reached terminal status "${details.status}" before becoming ready${reason}`,
            {
              code:
                details.error?.code === "image-build-stalled"
                  ? "workspace_image_build_stalled"
                  : details.error?.code === "image-build-timeout"
                    ? "workspace_image_build_timeout"
                    : "workspace_not_ready",
            },
          );
        }

        const phase = details.phase === undefined ? undefined : toWorkspacePhase(details.phase);
        const wasBuilding = building;
        building = phase?.name === "image-build";
        if (building) {
          // The stall clock runs from when this client first saw the build, and restarts each
          // time the build reports new progress. A reclaimed build reports none until its new
          // worker writes: that does not restart it, so workers that keep dying before their first
          // write are given up on too.
          if (!wasBuilding) {
            progressAt = undefined;
            progressSeenAt = now;
          }
          const reported = phase?.imageBuild?.progressAt;
          if (reported !== undefined && reported !== progressAt) {
            progressAt = reported;
            progressSeenAt = now;
          }
          if (imageBuildTimeoutMs !== undefined && buildMs > imageBuildTimeoutMs) {
            await giveUp(
              `The image build for workspace ${init.id} took longer than ${formatWait(imageBuildTimeoutMs)} (imageBuildTimeoutMs); it was ${describeBuildStep(phase)}.`,
              "workspace_image_build_timeout",
            );
          }
          // A build that reports progress is given up on once it stops (past the control plane's
          // own stall bound, which should have failed it). One that never reported any (a builder
          // that reports none, or a worker that died before its first write) is given up on after
          // IMAGE_BUILD_STALL_GUARD_MS, unless the caller bounded the build itself.
          const stallBoundMs =
            progressAt === undefined
              ? imageBuildTimeoutMs === undefined
                ? IMAGE_BUILD_STALL_GUARD_MS
                : undefined
              : Math.max(
                  IMAGE_BUILD_STALL_GUARD_MS,
                  (phase?.imageBuild?.stallTimeoutMs ?? 0) + IMAGE_BUILD_STALL_GRACE_MS,
                );
          if (stallBoundMs !== undefined && now - progressSeenAt > stallBoundMs) {
            await giveUp(
              progressAt === undefined
                ? `The image build for workspace ${init.id} reported no progress in the ${formatWait(now - progressSeenAt)} since it started (its builder reports none, or its worker stopped); pass imageBuildTimeoutMs to wait longer for a builder that reports none.`
                : `The image build for workspace ${init.id} reported no progress for ${formatWait(now - progressSeenAt)}; it was ${describeBuildStep(phase)}.`,
              "workspace_image_build_stalled",
            );
          }
        } else {
          progressAt = undefined;
          if (now - startedAt - buildMs > readyTimeoutMs) {
            await giveUp(
              `Timed out waiting for workspace ${init.id} to become ready${
                phase === undefined ? "" : ` (${describeWorkspacePhase(phase).toLowerCase()})`
              }.`,
              "workspace_ready_timeout",
            );
          }
        }
        await delay(wait);
        wait = Math.min(wait * 2, READY_MAX_POLL_MS);
      }
    },

    harness,

    sessions,

    exec: async (argv, options) => {
      if (options?.user !== undefined) await requireProcessUser(ctx, options.user);
      return execWorkspace(ctx, init, argv, options);
    },

    bind: async (options) => {
      const result = await ctx.runtime.run(
        bindWorkspaceOp(init.id, {
          ownerUserId: ctx.config.hostLocal.ownerUserId,
          ...(options.mountPath === undefined ? {} : { mountPath: options.mountPath }),
          subpath: options.subpath,
        }),
      );
      return result.binds.map((bind) => ({ mountPath: bind.mountPath, subpath: bind.subpath }));
    },

    capture: {
      flush: async (options = {}) =>
        toCaptureStatus(
          await ctx.runtime.run(
            flushWorkspaceCaptureOp(init.id, {
              ownerUserId: ctx.config.hostLocal.ownerUserId,
              ...(options.kind === undefined ? {} : { kind: options.kind }),
              ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
              ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
            }),
          ),
        ),
      status: () => readCaptureStatus(),
      replan: async (options = {}) => {
        const expected = options.expectedOwnerMap;
        const result = await ctx.runtime.run(
          replanWorkspaceCaptureOp(init.id, {
            ownerUserId: ctx.config.hostLocal.ownerUserId,
            ...(expected === undefined
              ? {}
              : {
                  expectedOwnerMap:
                    expected === null
                      ? null
                      : {
                          gid: expected.gid,
                          worktreeUid: expected.worktreeUid,
                          people: expected.people.map(({ id, uid }) => ({ id, uid })),
                        },
                }),
          }),
        );
        return {
          worktreeId: result.worktreeId,
          epoch: result.epoch,
          ...(result.headN === undefined ? {} : { headN: result.headN }),
          ...(result.headCaptureId === undefined ? {} : { headCaptureId: result.headCaptureId }),
          filesWritten: result.filesWritten,
          bytesWritten: result.bytesWritten,
          filesSkipped: result.filesSkipped,
          bytesSkipped: result.bytesSkipped,
          removed: result.removed,
          unchanged: result.unchanged,
        };
      },
    },

    // Poll-backed lifecycle stream: emit a coarse event on each status transition until the workspace
    // reaches a terminal/ready state. Swaps to SSE over Postgres LISTEN/NOTIFY in Stage 5 (same shape).
    events: () => {
      const ctxRun = ctx.runtime;
      async function* iterate(): AsyncGenerator<WorkspaceEvent> {
        let lastStatus: WorkspaceStatus | undefined;
        let lastPhase: WorkspacePhase | undefined;
        // The stream ends with the launch; this bounds it on a launch that never settles. It
        // follows a build as long as the build is moving, like ready().
        let deadline = Date.now() + READY_TIMEOUT_MS;
        for (;;) {
          const details = await ctxRun.run(
            getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
          );
          if (details.status !== lastStatus) {
            lastStatus = details.status;
            yield {
              type: `status.${details.status}`,
              occurredAt: new Date().toISOString(),
              message: `Workspace status: ${details.status}`,
            };
          }
          const phase = details.phase === undefined ? undefined : toWorkspacePhase(details.phase);
          if (phase !== undefined && !samePhaseStep(phase, lastPhase)) {
            yield {
              type: `phase.${phase.name}`,
              occurredAt: new Date().toISOString(),
              message: describeWorkspacePhase(phase),
              phase,
            };
          }
          if (
            phase?.name === "image-build" &&
            phase.imageBuild?.progressAt !== lastPhase?.imageBuild?.progressAt
          ) {
            deadline = Date.now() + Math.max(READY_TIMEOUT_MS, IMAGE_BUILD_STALL_GUARD_MS);
          }
          lastPhase = phase;
          if (details.status === "ready" || FAILED_STATUSES.has(details.status)) {
            return;
          }
          if (Date.now() > deadline) {
            return;
          }
          await delay(READY_POLL_INTERVAL_MS);
        }
      }
      return iterate();
    },

    // BLOCKING stop: the control plane accepts the stop (202) and the worker tears the runtime
    // down — after draining a capture-sourced workspace's unsaved captures, which can take
    // minutes. Resolves "stopped" only once the workspace reports it; past the wait it reports
    // what the control plane last OBSERVED of the drain (`captureDrain`: draining or kept), and
    // otherwise that the stop was requested. A reachable capture queue is not an observation of
    // a drain (a refused or abandoned drain answers too), so it never decides the state.
    stop: async (options?: WorkspaceStopOptions): Promise<WorkspaceStopResult> => {
      const ownerUserId = ctx.config.hostLocal.ownerUserId;
      const accepted = await ctx.runtime.run(
        stopWorkspaceOp(init.id, {
          ownerUserId,
          ...(options?.discardUnsaved === true ? { discardUnsaved: true } : {}),
          ...(options?.completion === undefined
            ? {}
            : {
                completion: {
                  captureN: options.completion.captureN,
                  epoch: options.completion.epoch,
                  executorId: options.completion.executorId,
                  ...(options.completion.launchId === undefined
                    ? {}
                    : { launchId: options.completion.launchId }),
                  ...(options.completion.sealedAt === undefined
                    ? {}
                    : { sealedAt: options.completion.sealedAt }),
                  ...(options.completion.origin === undefined
                    ? {}
                    : { origin: toCaptureOrigin(options.completion.origin) }),
                },
              }),
        }),
      );
      const completion =
        accepted.completion === undefined
          ? {}
          : {
              completion: {
                outcome: accepted.completion.outcome,
                ...(accepted.completion.detail === undefined
                  ? {}
                  : { detail: accepted.completion.detail }),
              },
            };

      const deadline = Date.now() + STOP_TIMEOUT_MS;
      for (;;) {
        const details: WorkspaceDetails = await ctx.runtime.run(
          getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
        );
        // `cancelled`: a stop before the image was built cancelled the launch; no runtime ever ran.
        if (details.status === "stopped" || details.status === "cancelled") {
          return { state: "stopped", ...completion };
        }
        if (
          details.status === "retained" &&
          options?.discardUnsaved !== true &&
          accepted.completion?.outcome !== "accepted" &&
          details.captureDrain !== undefined
        ) {
          // Observed: the executor ended and is kept for recovery; this stop does not remove it
          // (only a discard or an accepted completion would), so there is nothing to wait for.
          const capture = await readCaptureStatus().catch(() => undefined);
          return {
            state: "kept",
            drain: toCaptureDrain(details.captureDrain),
            ...(capture === undefined ? {} : { capture }),
            ...completion,
          };
        }
        if (Date.now() > deadline) {
          const drain =
            details.captureDrain === undefined ? undefined : toCaptureDrain(details.captureDrain);
          const capture = await readCaptureStatus().catch(() => undefined);
          const extras = { ...(capture === undefined ? {} : { capture }), ...completion };
          if (drain !== undefined && (drain.state === "draining" || drain.state === "kept")) {
            return { state: drain.state, drain, ...extras };
          }
          return { state: "requested", ...(drain === undefined ? {} : { drain }), ...extras };
        }
        await delay(STOP_POLL_INTERVAL_MS);
      }
    },

    // The drain and retention as last observed, from the workspace read: nothing is stopped.
    captureDrain: async () => {
      const details: WorkspaceDetails = await ctx.runtime.run(
        getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
      );
      return details.captureDrain === undefined ? null : toCaptureDrain(details.captureDrain);
    },

    // Recover makes a recovery attempt of a retained executor due now; the worker does the rest.
    recover: async () => {
      const answered = await ctx.runtime.run(
        recoverWorkspaceOp(init.id, { ownerUserId: ctx.config.hostLocal.ownerUserId }),
      );
      return {
        state: answered.state,
        ...(answered.recoverable === undefined ? {} : { recoverable: answered.recoverable }),
      };
    },

    // Restart drives a fresh launch (new attempt, new container, same resolved spec) and returns a
    // handle that resolves readiness against the NEW runtime via the usual ready() gate.
    restart: async () => {
      const ownerUserId = ctx.config.hostLocal.ownerUserId;
      await ctx.runtime.run(restartWorkspaceOp(init.id, { ownerUserId }));
      return makeWorkspace(ctx, {
        id: init.id,
        name: init.name,
        status: "queued",
        ...(init.harness === undefined ? {} : { harness: init.harness }),
        ...(init.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: init.readyTimeoutMs }),
        ...(init.imageBuildTimeoutMs === undefined
          ? {}
          : { imageBuildTimeoutMs: init.imageBuildTimeoutMs }),
      });
    },

    // People's logins, one person per home; the workspace stays the client owner's.
    credentials: {
      put: async (options) => {
        const choices = {
          claude: accountChoice(options.claude),
          codex: accountChoice(options.codex),
          github: accountChoice(options.github),
          pi: accountChoice(options.pi),
          opencode: accountChoice(options.opencode),
        };
        const answered = await ctx.runtime.run(
          putWorkspaceCredentialsOp(init.id, {
            ownerUserId: ctx.config.hostLocal.ownerUserId,
            onBehalfOfUserId: options.onBehalfOf,
            home: options.home,
            ...(options.uid === undefined ? {} : { uid: options.uid }),
            ...(options.gid === undefined ? {} : { gid: options.gid }),
            ...(choices.claude === undefined ? {} : { claude: choices.claude }),
            ...(choices.codex === undefined ? {} : { codex: choices.codex }),
            ...(choices.github === undefined ? {} : { github: choices.github }),
            ...(choices.pi === undefined ? {} : { pi: choices.pi }),
            ...(choices.opencode === undefined ? {} : { opencode: choices.opencode }),
            ...(options.partial === true ? { partial: true } : {}),
          }),
        );
        return {
          ...toCredentialHome(answered.home),
          skipped: (answered.skipped ?? []).map((skip) => ({
            provider: skip.provider,
            reason: skip.code,
            message: skip.message,
          })),
        };
      },
      release: async (home) => {
        const answered = await ctx.runtime.run(
          releaseWorkspaceCredentialsOp(init.id, {
            ownerUserId: ctx.config.hostLocal.ownerUserId,
            home,
          }),
        );
        return { released: answered.released };
      },
      list: async () => {
        const answered = await ctx.runtime.run(
          listWorkspaceCredentialsOp(init.id, { ownerUserId: ctx.config.hostLocal.ownerUserId }),
        );
        return answered.homes.map(toCredentialHome);
      },
    },

    // A person's dotfiles, applied as their user into their home.
    dotfiles: {
      apply: (options) => applyDotfiles(ctx, init, options),
    },

    // expire({in: "2h"}) sets the TTL, expire() expires now (the platform reaper stops it on its
    // next tick), expire({in: null}) clears the TTL. Resolves once the expiry is recorded.
    expire: async (options) => {
      const ownerUserId = ctx.config.hostLocal.ownerUserId;
      const ttl = options?.in;
      await ctx.runtime.run(
        expireWorkspaceOp(init.id, {
          ownerUserId,
          ...(ttl === undefined ? {} : { ttlSeconds: ttl === null ? null : parseTtlSeconds(ttl) }),
        }),
      );
    },

    sshAsRoot: async () => {
      await ctx.runtime.run(
        clearWorkspaceSshUserOp(init.id, { ownerUserId: ctx.config.hostLocal.ownerUserId }),
      );
    },

    forward: (port, options) => openForward(ctx, init.id, port, options),
  };

  return workspace;
};

/**
 * Open the held-WebSocket port forward (the byte-pipe data plane, mirroring
 * the session attachment): binary frames are payload bytes in both
 * directions; text frames are control JSON — `{"t":"eof"}` up for half-close,
 * `{"t":"end"}` down when the remote closes. Auth rides the connect
 * (`?token=` / `?ownerUserId=`), never per frame. The server refuses the
 * upgrade with a plain HTTP status when nothing listens on the port, which
 * surfaces here as the connect rejection.
 */
const openForward = (
  ctx: SdkContext,
  workspaceId: string,
  port: number,
  options?: WorkspaceForwardOptions,
): Promise<WorkspaceForward> => {
  const config = ctx.config;
  const url = new URL(`/v1/workspaces/${workspaceId}/forward`, config.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("port", String(port));
  if (options?.host !== undefined) {
    url.searchParams.set("host", options.host);
  }
  if (options?.protocol === "udp") {
    url.searchParams.set("protocol", "udp");
  }
  // The owner assertion always rides the URL (a service principal needs it alongside its
  // key, and WebSocket cannot carry headers — same contract as the session attach).
  url.searchParams.set("ownerUserId", config.hostLocal.ownerUserId);
  if (config.apiKey !== undefined) {
    url.searchParams.set("token", config.apiKey);
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    // Push-queue bridging WS message events to the pull-based async iterable.
    const pending: Uint8Array[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    const closedResolver = Promise.withResolvers<"end" | "closed">();
    const closed = closedResolver.promise;
    const finish = (reason: "end" | "closed") => {
      if (finished) {
        return;
      }
      finished = true;
      closedResolver.resolve(reason);
      wake?.();
    };

    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const frame = JSON.parse(event.data) as { t?: string };
          if (frame.t === "end") {
            finish("end");
          }
        } catch {
          // Unknown text frame — ignore.
        }
        return;
      }
      pending.push(new Uint8Array(event.data as ArrayBuffer));
      wake?.();
    });
    ws.addEventListener("close", () => finish("closed"));

    const output: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          for (;;) {
            const chunk = pending.shift();
            if (chunk !== undefined) {
              return { done: false, value: chunk };
            }
            if (finished) {
              return { done: true, value: undefined };
            }
            await new Promise<void>((r) => {
              wake = r;
            });
            wake = undefined;
          }
        },
      }),
    };

    const forward: WorkspaceForward = {
      send: (input) => {
        // Copy into a plain ArrayBuffer-backed view (WebSocket.send rejects SharedArrayBuffer views).
        ws.send(new Uint8Array(input).buffer);
      },
      eof: () => {
        ws.send(JSON.stringify({ t: "eof" }));
      },
      output,
      closed,
      close: () => {
        finish("closed");
        ws.close();
      },
    };

    ws.addEventListener("open", () => resolve(forward), { once: true });
    ws.addEventListener(
      "error",
      () =>
        reject(
          new Error(
            `workspace forward failed: could not connect to ${url.host} (is anything listening on 127.0.0.1:${port} in the workspace?)`,
          ),
        ),
      { once: true },
    );
  });
};
