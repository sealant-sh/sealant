/**
 * `workspace.dotfiles.apply()` — a THIN HTTP client like `workspace.exec()`.
 *
 * `POST /v1/workspaces/:id/dotfiles` checks the user and the home and stages the archives, then
 * queues a `dotfiles` run; the worker applies them as the user, with that run as the execution. The
 * run's first `processStarted` is the bootstrap, which the daemon starts only once every file is
 * applied, so `apply()` polls the run and resolves at whichever comes first: that entry (the files
 * are applied, the bootstrap runs) or the run's end (no bootstrap, or the apply failed). The
 * bootstrap's `wait()` polls the same run to its end and reads the bootstrap's output from the
 * record, as `exec()` does.
 */
import { Duration, Effect } from "effect";

import { SealantError } from "../errors.js";
import type { SdkContext } from "../facade/context.js";
import type { WorkspaceInit } from "../facade/workspace.js";
import { toGitUrl } from "../internal/blueprint.js";
import type {
  WorkspaceDotfilesApplied,
  WorkspaceDotfilesApplyOptions,
  WorkspaceDotfilesBootstrapResult,
} from "../types.js";
import { nextExecPollMs } from "./exec-workspace.js";
import {
  applyWorkspaceDotfilesOp,
  getRunOp,
  getRunScrollbackOp,
  getRunTimelineOp,
} from "./operations.js";
import { retryRead } from "./read-retry.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
/** The apply's own bound (10 minutes in the worker) and the queue's, with room to spare. */
const APPLY_TIMEOUT_MS = 15 * 60 * 1_000;
/** The bootstrap's bound (30 minutes in the worker), with room to spare. */
const BOOTSTRAP_TIMEOUT_MS = 35 * 60 * 1_000;

const dotfilesFailed = (runId: string, message: string | null | undefined, fallback: string) =>
  new SealantError(message ?? `${fallback} (run ${runId}).`, { code: "dotfiles_failed" });

/** The bootstrap's process, once the run's record has it. */
const bootstrapProcess = (runId: string, ownerUserId: string, deadline: number) =>
  Effect.map(
    retryRead(getRunTimelineOp(runId, { ownerUserId, kinds: "processStarted" }), {
      runId,
      what: "the timeline",
      deadline,
    }),
    (entries) => {
      for (const entry of entries) {
        if (typeof entry.processId === "string" && entry.processId.length > 0) {
          return entry.processId;
        }
      }
      return undefined;
    },
  );

/** Polls `runId` until `done` answers a value, the run ends, or `deadline` passes. */
const pollRun = <A, E, R>(
  runId: string,
  ownerUserId: string,
  deadline: number,
  done: (status: string) => Effect.Effect<A | undefined, E, R>,
) =>
  Effect.gen(function* () {
    const registeredAt = Date.now();
    let wait: number | undefined;
    for (;;) {
      const wire = yield* retryRead(getRunOp(runId, ownerUserId), {
        runId,
        what: "the state",
        deadline,
      });
      const answer = yield* done(wire.status);
      if (answer !== undefined) return { wire, answer };
      if (TERMINAL_STATUSES.has(wire.status)) return { wire, answer: undefined };
      if (Date.now() > deadline) {
        return yield* Effect.fail(
          new SealantError(`Timed out waiting for dotfiles run ${runId}.`, {
            code: "dotfiles_timeout",
          }),
        );
      }
      wait = nextExecPollMs(wait, Date.now() - registeredAt);
      yield* Effect.sleep(Duration.millis(wait));
    }
  });

const waitBootstrap = (ctx: SdkContext, runId: string, processId: string) =>
  Effect.gen(function* () {
    const ownerUserId = ctx.config.hostLocal.ownerUserId;
    const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
    const { wire } = yield* pollRun(runId, ownerUserId, deadline, () => Effect.succeed(undefined));
    if (wire.status !== "completed") {
      return yield* Effect.fail(
        dotfilesFailed(runId, wire.errorMessage, "The dotfiles bootstrap did not complete"),
      );
    }
    const read = (stream: "stdout" | "stderr") =>
      Effect.map(
        retryRead(getRunScrollbackOp(runId, { ownerUserId, processId, stream }), {
          runId,
          what: stream,
          deadline,
        }),
        (response) => Buffer.from(response.contentBase64, "base64").toString("utf8"),
      );
    const [stdout, stderr] = yield* Effect.all([read("stdout"), read("stderr")], {
      concurrency: "unbounded",
    });
    return {
      exitCode: wire.exitCode ?? -1,
      stdout,
      stderr,
    } satisfies WorkspaceDotfilesBootstrapResult;
  });

const applyDotfilesEffect = (
  ctx: SdkContext,
  init: WorkspaceInit,
  options: WorkspaceDotfilesApplyOptions,
) =>
  Effect.gen(function* () {
    const ownerUserId = ctx.config.hostLocal.ownerUserId;
    const repository = options.repository;
    const archives = options.archives ?? [];
    const created = yield* applyWorkspaceDotfilesOp(init.id, {
      ownerUserId,
      user: options.user,
      home: options.home,
      ...(repository === undefined
        ? {}
        : {
            repository: {
              url: toGitUrl(repository.url),
              ...(repository.ref === undefined ? {} : { ref: repository.ref }),
              ...(repository.manager === undefined ? {} : { manager: repository.manager }),
              ...(repository.bootstrap === undefined ? {} : { bootstrap: repository.bootstrap }),
              ...(repository.bootstrapCommand === undefined
                ? {}
                : { bootstrapCommand: repository.bootstrapCommand }),
            },
          }),
      ...(archives.length === 0
        ? {}
        : {
            archives: archives.map((archive) => ({
              data: archive.data,
              ...(archive.manager === undefined ? {} : { manager: archive.manager }),
              ...(archive.target === undefined ? {} : { target: archive.target }),
              ...(archive.bootstrap === undefined ? {} : { bootstrap: archive.bootstrap }),
              ...(archive.bootstrapCommand === undefined
                ? {}
                : { bootstrapCommand: archive.bootstrapCommand }),
            })),
          }),
    });
    const runId = created.runId;
    const deadline = Date.now() + APPLY_TIMEOUT_MS;
    // The bootstrap's `processStarted` is looked for while the run is running, and once more when
    // it has ended (a bootstrap that ended between two reads).
    const { wire, answer } = yield* pollRun(runId, ownerUserId, deadline, (status) =>
      status === "running" || TERMINAL_STATUSES.has(status)
        ? bootstrapProcess(runId, ownerUserId, deadline)
        : Effect.succeed(undefined),
    );
    if (answer === undefined && wire.status !== "completed") {
      return yield* Effect.fail(
        dotfilesFailed(runId, wire.errorMessage, "The dotfiles were not applied"),
      );
    }
    return {
      user: options.user,
      home: options.home,
      runId,
      bootstrap:
        answer === undefined
          ? null
          : {
              processId: answer,
              wait: () => ctx.runtime.run(waitBootstrap(ctx, runId, answer)),
            },
    } satisfies WorkspaceDotfilesApplied;
  });

/** The `workspace.dotfiles.apply()` implementation (Promise boundary over the Effect above). */
export const applyDotfiles = (
  ctx: SdkContext,
  init: WorkspaceInit,
  options: WorkspaceDotfilesApplyOptions,
): Promise<WorkspaceDotfilesApplied> => ctx.runtime.run(applyDotfilesEffect(ctx, init, options));
