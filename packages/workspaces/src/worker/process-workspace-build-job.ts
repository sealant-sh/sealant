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
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  SealantDB,
  type DB,
} from "@sealant/db";
import { type GitHubSourceIntegration } from "@sealant/source-integrations";
import { newWorkspaceSchema, type NewWorkspace, type WorkspaceBuild } from "@sealant/validators";
import { Effect, Layer } from "effect";

import { compileWorkspaceBuildSpec } from "../buildkit/index.js";
import type { RegistryClient } from "../registry/index.js";
import {
  selectRuntimeAdapter,
  type CredentialFileInjection,
  type PublishedImage,
  type RuntimeAdapter,
  type RuntimeAdapterId,
  type WorkspaceCloneAuth,
} from "../runtime/index.js";
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
}

/** Options for the Effect-native pipeline: repositories come from context, not `db`. */
export type ProcessWorkspaceBuildJobEffectOptions = Omit<ProcessWorkspaceBuildJobOptions, "db">;

const isPublishableOciImageArtifact = (
  artifact: WorkspaceBuild["artifacts"][number],
): artifact is WorkspaceBuild["artifacts"][number] & {
  kind: "oci-image";
  path: string;
  loader: "docker-load";
} => {
  return (
    artifact.kind === "oci-image" &&
    artifact.path !== undefined &&
    artifact.loader === "docker-load"
  );
};

const selectPublishableImageArtifact = (compileResult: WorkspaceBuild) => {
  const artifact = compileResult.artifacts.find(isPublishableOciImageArtifact);

  if (artifact === undefined) {
    throw new Error("The compiler did not return a publishable OCI image artifact.");
  }

  return artifact;
};

const launchPublishedImage = async (input: {
  readonly spec: NewWorkspace;
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  readonly defaultRuntimeAdapterId: RuntimeAdapterId;
  readonly publishedImage: PublishedImage;
  readonly workspaceCloneAuth?: WorkspaceCloneAuth;
  readonly credentialEnv?: Record<string, string>;
  readonly credentialFiles?: readonly CredentialFileInjection[];
  readonly runId?: string;
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
    ...(input.credentialEnv === undefined ? {} : { credentialEnv: input.credentialEnv }),
    ...(input.credentialFiles === undefined ? {} : { credentialFiles: [...input.credentialFiles] }),
    // Deterministic per-run container name -> idempotent launch/adopt (#4).
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  });
};

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

    const compileSpec =
      options.compileWorkspaceSpec ??
      ((inputSpec: NewWorkspace): Promise<WorkspaceBuild> =>
        compileWorkspaceBuildSpec({ blueprint: inputSpec }));

    const compileResult = yield* Effect.tryPromise({
      try: () => compileSpec(spec),
      catch: toWorkspaceBuildJobProcessingError,
    });

    const imageArtifact = yield* Effect.try({
      try: () => selectPublishableImageArtifact(compileResult),
      catch: toWorkspaceBuildJobProcessingError,
    });

    const publishedImage = yield* Effect.tryPromise({
      try: () =>
        options.registryClient.publishOciImage({
          artifactPath: imageArtifact.path,
          repository: job.repository,
          tag: job.tag,
          ...(imageArtifact.reference === undefined
            ? {}
            : { sourceReference: imageArtifact.reference }),
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
  const launchAndRecord = Effect.gen(function* () {
    if (job.runId !== null) {
      yield* runtimeInstances
        .upsertRuntimeInstance({ runId: job.runId, status: "pending" })
        .pipe(Effect.mapError(toWorkspaceBuildJobProcessingError));
    }

    const workspaceCloneAuth = yield* resolveWorkspaceCloneAuth({
      spec,
      gitHubSourceIntegration: options.gitHubSourceIntegration,
    });
    const dotfilesRuntimeEnv = yield* resolveDotfilesRuntimeEnv({
      spec,
      gitHubSourceIntegration: options.gitHubSourceIntegration,
    });
    // Connected-account credentials resolve JUST before launch — blueprints only carry opaque
    // refs, so nothing secret ever sits in job payloads. Codex sync-back later re-derives the
    // refs from the stored attempt snapshot (no extra persistence needed here).
    const resolvedCredentials = yield* resolveCredentialInjections({
      blueprint: spec,
      credentialCipher: options.credentialCipher,
    });
    const { credentialEnv, credentialFiles } = splitCredentialInjections(
      resolvedCredentials.injections,
    );

    const runtimeSpec: NewWorkspace =
      Object.keys(dotfilesRuntimeEnv).length === 0
        ? spec
        : {
            ...spec,
            runtime: {
              ...spec.runtime,
              env: {
                ...spec.runtime.env,
                ...dotfilesRuntimeEnv,
              },
            },
          };

    const runtimeLaunchResult = yield* Effect.tryPromise({
      try: () =>
        launchPublishedImage({
          spec: runtimeSpec,
          runtimeAdapters: options.runtimeAdapters,
          defaultRuntimeAdapterId: options.defaultRuntimeAdapterId,
          publishedImage,
          ...(workspaceCloneAuth === undefined ? {} : { workspaceCloneAuth }),
          ...(Object.keys(credentialEnv).length === 0 ? {} : { credentialEnv }),
          ...(credentialFiles.length === 0 ? {} : { credentialFiles }),
          ...(job.runId === null ? {} : { runId: job.runId }),
        }),
      catch: toWorkspaceBuildJobProcessingError,
    });

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

  yield* launchAndRecord.pipe(Effect.tapError((error) => failureCleanup(error, false)));

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
    WorkspaceAttemptRepoLive,
    GitHubInstallationRepoLive,
    GitHubInstallationRepositoryCacheRepoLive,
    ConnectedAccountRepoLive,
  ).pipe(Layer.provide(dbLayer));

  return Effect.runPromise(
    processWorkspaceBuildJobEffect(options).pipe(Effect.provide(dataAccessLayer)),
  );
};
