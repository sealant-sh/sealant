import {
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
import {
  resolveDotfilesRuntimeEnv,
  resolveSandboxCloneAuth,
} from "./github-installation-auth-resolver.js";

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
  });
};

const toErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : "Sandbox build job failed.";
};

const toErrorCode = (error: unknown) => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return undefined;
};

export const processSandboxBuildJob = async (options: ProcessSandboxBuildJobOptions) => {
  const dbLayer = Layer.succeed(SealantDB, options.db);
  const dataAccessLayer = Layer.mergeAll(
    SandboxBuildJobRepoLive,
    SandboxRuntimeInstanceRepoLive,
    SandboxAttemptRepoLive,
  ).pipe(Layer.provide(dbLayer));

  const repos = await Effect.runPromise(
    Effect.gen(function* () {
      return {
        jobs: yield* SandboxBuildJobRepo,
        runtimeInstances: yield* SandboxRuntimeInstanceRepo,
        attempts: yield* SandboxAttemptRepo,
      };
    }).pipe(Effect.provide(dataAccessLayer)),
  );

  const runDb = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => {
    return Effect.runPromise(effect);
  };

  const jobs = repos.jobs;
  const runtimeInstances = repos.runtimeInstances;
  const attempts = repos.attempts;
  const job = await runDb(
    jobs.claimJobById({
      id: options.jobId,
      workerId: options.workerId,
      leaseDurationMs: options.leaseDurationMs,
    }),
  );

  if (job === null) {
    return null;
  }

  let buildSucceeded = false;

  try {
    if (job.runId !== null) {
      await runDb(attempts.markAttemptRunning({ id: job.runId })).catch(() => null);
    }

    const spec = newSandboxSchema.parse(job.requestPayload);
    const compileSpec =
      options.compileSandboxSpec ??
      (async (inputSpec: NewSandbox): Promise<SandboxBuild> => {
        return compileSandboxBuildSpec({ blueprint: inputSpec });
      });
    const compileResult = await compileSpec(spec);
    const imageArtifact = selectPublishableImageArtifact(compileResult);
    const publishedImage = await options.registryClient.publishOciImage({
      artifactPath: imageArtifact.path,
      repository: job.repository,
      tag: job.tag,
      ...(imageArtifact.reference === undefined
        ? {}
        : { sourceReference: imageArtifact.reference }),
    });
    const resultPayload: SandboxBuild = compileResult;

    await runDb(
      jobs.markJobSucceeded({
        id: job.id,
        builderId: compileResult.builder.id,
        resultPayload,
        publishedReference: publishedImage.reference,
        publishedDigestReference: publishedImage.digestReference,
        publishedDigest: publishedImage.digest,
      }),
    );
    buildSucceeded = true;

    if (job.runId !== null) {
      await runDb(
        runtimeInstances.upsertRuntimeInstance({
          runId: job.runId,
          status: "pending",
        }),
      );
    }

    const sandboxCloneAuth = await resolveSandboxCloneAuth({
      spec,
      db: options.db,
      gitHubSourceIntegration: options.gitHubSourceIntegration,
    });
    const dotfilesRuntimeEnv = await resolveDotfilesRuntimeEnv({
      spec,
      db: options.db,
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

    const runtimeLaunchResult = await launchPublishedImage({
      spec: runtimeSpec,
      runtimeAdapters: options.runtimeAdapters,
      defaultRuntimeAdapterId: options.defaultRuntimeAdapterId,
      publishedImage,
      ...(sandboxCloneAuth === undefined ? {} : { sandboxCloneAuth }),
    });

    if (job.runId !== null) {
      await runDb(
        runtimeInstances.upsertRuntimeInstance({
          runId: job.runId,
          status: runtimeLaunchResult.status,
          adapter: runtimeLaunchResult.adapter,
          resourceId: runtimeLaunchResult.resourceId,
          reference: runtimeLaunchResult.reference,
          ...(runtimeLaunchResult.endpoint === undefined
            ? {}
            : { endpoint: runtimeLaunchResult.endpoint }),
          launchedAt: new Date(),
        }),
      );
    }

    if (job.runId !== null) {
      await runDb(attempts.markAttemptSucceeded({ id: job.runId })).catch(() => null);
    }

    return publishedImage;
  } catch (error) {
    const errorCode = toErrorCode(error);

    if (job.runId !== null) {
      await runDb(
        runtimeInstances.upsertRuntimeInstance({
          runId: job.runId,
          status: "failed",
          ...(errorCode === undefined ? {} : { errorCode }),
          errorMessage: toErrorMessage(error),
          finishedAt: new Date(),
        }),
      );
    }

    await Promise.allSettled([
      ...(buildSucceeded
        ? []
        : [
            runDb(
              jobs.markJobFailed({
                id: job.id,
                errorMessage: toErrorMessage(error),
                ...(errorCode === undefined ? {} : { errorCode }),
              }),
            ),
          ]),
      ...(job.runId === null ? [] : [runDb(attempts.markAttemptFailed({ id: job.runId }))]),
    ]);

    throw error;
  }
};
