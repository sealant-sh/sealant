import {
  formatWorkspaceEnvIssue,
  parseWorkspaceSecretEnv,
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
  WorkspaceRepo,
  WorkspaceRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  SealantDB,
  type DB,
} from "@sealant/db";
import { type GitHubSourceIntegration } from "@sealant/source-integrations";
import { newWorkspaceSchema, type NewWorkspace, type WorkspaceBuild } from "@sealant/validators";
import { Effect, Layer, Option } from "effect";
import { z } from "zod";

import type { PlannedWorkspaceImageBuild } from "../buildkit/index.js";
import { createDockerWorkspaceImageBuilder, type WorkspaceImageBuilder } from "../images/index.js";
import type { RegistryClient } from "../registry/index.js";
import {
  selectRuntimeAdapter,
  type CredentialFileInjection,
  type PublishedImage,
  type RuntimeAdapter,
  type RuntimeAdapterId,
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
  readonly db: DB;
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  readonly defaultRuntimeAdapterId: RuntimeAdapterId;
  readonly registryClient: RegistryClient;
  readonly gitHubSourceIntegration?: GitHubSourceIntegration;
  /**
   * Decrypts connected-account credentials at launch (design doc §6). Undefined when
   * SEALANT_CREDENTIALS_KEY is not configured — launching a blueprint that carries
   * credentialRefs then fails with a typed misconfiguration error.
   */
  readonly credentialCipher?: CredentialCipherService;
  readonly compileWorkspaceSpec?: (spec: NewWorkspace) => Promise<WorkspaceBuild>;
  /**
   * Docker-free planner used for the plan-hash short-circuit. Defaults to the real BuildKit
   * planner when `compileWorkspaceSpec` is not overridden; when a custom compiler is injected
   * without a matching planner the short-circuit is disabled (the planner's hash would not
   * describe what the custom compiler builds).
   */
  readonly planWorkspaceSpec?: (spec: NewWorkspace) => PlannedWorkspaceImageBuild;
  /**
   * How images are built and published. Defaults to the Docker builder over `registryClient`
   * (honouring `compileWorkspaceSpec` / `planWorkspaceSpec`); Kubernetes workers inject the
   * BuildKit-Job builder.
   */
  readonly imageBuilder?: WorkspaceImageBuilder;
  /**
   * Stages boot material (dotfiles archives, secret env) for the selected runtime. Defaults to
   * host directories the Docker adapter bind-mounts; Kubernetes deployments inject their own.
   */
  readonly launchMaterialStager?: LaunchMaterialStager;
}

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
}) => {
  const selectedAdapter = selectRuntimeAdapter({
    blueprint: input.spec,
    adapters: input.runtimeAdapters,
    defaultAdapterId: input.defaultRuntimeAdapterId,
  });

  return selectedAdapter.adapter.launch({
    blueprint: input.spec,
    publishedImage: input.publishedImage,
    ...(input.workspaceCloneAuth === undefined
      ? {}
      : { workspaceCloneAuth: input.workspaceCloneAuth }),
    ...(input.platformEnv === undefined ? {} : { platformEnv: input.platformEnv }),
    ...(input.credentialEnv === undefined ? {} : { credentialEnv: input.credentialEnv }),
    ...(input.credentialFiles === undefined ? {} : { credentialFiles: [...input.credentialFiles] }),
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
  });
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
    const policy = parseWorkspaceSecretEnv(record.data);
    if (!policy.ok) {
      return yield* toWorkspaceBuildJobProcessingError(
        new Error(
          `Sealed secretEnv failed policy at launch: ${policy.issues.map(formatWorkspaceEnvIssue).join("; ")}`,
        ),
      );
    }
    return policy.env;
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
 * The lookup is keyed by plan hash, not repository:tag: the SDK stamps every create with a fresh
 * random tag, so consecutive sessions over an unchanged plan share nothing BUT the hash. The
 * reused image keeps living under the prior job's tag; this job records the prior content
 * references while keeping its own repository:tag for naming.
 *
 * Strictly best-effort: any failure (planning, repo lookup, registry HEAD) resolves to `null` and
 * the job falls through to a full build, which surfaces the real error if one exists.
 */
const attemptPlanHashReuse = (input: {
  readonly job: {
    readonly registryId: string;
    readonly repository: string;
    readonly tag: string;
  };
  readonly spec: NewWorkspace;
  readonly planSpec: (spec: NewWorkspace) => PlannedWorkspaceImageBuild;
  readonly registryClient: RegistryClient;
}): Effect.Effect<PlanHashReuse | null, never, WorkspaceBuildJobRepo> =>
  Effect.gen(function* () {
    const jobs = yield* WorkspaceBuildJobRepo;

    const planned = yield* Effect.try(() => input.planSpec(input.spec));

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
    // out-of-band push makes the stored publish unusable and forces a fresh build.
    const registryDigest = yield* Effect.tryPromise(() =>
      input.registryClient.headManifest(priorJob.repository, priorJob.tag),
    );

    if (registryDigest !== priorJob.publishedDigest) {
      return null;
    }

    const publishedImage: PublishedImage = {
      repository: input.job.repository,
      tag: input.job.tag,
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
        yield* runtimeInstances
          .upsertRuntimeInstance({
            runId: job.runId,
            status: "failed",
            ...(error.errorCode === undefined ? {} : { errorCode: error.errorCode }),
            errorMessage: error.message,
            finishedAt: new Date(),
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

    const imageBuilder =
      options.imageBuilder ??
      createDockerWorkspaceImageBuilder({
        registryClient: options.registryClient,
        ...(options.compileWorkspaceSpec === undefined
          ? {}
          : { compileWorkspaceSpec: options.compileWorkspaceSpec }),
        ...(options.planWorkspaceSpec === undefined
          ? {}
          : { planWorkspaceSpec: options.planWorkspaceSpec }),
      });
    const planSpec = imageBuilder.plan;

    const reuse =
      planSpec === undefined
        ? null
        : yield* attemptPlanHashReuse({
            job,
            spec,
            planSpec,
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

      return { publishedImage: reuse.publishedImage, spec };
    }

    const { publishedImage, build: compileResult } = yield* Effect.tryPromise({
      try: () =>
        imageBuilder.buildAndPublish({
          spec,
          repository: job.repository,
          tag: job.tag,
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

    return { publishedImage, spec };
  });

  const { publishedImage, spec } = yield* buildAndPublish.pipe(
    Effect.tapError((error) => failureCleanup(error, true)),
  );

  // Phase B: launch the runtime instance and record its state.
  const stager = options.launchMaterialStager ?? hostDirectoryLaunchMaterialStager;
  const launchAndRecord = Effect.gen(function* () {
    if (job.runId !== null) {
      yield* runtimeInstances
        .upsertRuntimeInstance({ runId: job.runId, status: "pending" })
        .pipe(Effect.mapError(toWorkspaceBuildJobProcessingError));
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

    const runtimeLaunchResult = yield* Effect.tryPromise({
      try: () =>
        launchPublishedImage({
          spec,
          runtimeAdapters: options.runtimeAdapters,
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
        }),
      catch: toWorkspaceBuildJobProcessingError,
    }).pipe(
      // Ready = the daemon has already read the file at boot; nothing may still need it.
      Effect.tap((result) =>
        result.status === "ready" && secretEnvDir !== undefined
          ? Effect.promise(() => stager.removeSecretEnv(job.runId))
          : Effect.void,
      ),
    );

    if (job.runId !== null) {
      yield* runtimeInstances
        .upsertRuntimeInstance({
          runId: job.runId,
          status: runtimeLaunchResult.status,
          adapter: runtimeLaunchResult.adapter,
          resourceId: runtimeLaunchResult.resourceId,
          reference: runtimeLaunchResult.reference,
          ...(runtimeLaunchResult.endpoint === undefined
            ? {}
            : { endpoint: runtimeLaunchResult.endpoint }),
          launchCredentialInjections: resolvedCredentials.launchCredentialInjections,
          launchedAt: new Date(),
        })
        .pipe(Effect.mapError(toWorkspaceBuildJobProcessingError));
    }

    if (job.runId !== null) {
      yield* attempts
        .markAttemptSucceeded({ id: job.runId })
        .pipe(swallowingFailure("mark-attempt-succeeded update"));
    }
  });

  yield* launchAndRecord.pipe(
    Effect.tapError((error) => failureCleanup(error, false)),
    // Whatever happened, a settled launch phase leaves no sealed secret behind on the job row and
    // no staged file behind on the host (a failed launch may not have reached readiness).
    Effect.ensuring(
      Effect.all(
        [
          job.secretEnvSealed === null || job.secretEnvSealed === undefined
            ? Effect.void
            : jobs.clearSecretEnv(job.id).pipe(swallowingFailure("clear-secret-env update")),
          Effect.promise(() => stager.removeSecretEnv(job.runId)),
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
    GitHubInstallationRepoLive,
    GitHubInstallationRepositoryCacheRepoLive,
    ConnectedAccountRepoLive,
  ).pipe(Layer.provide(dbLayer));

  return Effect.runPromise(
    processWorkspaceBuildJobEffect(options).pipe(Effect.provide(dataAccessLayer)),
  );
};
