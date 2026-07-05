import {
  GitHubInstallationRepo,
  GitHubInstallationRepoLive,
  GitHubInstallationRepositoryCacheRepo,
  GitHubInstallationRepositoryCacheRepoLive,
  SandboxAttemptRepo,
  SandboxAttemptRepoLive,
  SandboxBuildJobRepo,
  SandboxBuildJobRepoLive,
  SandboxRuntimeInstanceRepo,
  SandboxRuntimeInstanceRepoLive,
  SealantDB,
  type DB,
} from "@sealant/db";
import { type GitHubSourceIntegration } from "@sealant/source-integrations";
import { newSandboxSchema, type NewSandbox, type SandboxBuild } from "@sealant/validators";
import { Effect, Layer } from "effect";

import { compileSandboxBuildSpec } from "../buildkit/index.js";
import type { RegistryClient } from "../registry/index.js";
import {
  selectRuntimeAdapter,
  type PublishedImage,
  type RuntimeAdapter,
  type RuntimeAdapterId,
  type SandboxCloneAuth,
} from "../runtime/index.js";
import { SandboxBuildJobProcessingError, toSandboxBuildJobProcessingError } from "./errors.js";
import {
  resolveDotfilesRuntimeEnv,
  resolveSandboxCloneAuth,
} from "./github-installation-auth-resolver.js";

export { SandboxBuildJobProcessingError } from "./errors.js";

/** Repository services the job pipeline resolves from context. */
export type ProcessSandboxBuildJobRequirements =
  | SandboxBuildJobRepo
  | SandboxRuntimeInstanceRepo
  | SandboxAttemptRepo
  | GitHubInstallationRepo
  | GitHubInstallationRepositoryCacheRepo;

export interface ProcessSandboxBuildJobOptions {
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly db: DB;
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  readonly defaultRuntimeAdapterId: RuntimeAdapterId;
  readonly registryClient: RegistryClient;
  readonly gitHubSourceIntegration?: GitHubSourceIntegration;
  readonly compileSandboxSpec?: (spec: NewSandbox) => Promise<SandboxBuild>;
}

/** Options for the Effect-native pipeline: repositories come from context, not `db`. */
export type ProcessSandboxBuildJobEffectOptions = Omit<ProcessSandboxBuildJobOptions, "db">;

const isPublishableOciImageArtifact = (
  artifact: SandboxBuild["artifacts"][number],
): artifact is SandboxBuild["artifacts"][number] & {
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

const selectPublishableImageArtifact = (compileResult: SandboxBuild) => {
  const artifact = compileResult.artifacts.find(isPublishableOciImageArtifact);

  if (artifact === undefined) {
    throw new Error("The compiler did not return a publishable OCI image artifact.");
  }

  return artifact;
};

const launchPublishedImage = async (input: {
  readonly spec: NewSandbox;
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  readonly defaultRuntimeAdapterId: RuntimeAdapterId;
  readonly publishedImage: PublishedImage;
  readonly sandboxCloneAuth?: SandboxCloneAuth;
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
    ...(input.sandboxCloneAuth === undefined ? {} : { sandboxCloneAuth: input.sandboxCloneAuth }),
    // Deterministic per-run container name -> idempotent launch/adopt (#4).
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  });
};

/**
 * Run a best-effort state update: never propagate its failure (so it cannot mask the originating
 * error), but log a warning so a failed status update is still observable instead of silent.
 */
const swallowingFailure =
  (operation: string) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`Sandbox build job ${operation} failed; continuing.`, cause),
      ),
      Effect.asVoid,
    );

/**
 * Process a single sandbox build job as one Effect program.
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
export const processSandboxBuildJobEffect = Effect.fn("processSandboxBuildJob")(function* (
  options: ProcessSandboxBuildJobEffectOptions,
) {
  const jobs = yield* SandboxBuildJobRepo;
  const runtimeInstances = yield* SandboxRuntimeInstanceRepo;
  const attempts = yield* SandboxAttemptRepo;

  const job = yield* jobs
    .claimJobById({
      id: options.jobId,
      workerId: options.workerId,
      leaseDurationMs: options.leaseDurationMs,
    })
    .pipe(Effect.mapError(toSandboxBuildJobProcessingError));

  if (job === null) {
    return null;
  }

  yield* Effect.annotateCurrentSpan({
    jobId: job.id,
    ...(job.runId === null ? {} : { runId: job.runId }),
  });

  // Best-effort cleanup shared by both phases. Every step swallows its own failure so the
  // originating error is the one that propagates.
  const failureCleanup = (error: SandboxBuildJobProcessingError, markJobAsFailed: boolean) =>
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
      try: () => newSandboxSchema.parse(job.requestPayload),
      catch: toSandboxBuildJobProcessingError,
    });

    const compileSpec =
      options.compileSandboxSpec ??
      ((inputSpec: NewSandbox): Promise<SandboxBuild> =>
        compileSandboxBuildSpec({ blueprint: inputSpec }));

    const compileResult = yield* Effect.tryPromise({
      try: () => compileSpec(spec),
      catch: toSandboxBuildJobProcessingError,
    });

    const imageArtifact = yield* Effect.try({
      try: () => selectPublishableImageArtifact(compileResult),
      catch: toSandboxBuildJobProcessingError,
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
      catch: toSandboxBuildJobProcessingError,
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
      .pipe(Effect.mapError(toSandboxBuildJobProcessingError));

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
        .pipe(Effect.mapError(toSandboxBuildJobProcessingError));
    }

    const sandboxCloneAuth = yield* resolveSandboxCloneAuth({
      spec,
      gitHubSourceIntegration: options.gitHubSourceIntegration,
    });
    const dotfilesRuntimeEnv = yield* resolveDotfilesRuntimeEnv({
      spec,
      gitHubSourceIntegration: options.gitHubSourceIntegration,
    });

    const runtimeSpec: NewSandbox =
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
          ...(sandboxCloneAuth === undefined ? {} : { sandboxCloneAuth }),
          ...(job.runId === null ? {} : { runId: job.runId }),
        }),
      catch: toSandboxBuildJobProcessingError,
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
        .pipe(Effect.mapError(toSandboxBuildJobProcessingError));
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
 * Process a single sandbox build job.
 *
 * Thin Promise boundary used by the worker: it provides the live data-access layer (built from
 * `options.db`) exactly once and runs the Effect pipeline. A failed job rejects with a
 * {@link SandboxBuildJobProcessingError}.
 */
export const processSandboxBuildJob = (
  options: ProcessSandboxBuildJobOptions,
): Promise<PublishedImage | null> => {
  const dbLayer = Layer.succeed(SealantDB, options.db);
  const dataAccessLayer = Layer.mergeAll(
    SandboxBuildJobRepoLive,
    SandboxRuntimeInstanceRepoLive,
    SandboxAttemptRepoLive,
    GitHubInstallationRepoLive,
    GitHubInstallationRepositoryCacheRepoLive,
  ).pipe(Layer.provide(dbLayer));

  return Effect.runPromise(
    processSandboxBuildJobEffect(options).pipe(Effect.provide(dataAccessLayer)),
  );
};
