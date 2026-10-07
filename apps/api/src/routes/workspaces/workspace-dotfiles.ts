/**
 * A person's dotfiles applied into their home of a running workspace, as their Linux user
 * (`POST /v1/workspaces/:id/dotfiles`, docs/connected-accounts-design.md §6g).
 *
 * Synchronously, over the executor's control connection: the daemon must apply dotfiles as a user
 * (`dotfiles.user`), the user must exist and not be root, `home` must be their passwd home, and the
 * archives are staged root-only for the run (one exec; the bytes over stdin, never argv). Then a run
 * (`harnessId` `dotfiles`) is queued: the worker calls `dotfiles.apply` with the run as the
 * execution, so the bootstrap's output and exit are that run's record, and removes the staged
 * archives. Nothing of the request (no archive, no URL) is kept in the job row past its pickup.
 */
import { randomUUID } from "node:crypto";

import {
  dotfilesRunHarnessId,
  WorkspaceBadGatewayError,
  WorkspaceBadRequestError,
  WorkspaceConflictError,
  WorkspaceForbiddenError,
  WorkspaceInternalServerError,
  type ApplyWorkspaceDotfilesRequest,
} from "@sealant/api-contracts";
import { RunRepo, WorkspaceCredentialHomeRepo } from "@sealant/db";
import {
  buildDotfilesCleanupScript,
  buildDotfilesStageScript,
  dotfilesStagePath,
  dotfilesStageRefusal,
  dotfilesStageStdin,
  dotfilesUserProblem,
  homePathProblem,
  liveDotfilesStageChannel,
  type DotfilesStageChannel,
} from "@sealant/workspaces";
import { Duration, Effect, Result } from "effect";

import { RunExecPublisherService } from "../../services/control-plane-capabilities.js";
import { CurrentPrincipal } from "../../services/service-principals.js";
import { mapRun } from "../runs/runs.module.js";
import { loadInstance, notRunning, targetFor } from "./workspace-credentials.js";

/** Staging is one exec writing at most 4 archives of ~4 MiB each. */
const STAGE_TIMEOUT = Duration.seconds(60);

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

/**
 * Applying a person's dotfiles names a Linux user and the person they are for: only a service key
 * acts for any person. The SSH gateway's secret and a user access token are refused here, as on the
 * credentials routes, so a change to the transport's gate cannot widen them.
 */
const requireServiceKey = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  if (principal.kind === "gateway" || principal.kind === "bearer") {
    return yield* new WorkspaceForbiddenError({
      message:
        "Applying a person's dotfiles names the person they are for; only a service key may.",
    });
  }
});

/** Why a repository URL may not be cloned; `undefined` when it may. */
const repositoryUrlProblem = (url: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "it is not a URL";
  }
  if (parsed.protocol !== "https:") return "only https:// URLs are cloned";
  // A token in the URL would sit in the job row and in `git clone`'s argv, which every process in
  // the workspace can read: such a repository is resolved by the caller and sent as an archive.
  if (parsed.username !== "" || parsed.password !== "") {
    return "it carries a credential (user:token@); send the checkout as an archive instead";
  }
  return undefined;
};

export const applyWorkspaceDotfiles = (input: {
  readonly workspaceId: string;
  readonly payload: ApplyWorkspaceDotfilesRequest;
  /** For tests; defaults to the live stage channel. */
  readonly stageChannel?: DotfilesStageChannel;
}) =>
  Effect.gen(function* () {
    yield* requireServiceKey;
    const payload = input.payload;
    const urlProblem =
      payload.repository === undefined ? undefined : repositoryUrlProblem(payload.repository.url);
    if (urlProblem !== undefined) {
      return yield* new WorkspaceBadRequestError({
        message: `The dotfiles repository URL is refused: ${urlProblem}.`,
      });
    }
    const userProblem = dotfilesUserProblem(payload.user);
    if (userProblem !== undefined) {
      return yield* new WorkspaceBadRequestError({
        message: `User '${payload.user}': ${userProblem}`,
      });
    }
    const homeProblem = homePathProblem(payload.home);
    if (homeProblem !== undefined) {
      return yield* new WorkspaceBadRequestError({
        message: `Home '${payload.home}': ${homeProblem}`,
      });
    }
    const archives = (payload.archives ?? []).map((archive) => ({
      data: archive.data,
      ...(archive.manager === undefined ? {} : { manager: archive.manager }),
      ...(archive.target === undefined ? {} : { target: archive.target }),
      bootstrap: archive.bootstrap ?? true,
      ...(archive.bootstrapCommand === undefined
        ? {}
        : { bootstrapCommand: archive.bootstrapCommand }),
    }));
    if (payload.repository === undefined && archives.length === 0) {
      return yield* new WorkspaceBadRequestError({
        message: "Name a dotfiles repository or archives to apply.",
      });
    }

    const { workspace, instance } = yield* loadInstance({
      workspaceId: input.workspaceId,
      ownerUserId: payload.ownerUserId,
    });
    if (instance === undefined || instance.status !== "ready") {
      return yield* notRunning(input.workspaceId);
    }
    // One person's dotfiles never go into a home whose logins another person holds.
    const holders = yield* (yield* WorkspaceCredentialHomeRepo).listByRunId(instance.runId).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceInternalServerError({
            message: toErrorMessage(error, "Failed to load the workspace's homes."),
          }),
      ),
    );
    const holder = holders.find((row) => row.home === payload.home);
    if (holder !== undefined && holder.onBehalfOfUserId !== payload.onBehalfOfUserId) {
      return yield* new WorkspaceConflictError({
        message: `${payload.home} holds another person's logins in workspace ${input.workspaceId}; their dotfiles are not applied there. Nothing was applied.`,
        code: "home-held",
      });
    }
    const target = yield* targetFor(input.workspaceId, instance);
    const channel = input.stageChannel ?? liveDotfilesStageChannel;
    const runId = `run_${randomUUID()}`;
    const who = { user: payload.user, home: payload.home };

    const staged = yield* channel
      .stage(
        target,
        buildDotfilesStageScript({
          ...who,
          ...(archives.length === 0 ? {} : { stageId: runId }),
          archiveCount: archives.length,
        }),
        dotfilesStageStdin(archives),
      )
      .pipe(Effect.timeout(STAGE_TIMEOUT), Effect.result);
    if (Result.isFailure(staged)) {
      return yield* new WorkspaceBadGatewayError({
        message: `The workspace's executor did not confirm the dotfiles staging: ${toErrorMessage(staged.failure, "no answer")}. Nothing was applied.`,
      });
    }
    if (!staged.success.supported) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId}'s sealantd cannot apply dotfiles as a user (it does not report dotfiles.user). Nothing was applied.`,
        code: "dotfiles-user-unsupported",
      });
    }
    if (staged.success.exitCode !== 0) {
      const refusal = dotfilesStageRefusal(who, staged.success.exitCode);
      if (refusal !== undefined) {
        return yield* new WorkspaceConflictError({
          message: `${refusal.message} Nothing was applied.`,
          code: refusal.code,
        });
      }
      return yield* new WorkspaceBadGatewayError({
        message: `The dotfiles staging exited with ${String(staged.success.exitCode)}. Nothing was applied.`,
      });
    }

    // From here the archives are staged: a failure removes them before it answers.
    const removeStaged =
      archives.length === 0
        ? Effect.void
        : channel.run(target, buildDotfilesCleanupScript(runId)).pipe(Effect.ignore);
    const runs = yield* RunRepo;
    const run = yield* runs
      .createRun({
        id: runId,
        workspaceId: workspace.id,
        ownerUserId: payload.ownerUserId,
        harnessId: dotfilesRunHarnessId,
        mode: "one-shot",
        // Whose dotfiles the run applied, as whom, and where.
        metadata: {
          dotfiles: {
            onBehalfOfUserId: payload.onBehalfOfUserId,
            user: payload.user,
            home: payload.home,
          },
        },
      })
      .pipe(
        Effect.tapError(() => removeStaged),
        Effect.mapError(
          (error) =>
            new WorkspaceInternalServerError({
              message: toErrorMessage(error, "Failed to create the dotfiles run."),
            }),
        ),
      );

    const publisher = yield* RunExecPublisherService;
    const repository = payload.repository;
    yield* Effect.tryPromise({
      try: () =>
        publisher.publishRequested({
          runId: run.id,
          dotfiles: {
            ...who,
            ...(archives.length === 0 ? {} : { archiveDir: dotfilesStagePath(runId) }),
            ...(repository === undefined
              ? {}
              : {
                  repository: {
                    url: repository.url,
                    ...(repository.ref === undefined ? {} : { reference: repository.ref }),
                    ...(repository.manager === undefined ? {} : { manager: repository.manager }),
                    bootstrap: repository.bootstrap ?? true,
                    ...(repository.bootstrapCommand === undefined
                      ? {}
                      : { bootstrapCommand: repository.bootstrapCommand }),
                  },
                }),
          },
        }),
      catch: (error) =>
        new WorkspaceInternalServerError({
          message: toErrorMessage(error, "Failed to enqueue the dotfiles run."),
        }),
    }).pipe(
      Effect.tapError(() =>
        Effect.all(
          [
            removeStaged,
            runs
              .markRunFailed({
                id: runId,
                errorMessage: "The dotfiles run was not enqueued; nothing was applied.",
              })
              .pipe(Effect.ignore),
          ],
          { discard: true },
        ),
      ),
    );

    return mapRun(run);
  });
