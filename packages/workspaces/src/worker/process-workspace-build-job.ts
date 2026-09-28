import { randomUUID } from "node:crypto";

import {
  CAPTURE_TOKEN_SECRET_ENV_NAME,
  formatWorkspaceEnvIssue,
  parseWorkspaceSecretEnv,
  splitPlatformSecretEnv,
} from "@sealant/api-contracts/workspace-environment";
import type { CredentialCipherService, CredentialInjection } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ConnectedAccountRepoLive,
  GitHubInstallationRepo,
  GitHubInstallationRepoLive,
  GitHubInstallationRepositoryCacheRepo,
  GitHubInstallationRepositoryCacheRepoLive,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceBuildJobRepo,
  WorkspaceBuildJobRepoLive,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceRepo,
  WorkspaceRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  SealantDB,
  type DB,
} from "@sealant/db";
import { type GitHubSourceIntegration } from "@sealant/source-integrations";
import { newWorkspaceSchema, type NewWorkspace, type WorkspaceBuild } from "@sealant/validators";
import { Clock, Deferred, Effect, Exit, Layer, Option, Schedule } from "effect";
import { z } from "zod";

import type { PlannedWorkspaceImageBuild } from "../buildkit/index.js";
import { parsePublishedReference, planImageCoordinates } from "../images/index.js";
import { RegistryNameError, type RegistryClient } from "../registry/index.js";
import {
  LaunchRetainedError,
  launchHoldsCaptures,
  sealantdHasRecoveryBoot,
  sealantdImageOfContainerfile,
  selectRuntimeAdapter,
  type CredentialFileInjection,
  type PublishedImage,
  type RegisteredRuntime,
  type RuntimeAdapter,
  type RuntimeAdapterId,
  type RuntimeAdapterLaunchHooks,
  type RuntimeLaunchIdentity,
  type WorkspaceCloneAuth,
} from "../runtime/index.js";
import {
  hostDirectoryLaunchMaterialStager,
  type LaunchMaterialStager,
} from "../runtime/launch-material.js";
import { resolveCredentialInjections } from "./connected-account-resolver.js";
import {
  WorkspaceBuildJobProcessingError,
  swallowingFailure as sharedSwallowingFailure,
  toWorkspaceBuildJobProcessingError,
} from "./errors.js";
import {
  resolveDotfilesRuntimeEnv,
  resolveWorkspaceCloneAuth,
} from "./github-installation-auth-resolver.js";
import { DEFAULT_CAPTURE_DEADLINE_SETTINGS } from "./preserve-before-deadline.js";

export { WorkspaceBuildJobProcessingError } from "./errors.js";

/** Repository services the job pipeline resolves from context. */
export type ProcessWorkspaceBuildJobRequirements =
  | WorkspaceBuildJobRepo
  | WorkspaceRuntimeInstanceRepo
  | WorkspaceAttemptRepo
  | GitHubInstallationRepo
  | GitHubInstallationRepositoryCacheRepo
  | ConnectedAccountRepo;

export interface ProcessWorkspaceBuildJobOptions {
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  /**
   * How long a launch owns its `pending` row without renewal (the launch renews it every third
   * of this while it waits for readiness). A worker lost mid-launch leaves a launch the
   * stranded-launch sweep adopts this long after the last renewal — the executor is then
   * retained, drained and preserved like any other, instead of sitting unowned for the build
   * job's lease. Default `DEFAULT_LAUNCH_LEASE_MS` (2 minutes).
   */
  readonly launchLeaseMs?: number;
  /**
   * How long before a runtime's own deadline (a MicroVM's maximum duration) its preservation
   * starts (`WORKSPACE_CAPTURE_DEADLINE_LEAD_MS`, the deadline sweep's lead). A launch still
   * waiting for readiness when that moment comes stops waiting: its executor is kept as a
   * retained launch, which the deadline sweep drains at once. Absent: the default lead.
   */
  readonly preservationLeadMs?: number;
  readonly db: DB;
  /**
   * Every runtime this worker can launch on, each with the builder of the image it boots. The
   * selected runtime's builder builds the blueprint's image; there is no worker-wide builder.
   */
  readonly runtimes: readonly RegisteredRuntime[];
  readonly defaultRuntimeAdapterId: RuntimeAdapterId;
  readonly registryClient: RegistryClient;
  readonly gitHubSourceIntegration?: GitHubSourceIntegration;
  /**
   * Decrypts connected-account credentials at launch (design doc §6). Undefined when
   * SEALANT_CREDENTIALS_KEY is not configured — launching a blueprint that carries
   * credentialRefs then fails with a typed misconfiguration error.
   */
  readonly credentialCipher?: CredentialCipherService;
  /**
   * Stages boot material (dotfiles archives, secret env) for the selected runtime. Defaults to
   * host directories the Docker adapter bind-mounts; Kubernetes deployments inject their own.
   */
  readonly launchMaterialStager?: LaunchMaterialStager;
}

/** How long a launch owns its row without renewal when the worker names nothing else. */
export const DEFAULT_LAUNCH_LEASE_MS = 2 * 60_000;

/** Options for the Effect-native pipeline: repositories come from context, not `db`. */
export type ProcessWorkspaceBuildJobEffectOptions = Omit<ProcessWorkspaceBuildJobOptions, "db">;

const launchPublishedImage = async (input: {
  readonly spec: NewWorkspace;
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  readonly defaultRuntimeAdapterId: RuntimeAdapterId;
  readonly publishedImage: PublishedImage;
  readonly workspaceCloneAuth?: WorkspaceCloneAuth;
  readonly platformEnv?: Record<string, string>;
  readonly credentialEnv?: Record<string, string>;
  readonly credentialFiles?: readonly CredentialFileInjection[];
  readonly dotfilesArchiveDir?: string;
  readonly secretEnvDir?: string;
  readonly secretEnv?: Readonly<Record<string, string>>;
  readonly runId?: string;
  readonly workspaceId?: string;
  readonly principalId?: string;
  readonly binds?: readonly { readonly mountPath: string; readonly subpath: string }[];
  readonly hooks?: RuntimeAdapterLaunchHooks;
}) => {
  const selectedAdapter = selectRuntimeAdapter({
    blueprint: input.spec,
    adapters: input.runtimeAdapters,
    defaultAdapterId: input.defaultRuntimeAdapterId,
  });

  return selectedAdapter.adapter.launch(
    {
      blueprint: input.spec,
      publishedImage: input.publishedImage,
      ...(input.workspaceCloneAuth === undefined
        ? {}
        : { workspaceCloneAuth: input.workspaceCloneAuth }),
      ...(input.platformEnv === undefined ? {} : { platformEnv: input.platformEnv }),
      ...(input.credentialEnv === undefined ? {} : { credentialEnv: input.credentialEnv }),
      ...(input.credentialFiles === undefined
        ? {}
        : { credentialFiles: [...input.credentialFiles] }),
      ...(input.dotfilesArchiveDir === undefined
        ? {}
        : { dotfilesArchiveDir: input.dotfilesArchiveDir }),
      ...(input.secretEnvDir === undefined ? {} : { secretEnvDir: input.secretEnvDir }),
      ...(input.secretEnv === undefined ? {} : { secretEnv: { ...input.secretEnv } }),
      // Deterministic per-run container name -> idempotent launch/adopt (#4).
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
      ...(input.binds === undefined || input.binds.length === 0 ? {} : { binds: [...input.binds] }),
    },
    input.hooks,
  );
};

// Staging of launch material (dotfiles archives, secret env) lives in
// `../runtime/launch-material.ts`; these re-exports keep the historical import paths working.
export { dotfilesStagingRoot, removeStagedSecretEnv } from "../runtime/launch-material.js";

/**
 * Unseal the job's `secretEnv` (the transient secret channel) and re-validate it with the public
 * policy — the same check the API ran at create, applied again at the last hop before it becomes
 * a boot file. Never logs or embeds a value; failures name the rule.
 */
const unsealSecretEnv = (
  sealed: string,
  credentialCipher: CredentialCipherService | undefined,
): Effect.Effect<Readonly<Record<string, string>>, WorkspaceBuildJobProcessingError> =>
  Effect.gen(function* () {
    if (credentialCipher === undefined) {
      return yield* toWorkspaceBuildJobProcessingError(
        new Error(
          "This launch carries a sealed secretEnv but the worker has no credential cipher configured (SEALANT_CREDENTIALS_KEY).",
        ),
      );
    }
    const plaintext = yield* credentialCipher
      .decrypt(sealed)
      .pipe(Effect.mapError(toWorkspaceBuildJobProcessingError));
    const parsedJson = yield* Effect.try({
      try: (): unknown => JSON.parse(plaintext),
      catch: () => toWorkspaceBuildJobProcessingError(new Error("Sealed secretEnv is not JSON.")),
    });
    const record = z.record(z.string(), z.string()).safeParse(parsedJson);
    if (!record.success) {
      return yield* toWorkspaceBuildJobProcessingError(
        new Error("Sealed secretEnv is not a string map."),
      );
    }
    // The control plane seals its own platform-owned entries (the capture token) beside the
    // caller's map; the caller policy re-applies to the caller's lane only.
    const { callerEnv, platformEnv } = splitPlatformSecretEnv(record.data);
    const policy = parseWorkspaceSecretEnv(callerEnv);
    if (!policy.ok) {
      return yield* toWorkspaceBuildJobProcessingError(
        new Error(
          `Sealed secretEnv failed policy at launch: ${policy.issues.map(formatWorkspaceEnvIssue).join("; ")}`,
        ),
      );
    }
    return { ...policy.env, ...platformEnv };
  });

/** Split the resolver's injection plan into the adapter-launch env record + file list. */
const splitCredentialInjections = (
  injections: readonly CredentialInjection[],
): {
  readonly credentialEnv: Record<string, string>;
  readonly credentialFiles: readonly CredentialFileInjection[];
} => {
  const credentialEnv: Record<string, string> = {};
  const credentialFiles: CredentialFileInjection[] = [];

  for (const injection of injections) {
    if (injection.kind === "env") {
      credentialEnv[injection.key] = injection.value;
    } else {
      credentialFiles.push({
        path: injection.path,
        contentBase64: injection.contentBase64,
        mode: injection.mode,
      });
    }
  }

  return { credentialEnv, credentialFiles };
};

const swallowingFailure = (operation: string) =>
  sharedSwallowingFailure("Workspace build job", operation);

interface PlanHashReuse {
  readonly publishedImage: PublishedImage;
  readonly builderId: string;
  readonly resultPayload: WorkspaceBuild;
  readonly planHash: string;
}

/**
 * The plan-hash short-circuit: when the Docker-free plan of this job hashes identically to the
 * plan recorded by the latest succeeded publish in the same registry, AND that publish's tag still
 * resolves to its recorded digest, the BuildKit walk + publish can be skipped entirely — the
 * already-published image is byte-equivalent to what this build would produce.
 *
 * The lookup is keyed by plan hash, not repository:tag: the SDK stamps every create with its own
 * name, so consecutive sessions over an unchanged plan share nothing BUT the hash. The reused
 * image keeps living where the prior job published it; this job records those content references.
 *
 * Strictly best-effort: any failure (repo lookup, registry HEAD) resolves to `null` and the job
 * falls through to a full build, which surfaces the real error if one exists.
 */
const attemptPlanHashReuse = (input: {
  readonly job: {
    readonly registryId: string;
  };
  readonly planned: PlannedWorkspaceImageBuild;
  readonly registryClient: RegistryClient;
}): Effect.Effect<PlanHashReuse | null, never, WorkspaceBuildJobRepo> =>
  Effect.gen(function* () {
    const jobs = yield* WorkspaceBuildJobRepo;
    const planned = input.planned;

    const priorJob = yield* jobs.getLatestSucceededJobByPlanHash({
      registryId: input.job.registryId,
      planHash: planned.planHash,
    });

    if (
      priorJob === undefined ||
      priorJob.publishedReference === null ||
      priorJob.publishedDigestReference === null ||
      priorJob.publishedDigest === null
    ) {
      return null;
    }

    // The prior publish's tag must still point at the digest we recorded — a registry GC or an
    // out-of-band push makes the stored publish unusable and forces a fresh build. The tag is the
    // one actually pushed (plan-keyed since plan coordinates; the job's own name before that).
    const prior = parsePublishedReference(priorJob.publishedReference) ?? {
      repository: priorJob.repository,
      tag: priorJob.tag,
    };
    // A prior publish may carry a name from before names were held to the OCI grammar. That is
    // "no image to reuse", and the job rebuilds under a name the client accepts.
    const registryDigest = yield* Effect.tryPromise(() =>
      input.registryClient.headManifest(prior.repository, prior.tag).catch((error: unknown) => {
        if (error instanceof RegistryNameError) return null;
        throw error;
      }),
    );

    if (registryDigest !== priorJob.publishedDigest) {
      return null;
    }

    const publishedImage: PublishedImage = {
      repository: prior.repository,
      tag: prior.tag,
      reference: priorJob.publishedReference,
      digestReference: priorJob.publishedDigestReference,
      digest: priorJob.publishedDigest,
    };

    const artifactName =
      priorJob.resultPayload?.metadata?.defaultArtifactName ??
      `sealant-workspace-${planned.osFamily}`;

    return {
      publishedImage,
      builderId: planned.osFamily,
      planHash: planned.planHash,
      resultPayload: {
        builder: {
          id: planned.osFamily,
          osFamily: planned.osFamily,
        },
        artifacts: [
          {
            kind: "oci-image" as const,
            name: artifactName,
            reference: priorJob.publishedReference,
            loader: "registry" as const,
          },
        ],
        metadata: {
          defaultArtifactName: artifactName,
          notes: [
            `Reused published image ${priorJob.publishedDigestReference}: plan hash ${planned.planHash} unchanged; build and publish skipped.`,
          ],
          planHash: planned.planHash,
        },
      },
    };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug(
        "Workspace build job plan-hash reuse check failed; falling through to a full build.",
        cause,
      ).pipe(Effect.as(null)),
    ),
  );

/**
 * Process a single workspace build job as one Effect program.
 *
 * Repositories are resolved from context; external collaborators (compiler, registry, runtime
 * adapters, GitHub integration) are wrapped at the boundary with `Effect.tryPromise`. The flow
 * is split into two phases around the point the job is marked succeeded so cleanup knows whether
 * the build itself failed:
 *
 *  - Phase A (build + publish + mark-succeeded): on failure the job is marked failed.
 *  - Phase B (launch + record runtime instance): on failure the build stays succeeded.
 *
 * Both phases share best-effort cleanup (record a failed runtime instance, mark the attempt
 * failed) that never masks the originating error.
 */
export const processWorkspaceBuildJobEffect = Effect.fn("processWorkspaceBuildJob")(function* (
  options: ProcessWorkspaceBuildJobEffectOptions,
) {
  const jobs = yield* WorkspaceBuildJobRepo;
  const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
  const attempts = yield* WorkspaceAttemptRepo;

  const job = yield* jobs
    .claimJobById({
      id: options.jobId,
      workerId: options.workerId,
      leaseDurationMs: options.leaseDurationMs,
    })
    .pipe(Effect.mapError(toWorkspaceBuildJobProcessingError));

  if (job === null) {
    return null;
  }

  yield* Effect.annotateCurrentSpan({
    jobId: job.id,
    ...(job.runId === null ? {} : { runId: job.runId }),
  });

  // Best-effort cleanup shared by both phases. Every step swallows its own failure so the
  // originating error is the one that propagates.
  const failureCleanup = (error: WorkspaceBuildJobProcessingError, markJobAsFailed: boolean) =>
    Effect.gen(function* () {
      if (job.runId !== null) {
        // A capture-sourced launch that failed after readiness kept its executor: the row keeps
        // its identity (and `LAUNCH_RETAINED_ERROR_CODE`) so the retained-launch sweep drains it
        // before it is stopped. `finishedAt` stays unset — the executor is still running.
        const retained =
          error.cause instanceof LaunchRetainedError ? error.cause.identity : undefined;
        yield* runtimeInstances
          .upsertRuntimeInstance({
            runId: job.runId,
            status: "failed",
            releaseLaunch: true,
            ...(error.errorCode === undefined ? {} : { errorCode: error.errorCode }),
            errorMessage: error.message,
            ...(retained === undefined
              ? { finishedAt: new Date() }
              : {
                  adapter: retained.adapter,
                  resourceId: retained.resourceId,
                  reference: retained.reference,
                  ...(retained.endpoint === undefined ? {} : { endpoint: retained.endpoint }),
                  ...(retained.deadline === undefined
                    ? {}
                    : { runtimeDeadlineAt: new Date(retained.deadline) }),
                }),
          })
          .pipe(swallowingFailure("failed runtime-instance update"));
      }

      yield* Effect.all(
        [
          markJobAsFailed
            ? jobs
                .markJobFailed({
                  id: job.id,
                  errorMessage: error.message,
                  ...(error.errorCode === undefined ? {} : { errorCode: error.errorCode }),
                })
                .pipe(swallowingFailure("mark-failed update"))
            : Effect.void,
          job.runId === null
            ? Effect.void
            : attempts
                .markAttemptFailed({ id: job.runId })
                .pipe(swallowingFailure("mark-attempt-failed update")),
        ],
        { concurrency: "unbounded", discard: true },
      );
    });

  // Phase A: build the image, publish it, and mark the job succeeded.
  const buildAndPublish = Effect.gen(function* () {
    if (job.runId !== null) {
      yield* attempts
        .markAttemptRunning({ id: job.runId })
        .pipe(swallowingFailure("mark-attempt-running update"));
    }

    const spec = yield* Effect.try({
      try: () => newWorkspaceSchema.parse(job.requestPayload),
      catch: toWorkspaceBuildJobProcessingError,
    });

    // The runtime is chosen before anything is built, because the image is built by the builder
    // registered with it (docs/workspace-image-builders-design.md, D1). Selection is pure, and
    // phase B repeats it. A blueprint no adapter supports is phase B's to report, with the build
    // left succeeded, so an unsupported blueprint builds with the default runtime's builder.
    const adapters = options.runtimes.map((runtime) => runtime.adapter);
    const selectedAdapterId = yield* Effect.try(
      () =>
        selectRuntimeAdapter({
          blueprint: spec,
          adapters,
          defaultAdapterId: options.defaultRuntimeAdapterId,
        }).adapterId,
    ).pipe(Effect.catch(() => Effect.succeed(options.defaultRuntimeAdapterId)));
    const runtime =
      options.runtimes.find((candidate) => candidate.adapter.id === selectedAdapterId) ??
      options.runtimes[0];
    if (runtime === undefined) {
      return yield* toWorkspaceBuildJobProcessingError(
        new Error("This worker has no runtime registered, so nothing can build or launch."),
      );
    }
    const imageBuilder = runtime.imageBuilder;
    // Plan once: the hash both keys the reuse lookup and names the publish. A planner that throws
    // is treated like no planner — the full build surfaces the real error.
    const planned =
      imageBuilder.plan === undefined
        ? null
        : yield* Effect.try(() => imageBuilder.plan?.(spec) ?? null).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );

    const reuse =
      planned === null
        ? null
        : yield* attemptPlanHashReuse({
            job,
            planned,
            registryClient: options.registryClient,
          });

    if (reuse !== null) {
      yield* jobs
        .markJobSucceeded({
          id: job.id,
          builderId: reuse.builderId,
          resultPayload: reuse.resultPayload,
          publishedReference: reuse.publishedImage.reference,
          publishedDigestReference: reuse.publishedImage.digestReference,
          publishedDigest: reuse.publishedImage.digest,
        })
        .pipe(Effect.mapError(toWorkspaceBuildJobProcessingError));

      yield* Effect.logInfo(
        `Workspace image plan unchanged (hash ${reuse.planHash}); skipped build and publish, reusing ${reuse.publishedImage.digestReference}.`,
      );

      return { publishedImage: reuse.publishedImage, spec, planned };
    }

    // Publish under plan-keyed coordinates — one repository per OS family, one tag per plan hash —
    // so the next job with this plan finds the image by name as well as by hash, and a registry
    // holds one image per distinct plan instead of one per workspace. Without a planner the
    // client's requested name is all there is.
    const coordinates =
      planned === null
        ? { repository: job.repository, tag: job.tag }
        : planImageCoordinates(planned);
    const { publishedImage, build: compileResult } = yield* Effect.tryPromise({
      try: () =>
        imageBuilder.buildAndPublish({
          spec,
          repository: coordinates.repository,
          tag: coordinates.tag,
          buildId: job.id,
        }),
      catch: toWorkspaceBuildJobProcessingError,
    });

    yield* jobs
      .markJobSucceeded({
        id: job.id,
        builderId: compileResult.builder.id,
        resultPayload: compileResult,
        publishedReference: publishedImage.reference,
        publishedDigestReference: publishedImage.digestReference,
        publishedDigest: publishedImage.digest,
      })
      .pipe(Effect.mapError(toWorkspaceBuildJobProcessingError));

    return { publishedImage, spec, planned };
  });

  const { publishedImage, spec, planned } = yield* buildAndPublish.pipe(
    Effect.tapError((error) => failureCleanup(error, true)),
  );

  // Phase B: launch the runtime instance and record its state.
  const stager = options.launchMaterialStager ?? hostDirectoryLaunchMaterialStager;
  // What the launch boots from, recorded with its first row: every stop path decides whether to
  // drain from it (a capture-sourced executor holds unsaved work).
  const sourceKind = spec.sources.workspace.kind;
  // The daemon this executor boots, as the image plan copies it in, and whether it has sealantd's
  // recovery boot: recovery restarts a retained executor in place only when it does (a daemon
  // without it would run its ordinary boot over the work its disk holds). Unknown stays unknown.
  const daemonImage =
    planned === null ? undefined : sealantdImageOfContainerfile(planned.containerfile);
  const daemonRecoveryBoot = sealantdHasRecoveryBoot(daemonImage);
  // Launch ownership: from the first `pending` row until the terminal launch write, the row names
  // this launch as its owner under a lease the heartbeat below renews. The build job is already
  // `succeeded`, so nothing else would ever look at this launch again if the worker died: a
  // `pending` row whose ownership lapsed is adopted by the stranded-launch sweep as a retained
  // launch (drained, preserved before its deadline, recovered, stopped). Every write the launch
  // makes after this one is fenced on the ownership, so a launch that was adopted in between
  // (a worker stalled past its lease) never writes over the adoption.
  const launchOwner = `${options.workerId}:${job.id}:${randomUUID()}`;
  const launchLeaseMs = Math.max(1_000, options.launchLeaseMs ?? DEFAULT_LAUNCH_LEASE_MS);
  // The executor's identity once the adapter reported it (`onStarted` / `onReady`).
  let startedIdentity: RuntimeLaunchIdentity | undefined;
  const preservationLeadMs = Math.max(
    0,
    options.preservationLeadMs ?? DEFAULT_CAPTURE_DEADLINE_SETTINGS.leadMs,
  );
  const launchAndRecord = Effect.gen(function* () {
    // Why this launch stops waiting on its executor, when something decides it must: its
    // ownership was taken (the deadline sweep preempted it, or the stranded-launch sweep adopted
    // it), or its runtime's preservation start arrived before it settled. A pending launch never
    // holds an executor past the moment its work must start being saved (review 4 #6).
    const abandon = yield* Deferred.make<string>();
    // The executor's identity as soon as the adapter reports it (its deadline included).
    const started = yield* Deferred.make<RuntimeLaunchIdentity>();
    yield* Effect.forkScoped(
      Deferred.await(started).pipe(
        Effect.flatMap((identity) => {
          const deadline =
            identity.deadline === undefined ? Number.NaN : Date.parse(identity.deadline);
          return Number.isNaN(deadline)
            ? Effect.void
            : Effect.gen(function* () {
                const nowMs = yield* Clock.currentTimeMillis;
                const startsAtMs = deadline - preservationLeadMs;
                yield* Effect.sleep(Math.max(0, startsAtMs - nowMs));
                yield* Deferred.succeed(
                  abandon,
                  `its runtime's preservation starts at ${new Date(startsAtMs).toISOString()} (deadline ${new Date(deadline).toISOString()} less the ${String(Math.round(preservationLeadMs / 1000))} s lead) and the launch had not settled`,
                );
              });
        }),
      ),
    );
    if (job.runId !== null) {
      const runId = job.runId;
      yield* runtimeInstances
        .upsertRuntimeInstance({
          runId,
          status: "pending",
          sourceKind,
          launchOwner,
          launchLeaseMs,
          ...(daemonImage === undefined ? {} : { daemonImage }),
          daemonRecoveryBoot,
        })
        .pipe(Effect.mapError(toWorkspaceBuildJobProcessingError));
      // Renew the ownership while the launch runs (the readiness wait can take minutes). Ends
      // with the launch; a lost renewal is logged, and the fenced writes below find out.
      yield* Effect.forkScoped(
        runtimeInstances
          .renewLaunchLease({ runId, owner: launchOwner, leaseMs: launchLeaseMs })
          .pipe(
            Effect.flatMap((renewed) =>
              renewed
                ? Effect.void
                : Effect.logWarning(
                    `Launch of run ${runId}: its launch ownership was taken over (the deadline sweep preempted it, or the stranded-launch sweep adopted it); this worker stops waiting on it and no longer records it.`,
                  ).pipe(
                    Effect.andThen(
                      Deferred.succeed(
                        abandon,
                        "its launch ownership was taken over (preempted before its runtime's deadline, or adopted as stranded)",
                      ),
                    ),
                  ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Launch of run ${runId}: renewing its launch ownership failed.`,
                cause,
              ),
            ),
            Effect.repeat(Schedule.spaced(Math.max(250, Math.floor(launchLeaseMs / 3)))),
            Effect.delay(Math.max(250, Math.floor(launchLeaseMs / 3))),
          ),
      );
    }

    // Labels only (workspace id, owner): lets Kubernetes resources be reconciled per workspace.
    // Best-effort and optional — the WorkspaceRepo is consulted only when present in context.
    const attemptIdentity =
      job.runId === null
        ? undefined
        : yield* Effect.suspend(() => attempts.getAttemptById(job.runId ?? "")).pipe(
            Effect.catchCause(() => Effect.succeed(undefined)),
          );
    const workspaceRepo = yield* Effect.serviceOption(WorkspaceRepo);
    const workspaceRow =
      job.runId === null || Option.isNone(workspaceRepo)
        ? undefined
        : yield* Effect.suspend(() =>
            workspaceRepo.value.getWorkspaceByAttemptId(job.runId ?? ""),
          ).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    const labelWorkspaceId = workspaceRow?.id;
    // A standby / bindable-mount workspace relaunches with its recorded binds (sealantd ADR-0014):
    // the daemon re-applies them before the harness starts, so a restart keeps its worktree.
    const binds = workspaceRow?.binds ?? [];

    const workspaceCloneAuth = yield* resolveWorkspaceCloneAuth({
      spec,
      gitHubSourceIntegration: options.gitHubSourceIntegration,
    });
    const dotfilesRuntimeEnv = yield* resolveDotfilesRuntimeEnv({
      spec,
      gitHubSourceIntegration: options.gitHubSourceIntegration,
    });
    // Connected-account credentials resolve JUST before launch — blueprints only carry opaque
    // refs, so nothing secret ever sits in job payloads. Post-run sync-backs re-derive the refs
    // from the stored attempt snapshot; the runtime instance row additionally records the
    // NON-secret launch-time injection shapes (env vs file) so a mid-run reconnect that switched
    // an account's payload shape can never make a sync-back trust the wrong file.
    const resolvedCredentials = yield* resolveCredentialInjections({
      blueprint: spec,
      credentialCipher: options.credentialCipher,
    });
    const { credentialEnv, credentialFiles } = splitCredentialInjections(
      resolvedCredentials.injections,
    );

    // The transient secret channel: unseal, re-validate, then hand it to the stager with the
    // dotfiles archives. For Docker the stager writes a 0600 boot file the adapter bind-mounts
    // read-only. Removed as soon as the workspace is READY (the daemon has consumed it by then),
    // and the sealed row is cleared once this phase settles either way — see the
    // ensuring/finalizer below.
    const secretEnv =
      job.secretEnvSealed === null || job.secretEnvSealed === undefined
        ? undefined
        : yield* unsealSecretEnv(job.secretEnvSealed, options.credentialCipher);

    // A capture executor's boot reads its capture token once, from the secret env file removed
    // once it is ready. Recovering a retained executor boots it again, so the token (only the
    // token) is kept sealed beside its drain record before the launch. Best-effort: a launch
    // whose token cannot be kept still launches, and its recovery reports it unrecoverable.
    const captureToken = secretEnv?.[CAPTURE_TOKEN_SECRET_ENV_NAME];
    if (
      job.runId !== null &&
      captureToken !== undefined &&
      options.credentialCipher !== undefined
    ) {
      const runId = job.runId;
      const cipher = options.credentialCipher;
      const drains = yield* Effect.serviceOption(WorkspaceCaptureDrainRepo);
      if (Option.isSome(drains)) {
        yield* cipher
          .encrypt(JSON.stringify({ [CAPTURE_TOKEN_SECRET_ENV_NAME]: captureToken }))
          .pipe(
            Effect.flatMap((sealed) =>
              drains.value.storeCaptureToken({ runId, sealed: sealed.sealed }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Launch of run ${runId}: keeping its sealed capture token for recovery failed; a retained executor of this run cannot be recovered.`,
                cause,
              ),
            ),
          );
      }
    }
    const {
      dotfilesArchiveDir,
      secretEnvDir,
      secretEnv: passThroughSecretEnv,
    } = yield* Effect.tryPromise({
      try: () =>
        stager.stage({
          spec,
          runId: job.runId,
          ...(secretEnv === undefined ? {} : { secretEnv }),
        }),
      catch: toWorkspaceBuildJobProcessingError,
    });

    const recordReadyIdentity =
      (runId: string) =>
      (identity: RuntimeLaunchIdentity): Promise<void> => {
        startedIdentity = identity;
        Deferred.doneUnsafe(started, Exit.succeed(identity));
        return Effect.runPromise(
          runtimeInstances
            .upsertRuntimeInstance({
              runId,
              status: "pending",
              fenceLaunchOwner: launchOwner,
              launchLeaseMs,
              adapter: identity.adapter,
              resourceId: identity.resourceId,
              reference: identity.reference,
              ...(identity.endpoint === undefined ? {} : { endpoint: identity.endpoint }),
              ...(identity.deadline === undefined
                ? {}
                : { runtimeDeadlineAt: new Date(identity.deadline) }),
              sourceKind,
            })
            .pipe(Effect.asVoid),
        );
      };

    const runtimeLaunchResult = yield* Effect.tryPromise({
      try: () =>
        launchPublishedImage({
          spec,
          runtimeAdapters: options.runtimes.map((runtime) => runtime.adapter),
          defaultRuntimeAdapterId: options.defaultRuntimeAdapterId,
          publishedImage,
          ...(workspaceCloneAuth === undefined ? {} : { workspaceCloneAuth }),
          // Worker-resolved dotfiles clone auth rides the TRANSIENT platform launch field, never a
          // blueprint env map: the blueprint is the persisted restart source and must stay free of
          // resolved tokens. A restart re-resolves fresh tokens through this same path.
          ...(Object.keys(dotfilesRuntimeEnv).length === 0
            ? {}
            : { platformEnv: dotfilesRuntimeEnv }),
          ...(Object.keys(credentialEnv).length === 0 ? {} : { credentialEnv }),
          ...(credentialFiles.length === 0 ? {} : { credentialFiles }),
          ...(dotfilesArchiveDir === undefined ? {} : { dotfilesArchiveDir }),
          ...(secretEnvDir === undefined ? {} : { secretEnvDir }),
          ...(passThroughSecretEnv === undefined ? {} : { secretEnv: passThroughSecretEnv }),
          ...(job.runId === null ? {} : { runId: job.runId }),
          ...(labelWorkspaceId === undefined ? {} : { workspaceId: labelWorkspaceId }),
          ...(binds.length === 0 ? {} : { binds }),
          ...(attemptIdentity?.ownerUserId === undefined
            ? {}
            : { principalId: attemptIdentity.ownerUserId }),
          // As soon as the executor exists — and again once its daemon answers — its identity is
          // on the row before any later launch step runs: a worker that dies after this leaves a
          // runtime it can be found by (a capture executor is retained from its start).
          hooks:
            job.runId === null
              ? {}
              : {
                  onStarted: recordReadyIdentity(job.runId),
                  onReady: recordReadyIdentity(job.runId),
                },
        }),
      catch: toWorkspaceBuildJobProcessingError,
    }).pipe(
      // Ready = the daemon has already read the file at boot; nothing may still need it.
      Effect.tap((result) =>
        result.status === "ready" && secretEnvDir !== undefined
          ? Effect.promise(() => stager.removeSecretEnv(job.runId))
          : Effect.void,
      ),
      // Abandoned (see `abandon`): the launch stops waiting and fails; a started executor is kept
      // as a retained launch (never removed here), which the deadline sweep drains.
      (launching) =>
        Effect.raceFirst(
          launching,
          Deferred.await(abandon).pipe(
            Effect.flatMap((reason) =>
              Effect.fail(
                toWorkspaceBuildJobProcessingError(
                  startedIdentity === undefined
                    ? new Error(`The launch was abandoned: ${reason}.`)
                    : new LaunchRetainedError(
                        startedIdentity,
                        new Error(`The launch was abandoned: ${reason}.`),
                      ),
                ),
              ),
            ),
          ),
        ),
    );

    if (job.runId !== null) {
      const launchedRunId = job.runId;
      yield* runtimeInstances
        .upsertRuntimeInstance({
          runId: launchedRunId,
          status: runtimeLaunchResult.status,
          adapter: runtimeLaunchResult.adapter,
          resourceId: runtimeLaunchResult.resourceId,
          reference: runtimeLaunchResult.reference,
          ...(runtimeLaunchResult.endpoint === undefined
            ? {}
            : { endpoint: runtimeLaunchResult.endpoint }),
          launchCredentialInjections: resolvedCredentials.launchCredentialInjections,
          launchedAt: new Date(),
          // The terminal launch write: only while the launch is still this worker's.
          fenceLaunchOwner: launchOwner,
          releaseLaunch: true,
          ...(runtimeLaunchResult.deadline === undefined
            ? {}
            : { runtimeDeadlineAt: new Date(runtimeLaunchResult.deadline) }),
          sourceKind,
        })
        .pipe(
          // The executor is up; failing to record it must not get it removed. A capture-sourced
          // one is recorded retained (drained, then stopped); anything else fails as before.
          Effect.mapError((cause) =>
            toWorkspaceBuildJobProcessingError(
              launchHoldsCaptures(spec)
                ? new LaunchRetainedError(
                    {
                      adapter: runtimeLaunchResult.adapter,
                      resourceId: runtimeLaunchResult.resourceId,
                      reference: runtimeLaunchResult.reference,
                      ...(runtimeLaunchResult.endpoint === undefined
                        ? {}
                        : { endpoint: runtimeLaunchResult.endpoint }),
                      ...(runtimeLaunchResult.deadline === undefined
                        ? {}
                        : { deadline: runtimeLaunchResult.deadline }),
                    },
                    cause,
                  )
                : cause,
            ),
          ),
        );
    }

    if (job.runId !== null) {
      yield* attempts
        .markAttemptSucceeded({ id: job.runId })
        .pipe(swallowingFailure("mark-attempt-succeeded update"));
    }
  });

  // Interrupted after the executor started (a worker shutting down, a cancelled fiber): the
  // executor is kept as a retained launch, as a failure after start would keep it. A worker that
  // dies outright never gets here; its lapsed ownership leads the stranded-launch sweep to the
  // same record.
  const retainOnInterrupt = Effect.suspend(() => {
    const identity = startedIdentity;
    if (job.runId === null || identity === undefined) {
      return Effect.void;
    }
    return failureCleanup(
      toWorkspaceBuildJobProcessingError(
        new LaunchRetainedError(
          identity,
          new Error("The worker launching it was interrupted before the launch finished."),
        ),
      ),
      false,
    );
  });

  yield* Effect.scoped(launchAndRecord).pipe(
    Effect.onInterrupt(() => retainOnInterrupt),
    Effect.tapError((error) => failureCleanup(error, false)),
    // A successful boot has consumed only the secret file; stop owns the remaining dotfiles cleanup.
    // A failed/interrupted launch removes every staged artifact exactly once so retries restage from
    // the durable request instead of inheriting a partial directory.
    Effect.onExit((exit) =>
      Effect.all(
        [
          job.secretEnvSealed === null || job.secretEnvSealed === undefined
            ? Effect.void
            : jobs.clearSecretEnv(job.id).pipe(swallowingFailure("clear-secret-env update")),
          Effect.promise(() =>
            Exit.isSuccess(exit) ? stager.removeSecretEnv(job.runId) : stager.removeAll(job.runId),
          ),
        ],
        { discard: true },
      ),
    ),
  );

  return publishedImage;
});

/**
 * Process a single workspace build job.
 *
 * Thin Promise boundary used by the worker: it provides the live data-access layer (built from
 * `options.db`) exactly once and runs the Effect pipeline. A failed job rejects with a
 * {@link WorkspaceBuildJobProcessingError}.
 */
export const processWorkspaceBuildJob = (
  options: ProcessWorkspaceBuildJobOptions,
): Promise<PublishedImage | null> => {
  const dbLayer = Layer.succeed(SealantDB, options.db);
  const dataAccessLayer = Layer.mergeAll(
    WorkspaceBuildJobRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
    WorkspaceRepoLive,
    WorkspaceAttemptRepoLive,
    // The sealed capture token a retained executor's recovery stages again.
    WorkspaceCaptureDrainRepoLive,
    GitHubInstallationRepoLive,
    GitHubInstallationRepositoryCacheRepoLive,
    ConnectedAccountRepoLive,
  ).pipe(Layer.provide(dbLayer));

  return Effect.runPromise(
    processWorkspaceBuildJobEffect(options).pipe(Effect.provide(dataAccessLayer)),
  );
};
