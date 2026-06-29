/**
 * Server-side harness run execution — the worker counterpart of what the SDK used to do host-local.
 *
 * Given a run id + the harness command, it: resolves the sandbox's docker container, marks the run
 * running, resolves+injects any forwarded credentials (spec.runtime.credentialRefs) into the harness
 * process, docker-execs the harness over the sealantd control connection while draining its telemetry
 * into the {@link TelemetrySink} (bounded to the harness process, epoch bracketed + suspicious-flagged
 * on a dropped bridge), captures the git diff, and marks the run completed/failed with the changes.
 *
 * Lives in the worker app (not @sealant/sandboxes) because it needs @sealant/telemetry, which already
 * depends on @sealant/sandboxes — putting it in sandboxes would be a dependency cycle.
 */
import {
  type DB,
  makeEnvKeyProvider,
  PrincipalCredentialRepo,
  PrincipalCredentialRepoLive,
  type RunFileChange,
  RunRepo,
  RunRepoLive,
  SandboxAttemptRepo,
  SandboxAttemptRepoLive,
  SandboxRepo,
  SandboxRepoLive,
  SandboxRuntimeInstanceRepo,
  SandboxRuntimeInstanceRepoLive,
  SealantDB,
} from "@sealant/db";
import {
  type CredentialInjectables,
  execInSandbox,
  resolveCredentialInjectables,
  type RunExecCommand,
  SealantRuntime,
  SealantRuntimeDockerExecLive,
  type SealantSession,
  sealantTargetForDockerContainer,
  type SealantTarget,
} from "@sealant/sandboxes";
import {
  InlineByteaArtifactStoreLive,
  normalizeEnvelope,
  PostgresTelemetrySinkLive,
  TelemetrySink,
} from "@sealant/telemetry";
import { Effect, Layer, Schedule, Stream } from "effect";

import { env } from "../runtime-env.js";

const WORKDIR = "/sandbox/repo";
const BATCH_SIZE = 256;
const BATCH_WINDOW = "250 millis";
/** In-container path of the sourced env-file holding forwarded credential env vars (0600). */
const HARNESS_ENV_FILE = "/run/sealant/harness.env";
// The docker-exec/socat bridge can flake while a freshly-launched daemon's socket comes up; retry the
// connect+health+exec unit with a spaced window. exec resolves on process-accept, so retry can't
// double-run the harness.
const BRIDGE_RETRY = { schedule: Schedule.spaced("400 millis"), times: 10 };

const EMPTY_INJECTABLES: CredentialInjectables = { env: {}, files: [] };

export interface ProcessRunExecJobOptions {
  readonly runId: string;
  readonly command: RunExecCommand;
  readonly db: DB;
}

const parseNameStatus = (output: string): RunFileChange[] => {
  const files: RunFileChange[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    const code = parts[0] ?? "";
    const change: RunFileChange["change"] = code.startsWith("A")
      ? "added"
      : code.startsWith("D")
        ? "deleted"
        : code.startsWith("R")
          ? "renamed"
          : "modified";
    const path = parts.slice(1).join(" ");
    if (path.length > 0) {
      files.push({ path, change });
    }
  }
  return files;
};

const shellExec = (target: SealantTarget, script: string) =>
  execInSandbox(target, { executable: "sh", args: ["-lc", script], cwd: WORKDIR }).pipe(
    Effect.retry(BRIDGE_RETRY),
  );

/** Single-quote-escape a string for safe inclusion in an `sh -lc` script. */
const shq = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Write `content` to `path` (0`mode`) inside the sandbox WITHOUT the bytes ever appearing in argv or
 * the telemetry event log: the script reads exactly N bytes from stdin (`head -c N`, which exits on
 * its own once N bytes arrive — no stdin-close needed), and the bytes travel over writeStdin. Best-
 * effort (bounded + ignored): a failed materialization leaves the harness unauthenticated, never stuck.
 */
const writeFileViaStdin = (
  session: SealantSession,
  path: string,
  mode: string,
  content: string,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode(content);
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const script = `umask 077; mkdir -p ${shq(dir)}; head -c ${bytes.length} > ${shq(path)}; chmod ${mode} ${shq(path)}`;
    const accepted = yield* session.exec({
      executable: "sh",
      args: ["-lc", script],
      cwd: WORKDIR,
      stdin: true,
    });
    const awaitExit = session.events.pipe(
      Stream.takeUntil(
        (event) =>
          event.payload.case === "processExited" && event.processId === accepted.processId,
      ),
      Stream.runDrain,
    );
    yield* Effect.all([awaitExit, session.writeStdin(accepted.processId, bytes)], {
      concurrency: "unbounded",
    });
  }).pipe(Effect.timeout("10 seconds"), Effect.ignore);

/**
 * Materialize forwarded credentials into the running sandbox. Files land at their native paths; env
 * tokens go into a 0600 env-file the harness wrapper sources (so they reach the harness process only,
 * never container-wide env which sealantd strips). Returns the env-file path when env was written.
 */
const injectCredentials = (
  session: SealantSession,
  injectables: CredentialInjectables,
): Effect.Effect<string | undefined, never> =>
  Effect.gen(function* () {
    for (const file of injectables.files) {
      yield* writeFileViaStdin(session, file.path, file.mode, file.content);
    }
    const keys = Object.keys(injectables.env);
    if (keys.length === 0) {
      return undefined;
    }
    const body = `${keys.map((key) => `export ${key}=${shq(injectables.env[key]!)}`).join("\n")}\n`;
    yield* writeFileViaStdin(session, HARNESS_ENV_FILE, "600", body);
    return HARNESS_ENV_FILE;
  });

/** Build the harness exec, wrapped to source the credential env-file when one was materialized. */
const harnessExecOptions = (command: RunExecCommand, envFile: string | undefined) =>
  envFile === undefined
    ? { executable: command.executable, args: [...command.args], cwd: WORKDIR, stdin: false }
    : {
        executable: "sh",
        // `exec "$@"` replaces the shell with the harness (same pid → processExited still fires for it).
        args: [
          "-lc",
          `set -a; . ${shq(envFile)}; set +a; exec "$@"`,
          "sh",
          command.executable,
          ...command.args,
        ],
        cwd: WORKDIR,
        stdin: false,
      };

/** Execs the harness (after injecting creds) and records its telemetry, bounded to the harness process. */
const captureRun = (
  runId: string,
  target: SealantTarget,
  command: RunExecCommand,
  injectables: CredentialInjectables,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* SealantRuntime;
      const sink = yield* TelemetrySink;

      const { session, runtimeId, accepted } = yield* runtime.connect(target).pipe(
        Effect.flatMap((connected) =>
          Effect.gen(function* () {
            const health = yield* connected.health;
            const envFile = yield* injectCredentials(connected, injectables);
            const started = yield* connected.exec(harnessExecOptions(command, envFile));
            return { session: connected, runtimeId: health.runtimeId, accepted: started };
          }),
        ),
        Effect.retry(BRIDGE_RETRY),
      );

      yield* sink.openEpoch({ runId, runtimeId, schemaVersion: 0 });

      let exitCode = -1;
      const drain = session.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.payload.case === "processExited" && event.processId === accepted.processId,
        ),
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.payload.case === "processExited" && event.processId === accepted.processId) {
              exitCode = event.payload.value.exitCode ?? -1;
            }
          }),
        ),
        Stream.groupedWithin(BATCH_SIZE, BATCH_WINDOW),
        Stream.mapEffect((batch) =>
          sink.appendBatch({ runId, runtimeId, batch: Array.from(batch).map(normalizeEnvelope) }),
        ),
        Stream.runDrain,
      );

      yield* drain.pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            sink
              .closeEpoch({
                runId,
                runtimeId,
                closeReason: exitCode === -1 ? "transport-close" : "stream-end",
                suspicious: exitCode === -1,
              })
              .pipe(Effect.ignore),
          ),
        ),
      );
      return exitCode;
    }),
  );

const resolveContainerResourceId = (runId: string) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const sandboxes = yield* SandboxRepo;
    const runtimeInstances = yield* SandboxRuntimeInstanceRepo;

    const run = yield* runs.getRunById(runId);
    if (run === undefined) {
      return yield* Effect.fail(new Error(`Run not found: ${runId}`));
    }
    const sandbox = yield* sandboxes.getSandboxById(run.sandboxId);
    if (sandbox === undefined || sandbox.latestRunId === null) {
      return yield* Effect.fail(
        new Error(`Sandbox ${run.sandboxId} has no active attempt for run ${runId}.`),
      );
    }
    const instance = yield* runtimeInstances.getRuntimeInstanceByRunId(sandbox.latestRunId);
    if (instance === undefined || instance.adapter !== "docker" || instance.resourceId === null) {
      return yield* Effect.fail(
        new Error(`Sandbox ${run.sandboxId} is not a running docker sandbox for run ${runId}.`),
      );
    }
    return instance.resourceId;
  });

/**
 * Resolve the forwarded credentials to inject for this run from the attempt's spec snapshot. No store
 * key configured or no refs on the spec → nothing to inject (the harness runs as before).
 */
const resolveInjectables = (runId: string): Effect.Effect<
  CredentialInjectables,
  unknown,
  RunRepo | SandboxRepo | SandboxAttemptRepo | PrincipalCredentialRepo
> =>
  Effect.gen(function* () {
    const masterKey = env.SEALANT_SECRETS_KEY;
    if (masterKey === undefined) {
      return EMPTY_INJECTABLES;
    }
    const runs = yield* RunRepo;
    const sandboxes = yield* SandboxRepo;
    const attempts = yield* SandboxAttemptRepo;

    const run = yield* runs.getRunById(runId);
    if (run === undefined) {
      return EMPTY_INJECTABLES;
    }
    const sandbox = yield* sandboxes.getSandboxById(run.sandboxId);
    if (sandbox === undefined || sandbox.latestRunId === null) {
      return EMPTY_INJECTABLES;
    }
    const snapshot = yield* attempts.getAttemptSnapshotByRunId(sandbox.latestRunId);
    const refs = snapshot?.userSpecPayload.runtime?.credentialRefs ?? [];
    if (refs.length === 0) {
      return EMPTY_INJECTABLES;
    }
    return yield* resolveCredentialInjectables({
      refs,
      ownerUserId: sandbox.ownerUserId,
      keyProvider: makeEnvKeyProvider(masterKey),
    });
  });

/** The Effect pipeline: resolve container, mark running, inject creds + exec+capture, diff, mark terminal. */
export const processRunExecJobEffect = (
  options: Omit<ProcessRunExecJobOptions, "db">,
): Effect.Effect<
  void,
  unknown,
  | RunRepo
  | SandboxRepo
  | SandboxAttemptRepo
  | SandboxRuntimeInstanceRepo
  | PrincipalCredentialRepo
  | SealantRuntime
  | TelemetrySink
> =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const resourceId = yield* resolveContainerResourceId(options.runId);
    const target = sealantTargetForDockerContainer(resourceId);
    // Best-effort: a credential-resolution failure must not block the run.
    const injectables = yield* resolveInjectables(options.runId).pipe(
      Effect.catch(() => Effect.succeed(EMPTY_INJECTABLES)),
    );

    yield* runs.markRunRunning({ id: options.runId });

    const produce = Effect.gen(function* () {
      const exitCode = yield* captureRun(options.runId, target, options.command, injectables);
      const diff = yield* shellExec(
        target,
        `git add -A >/dev/null 2>&1; git --no-pager diff --cached`,
      );
      const names = yield* shellExec(target, `git --no-pager diff --cached --name-status`);
      const changedFiles = parseNameStatus(names.stdout);
      yield* exitCode === 0
        ? runs.markRunCompleted({ id: options.runId, exitCode: 0, diff: diff.stdout, changedFiles })
        : runs.markRunFailed({ id: options.runId, exitCode, diff: diff.stdout, changedFiles });
    });

    // Never leave the run pinned in "running": reconcile to failed on ANY abnormal exit (onError fires
    // on typed failures AND defects, e.g. a "connection closed" surfaced as a die).
    yield* produce.pipe(
      Effect.onError(() =>
        runs
          .markRunFailed({
            id: options.runId,
            errorMessage: "Harness run failed before completion.",
          })
          .pipe(Effect.ignore),
      ),
    );
  });

/** Thin Promise boundary used by the worker: builds the data-access + runtime + sink layers once. */
export const processRunExecJob = (options: ProcessRunExecJobOptions): Promise<void> => {
  const dbLayer = Layer.succeed(SealantDB, options.db);
  const dataAccessLayer = Layer.mergeAll(
    RunRepoLive,
    SandboxRepoLive,
    SandboxAttemptRepoLive,
    SandboxRuntimeInstanceRepoLive,
    PrincipalCredentialRepoLive,
  ).pipe(Layer.provide(dbLayer));
  const artifactLayer = InlineByteaArtifactStoreLive.pipe(Layer.provide(dbLayer));
  const sinkLayer = PostgresTelemetrySinkLive.pipe(
    Layer.provide(Layer.mergeAll(dbLayer, artifactLayer)),
  );
  const appLayer = Layer.mergeAll(dataAccessLayer, SealantRuntimeDockerExecLive, sinkLayer);

  return Effect.runPromise(processRunExecJobEffect(options).pipe(Effect.provide(appLayer)));
};
