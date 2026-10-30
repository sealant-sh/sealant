/**
 * The exec recorder: execs a command over the sealantd control connection while draining its
 * telemetry into the {@link TelemetrySink} (bounded to that process, epoch bracketed and flagged
 * suspicious on a dropped bridge), reads the git diff, and marks the run completed or failed.
 *
 * Lives here, not in @sealant/workspaces, because it needs the sink, and this package already
 * depends on @sealant/workspaces: putting it there would be a dependency cycle.
 */
import { type CreateRunInput, type RunFileChange, RunRepo } from "@sealant/db";
import {
  execInWorkspace,
  PROCESS_USER_CAPABILITY,
  type RunExecCommand,
  SealantControlError,
  SealantRuntime,
  type SealantTarget,
  splitWorkingTreeChanges,
  syncBackWorkspaceCredentials,
  type SyncBackWorkspaceCredentialsInput,
  workingTreeChangesScript,
} from "@sealant/workspaces";
import { Cause, Effect, Schedule, Schema, Stream } from "effect";

import type { TelemetrySinkConflictError } from "./errors.js";
import { normalizeEnvelope } from "./normalize.js";
import { TelemetrySink } from "./sink.js";

const WORKDIR = "/workspace/repo";
export const RECORD_BATCH_SIZE = 256;
export const RECORD_BATCH_WINDOW = "250 millis";
/**
 * The control transport can flake while a freshly launched daemon comes up (socat bridge, WSS
 * service endpoints), so connecting and its health read are retried. An exec is never retried: its
 * acceptance can be lost after the process started, and a second send would start it twice.
 */
export const DAEMON_CONNECT_RETRY = { schedule: Schedule.spaced("400 millis"), times: 10 };

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

/**
 * Runs a script with `sh -c`, not as a login shell. The changes script needs only git and coreutils
 * on the image's own PATH, which every managed image and the custom-base contract provide, and it
 * prints the same bytes either way. A login shell sources `/etc/profile` and `/etc/profile.d` first:
 * in an Arch workspace image `sh -lc true` took 14 ms against 4 ms for `sh -c true` (2026-10-06),
 * and this runs after every exec, before the run is marked finished.
 */
const shellExec = (target: SealantTarget, script: string) =>
  execInWorkspace(target, { executable: "sh", args: ["-c", script], cwd: WORKDIR }).pipe(
    Effect.retry(DAEMON_CONNECT_RETRY),
  );

/**
 * The executor the run reached does not report `exec.user`: a daemon without it ignores `user` and
 * would start the process as root, so nothing is started. The API checked the executor it saw; this
 * holds when the run reaches another one (a restart in between).
 */
export class ProcessUserUnavailableError extends Schema.TaggedError<ProcessUserUnavailableError>()(
  "ProcessUserUnavailableError",
  { message: Schema.String },
) {}

/**
 * An exec was sent and no acceptance came back. With `refusedCode` the daemon refused it and nothing
 * started; without, its answer was lost, so whether the process started is unknown.
 */
export class ExecLaunchFailedError extends Schema.TaggedError<ExecLaunchFailedError>()(
  "ExecLaunchFailedError",
  { runId: Schema.String, refusedCode: Schema.optional(Schema.Number) },
) {}

/** Why the run failed, naming what was sent (`command 2/3`) and nothing it carried. */
export const launchFailureMessage = (error: ExecLaunchFailedError, what: string) =>
  error.refusedCode === undefined
    ? `Run ${error.runId}: ${what} was sent to the workspace and its answer was lost, so whether it started is unknown; it may still be running. It was not sent again.`
    : `Run ${error.runId}: the workspace refused to start ${what} (daemon error ${String(error.refusedCode)}); nothing was started.`;

/**
 * Execs the harness and records its telemetry, bounded to the harness process. Returns the exit
 * code. With `user`, the daemon starts the process as that Linux user (`ExecArgs.user`), and only a
 * daemon that reports `exec.user` is asked to (one capabilities read on the same connection).
 */
export const captureRun = (
  runId: string,
  target: SealantTarget,
  command: RunExecCommand,
  user?: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* SealantRuntime;
      const sink = yield* TelemetrySink;

      const { session, runtimeId } = yield* runtime.connect(target).pipe(
        Effect.flatMap((connected) =>
          Effect.gen(function* () {
            const health = yield* connected.health;
            if (user !== undefined) {
              const capabilities = yield* connected.capabilities;
              if (!capabilities.supports.includes(PROCESS_USER_CAPABILITY)) {
                return yield* new ProcessUserUnavailableError({
                  message: `The workspace's sealantd doesn't run processes as another user (it does not report ${PROCESS_USER_CAPABILITY}), so nothing was started as '${user}'.`,
                });
              }
            }
            return { session: connected, runtimeId: health.runtimeId };
          }),
        ),
        Effect.retry({
          ...DAEMON_CONNECT_RETRY,
          while: (error) => !(error instanceof ProcessUserUnavailableError),
        }),
      );
      const accepted = yield* session
        .exec({
          executable: command.executable,
          args: [...command.args],
          // The run id doubles as the daemon execution id: sealantd stamps it on every event
          // this exec produces, which is what lets ingest attribute them to THIS run (and lets
          // concurrent executions — e.g. an SSH session — keep their events out of it).
          executionId: runId,
          cwd: command.cwd ?? WORKDIR,
          stdin: false,
          ...(user === undefined ? {} : { user }),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ExecLaunchFailedError({
                runId,
                ...(error instanceof SealantControlError ? { refusedCode: error.code } : {}),
              }),
          ),
        );

      yield* sink.openEpoch({ runId, runtimeId, schemaVersion: 0 });

      let exitCode = -1;
      const drain = session.events.pipe(
        // Ingest this run's own events plus untagged daemon events (boot, heartbeats — the
        // pre-attribution behavior, and the compatibility path for daemons that ignore
        // execution_id). Events tagged with a DIFFERENT execution (a concurrent SSH session)
        // belong to that run; the telemetry worker's full-stream ingester attributes them there.
        Stream.filter((event) => event.executionId === undefined || event.executionId === runId),
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
        Stream.groupedWithin(RECORD_BATCH_SIZE, RECORD_BATCH_WINDOW),
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

/**
 * Captures what the run changed (shared by both framings): the working tree against HEAD, staged
 * in a throwaway index so the repository's own index — the user's git state — is never written.
 * A reading that failed (the script exited nonzero) is no reading: the run's diff and changed
 * files stay unrecorded (null), never an empty change that reads as "nothing changed".
 */
export const captureChanges = (runId: string, target: SealantTarget) =>
  Effect.gen(function* () {
    const output = yield* shellExec(target, workingTreeChangesScript());
    if (output.exitCode !== 0) {
      yield* Effect.logWarning(
        `Run ${runId}: reading its changes failed (the working-tree reading exited ${String(output.exitCode)}); recorded as failed.`,
      );
      return { changesReadFailed: true };
    }
    const { diff, nameStatus } = splitWorkingTreeChanges(output.stdout);
    return { diff, changedFiles: parseNameStatus(nameStatus) };
  });

/**
 * The run's record could not take one of its events: the log holds a different event at its id or
 * position. Its output is not all recorded, so the run fails, saying why.
 */
export const recordConflictMessage = (error: TelemetrySinkConflictError) =>
  `The run's record could not take its events: ${error.message}.`;

/**
 * EXEC (check-run) framing: every command executes in order regardless of exit codes — a nonzero
 * exit is a check DATUM (`base fails · head passes · revert fails`), not an execution failure. The
 * run completes iff every command executed and was recorded (its `exitCode` is the LAST command's;
 * per-command codes live in the record's `processExited` events). It fails only when the machinery
 * broke — a command that never reported an exit code means the recording cannot be trusted.
 */
export const produceExecRun = (
  runId: string,
  target: SealantTarget,
  commands: readonly RunExecCommand[],
  user?: string,
) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    let lastExitCode = 0;
    for (const [index, command] of commands.entries()) {
      const captured = yield* captureRun(runId, target, command, user).pipe(
        Effect.catchTag("ProcessUserUnavailableError", (error) =>
          runs.markRunFailed({ id: runId, errorMessage: error.message }).pipe(Effect.as(undefined)),
        ),
        Effect.catchTag("ExecLaunchFailedError", (error) =>
          runs
            .markRunFailed({
              id: runId,
              errorMessage: launchFailureMessage(error, `command ${index + 1}/${commands.length}`),
            })
            .pipe(Effect.as(undefined)),
        ),
        // The commands after it do not run; what the ones before it changed is still the run's.
        Effect.catchTag("TelemetrySinkConflictError", (error) =>
          Effect.gen(function* () {
            const changes = yield* captureChanges(runId, target);
            yield* runs.markRunFailed({
              id: runId,
              errorMessage: `Command ${index + 1}/${commands.length} (${command.executable}): ${recordConflictMessage(error)} Check run aborted.`,
              ...changes,
            });
            return undefined;
          }),
        ),
      );
      if (captured === undefined) return;
      const exitCode = captured;
      if (exitCode === -1) {
        yield* runs.markRunFailed({
          id: runId,
          errorMessage: `Command ${index + 1}/${commands.length} (${command.executable}) ended without an exit code (transport closed or killed); check run aborted.`,
        });
        return;
      }
      lastExitCode = exitCode;
    }
    const changes = yield* captureChanges(runId, target);
    yield* runs.markRunCompleted({ id: runId, exitCode: lastExitCode, ...changes });
  });

/** A claimed run: where its processes run, and what its credential sync-back reads afterwards. */
export interface ClaimedRun extends Omit<SyncBackWorkspaceCredentialsInput, "credentialCipher"> {
  readonly runId: string;
  readonly credentialCipher?: SyncBackWorkspaceCredentialsInput["credentialCipher"];
}

/**
 * Runs a claimed run's work so that every way out moves the run off `running`, a defect included,
 * and the credential sync-back runs on each: the CLIs may have rotated their session files even
 * when the run failed, and it never fails. An interruption sends no further command, and says a
 * process already started may still be running: it is not stopped.
 */
export const settleClaimedRun = <E, R>(run: ClaimedRun, produce: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    yield* produce.pipe(
      Effect.onError((cause) =>
        runs
          .markRunFailed({
            id: run.runId,
            errorMessage: Cause.hasInterruptsOnly(cause)
              ? `Run ${run.runId} was interrupted before it completed: no further command was sent, and one already started may still be running.`
              : "Run execution failed before completion.",
          })
          .pipe(Effect.ignore),
      ),
      Effect.ensuring(
        syncBackWorkspaceCredentials({
          attemptId: run.attemptId,
          target: run.target,
          launchCredentialInjections: run.launchCredentialInjections,
          credentialCipher: run.credentialCipher,
        }),
      ),
    );
  });

/**
 * An exec run executed in the caller's own fiber (an API request) rather than queued: the run is
 * created and claimed, its commands run in order with the worker's recording, and the settled run
 * is returned, a failed one too. Its commands live only in this fiber, and each reaches only its own
 * exec, never a later command, the changes reading or the credential sync-back. Interrupting it
 * (the client went away, the API stopped, the caller's budget ran out) fails the run the same way.
 */
export const executeExecRun = (input: {
  readonly run: CreateRunInput;
  readonly executor: Omit<ClaimedRun, "runId">;
  readonly commands: readonly RunExecCommand[];
  readonly user?: string;
}) =>
  // Between creating the run and settling it nothing is interrupted: a run never stays queued.
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const runs = yield* RunRepo;
      const { id } = yield* runs.createRun(input.run);
      yield* settleClaimedRun(
        { ...input.executor, runId: id },
        Effect.gen(function* () {
          const claim = yield* runs.claimRunForExec({ id });
          if (claim.outcome !== "claimed") {
            return yield* Effect.die(`Run ${id} was claimed elsewhere; it is on no queue.`);
          }
          yield* restore(produceExecRun(id, input.executor.target, input.commands, input.user));
        }),
      ).pipe(
        // The run says why it failed; an interruption is the caller's to see.
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning(`Run ${id} failed before completion.`, cause),
        ),
      );
      return yield* runs.getRunById(id);
    }),
  );
