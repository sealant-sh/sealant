import type {
  BuildkitOsBuilderCompileResult,
  BuildkitTargetOsFamily,
  ResolvedImagePlan,
  SandboxBlueprint,
} from "@sealant/validators";
import { Context, Effect, Layer, Schema } from "effect";

import {
  BuildkitBuilder,
  buildkitBuilderLayer,
  type BuildkitCommandRunner,
  type BuildkitCompilerOptions,
} from "./buildkit/index.js";
import {
  createPackageStandardizer,
  createRepologyClient,
  type PackageResolution,
  type PackageTargetOs,
} from "./package-standardization.js";
import {
  publishSandboxBuildJobRequested as publishSandboxBuildJobRequestedMessage,
  sandboxBuildJobRequestedMessageKind,
} from "./queue/index.js";
import {
  createZotRegistryClient,
  RegistryClientHttpError,
  type RegistryExtension,
  type RegistryManifest,
} from "./registry/index.js";

const sandboxesServiceOperationSchema = Schema.Literal(
  "resolvePackage",
  "pingRegistry",
  "discoverRegistryExtensions",
  "listRegistryTags",
  "getRegistryManifest",
  "publishSandboxBuildJobRequested",
  "selectBuildkitOsFamily",
  "mapBlueprintToBuildkitImagePlan",
  "compileSandboxBuildSpec",
);

const sandboxesRegistryOperationSchema = Schema.Literal(
  "pingRegistry",
  "discoverRegistryExtensions",
  "listRegistryTags",
  "getRegistryManifest",
);

const sandboxesBuildkitOperationSchema = Schema.Literal(
  "selectBuildkitOsFamily",
  "mapBlueprintToBuildkitImagePlan",
  "compileSandboxBuildSpec",
);

type SandboxesServiceOperation = typeof sandboxesServiceOperationSchema.Type;

type SandboxesRegistryOperation = typeof sandboxesRegistryOperationSchema.Type;

type SandboxesBuildkitOperation = typeof sandboxesBuildkitOperationSchema.Type;

export class SandboxesRegistryRequestError extends Schema.TaggedError<SandboxesRegistryRequestError>(
  "SandboxesRegistryRequestError",
)("SandboxesRegistryRequestError", {
  operation: sandboxesRegistryOperationSchema,
  statusCode: Schema.Number,
  message: Schema.String,
}) {}

export class SandboxesBuildkitError extends Schema.TaggedError<SandboxesBuildkitError>(
  "SandboxesBuildkitError",
)("SandboxesBuildkitError", {
  operation: sandboxesBuildkitOperationSchema,
  code: Schema.String,
  message: Schema.String,
}) {}

export class SandboxesUnexpectedError extends Schema.TaggedError<SandboxesUnexpectedError>(
  "SandboxesUnexpectedError",
)("SandboxesUnexpectedError", {
  operation: sandboxesServiceOperationSchema,
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export const sandboxesServiceErrorSchema = Schema.Union(
  SandboxesRegistryRequestError,
  SandboxesBuildkitError,
  SandboxesUnexpectedError,
);

export type SandboxesServiceError = typeof sandboxesServiceErrorSchema.Type;

export interface SandboxesServiceConfigValue {
  readonly rabbitMqUrl: string;
  readonly registryBaseUrl: string;
  readonly registryPushRegistry: string;
  readonly registryUsername?: string;
  readonly registryPassword?: string;
  readonly repologyApiBaseUrl: string;
  readonly repologyUserAgent: string;
  readonly repologyRequestTimeoutMs: number;
  readonly repologyMinimumIntervalMs: number;
  readonly buildkitCommandRunner?: BuildkitCommandRunner;
  readonly buildkitAutoOsFamilyOrder?: readonly BuildkitTargetOsFamily[];
}

export class SandboxesServiceConfig extends Context.Tag(
  "@sealant/sandboxes/SandboxesServiceConfig",
)<SandboxesServiceConfig, SandboxesServiceConfigValue>() {}

export interface SandboxesServiceApi {
  readonly resolvePackage: (input: {
    readonly query: string;
    readonly targetOs?: PackageTargetOs;
  }) => Effect.Effect<PackageResolution, SandboxesServiceError>;
  readonly pingRegistry: () => Effect.Effect<void, SandboxesServiceError>;
  readonly discoverRegistryExtensions: () => Effect.Effect<
    readonly RegistryExtension[],
    SandboxesServiceError
  >;
  readonly listRegistryTags: (input: {
    readonly repository: string;
  }) => Effect.Effect<readonly string[], SandboxesServiceError>;
  readonly getRegistryManifest: (input: {
    readonly repository: string;
    readonly reference: string;
  }) => Effect.Effect<RegistryManifest | null, SandboxesServiceError>;
  readonly publishSandboxBuildJobRequested: (input: {
    readonly jobId: string;
  }) => Effect.Effect<void, SandboxesServiceError>;
  readonly selectBuildkitOsFamily: (input: {
    readonly blueprint: SandboxBlueprint;
    readonly autoOsFamilyOrder?: readonly BuildkitTargetOsFamily[];
  }) => Effect.Effect<BuildkitTargetOsFamily, SandboxesServiceError>;
  readonly mapBlueprintToBuildkitImagePlan: (input: {
    readonly blueprint: SandboxBlueprint;
    readonly osFamily: BuildkitTargetOsFamily;
  }) => Effect.Effect<ResolvedImagePlan, SandboxesServiceError>;
  readonly compileSandboxBuildSpec: (input: {
    readonly blueprint: SandboxBlueprint;
    readonly options?: BuildkitCompilerOptions;
  }) => Effect.Effect<BuildkitOsBuilderCompileResult, SandboxesServiceError>;
}

export class SandboxesService extends Context.Tag("@sealant/sandboxes/SandboxesService")<
  SandboxesService,
  SandboxesServiceApi
>() {}

const toErrorMessage = (error: unknown, fallback: string): string => {
  return error instanceof Error ? error.message : fallback;
};

const isRegistryOperation = (
  operation: SandboxesServiceOperation,
): operation is SandboxesRegistryOperation => {
  return (
    operation === "pingRegistry" ||
    operation === "discoverRegistryExtensions" ||
    operation === "listRegistryTags" ||
    operation === "getRegistryManifest"
  );
};

const isBuildkitOperation = (
  operation: SandboxesServiceOperation,
): operation is SandboxesBuildkitOperation => {
  return (
    operation === "selectBuildkitOsFamily" ||
    operation === "mapBlueprintToBuildkitImagePlan" ||
    operation === "compileSandboxBuildSpec"
  );
};

const isBuildkitErrorCause = (
  cause: unknown,
): cause is { readonly code: string; readonly message: string } => {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    "message" in cause &&
    typeof cause.code === "string" &&
    typeof cause.message === "string"
  );
};

const toSandboxesServiceError = (
  operation: SandboxesServiceOperation,
  cause: unknown,
): SandboxesServiceError => {
  if (
    cause instanceof SandboxesRegistryRequestError ||
    cause instanceof SandboxesBuildkitError ||
    cause instanceof SandboxesUnexpectedError
  ) {
    return cause;
  }

  if (isRegistryOperation(operation) && cause instanceof RegistryClientHttpError) {
    return new SandboxesRegistryRequestError({
      operation,
      statusCode: cause.status,
      message: cause.message,
    });
  }

  if (isBuildkitOperation(operation) && isBuildkitErrorCause(cause)) {
    return new SandboxesBuildkitError({
      operation,
      code: cause.code,
      message: cause.message,
    });
  }

  return new SandboxesUnexpectedError({
    operation,
    message: toErrorMessage(cause, `${operation} failed.`),
    cause,
  });
};

const withSandboxesServiceError = <A>(
  operation: SandboxesServiceOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, SandboxesServiceError> => {
  return effect.pipe(Effect.mapError((cause) => toSandboxesServiceError(operation, cause)));
};

export const SandboxesServiceLive = Layer.effect(
  SandboxesService,
  Effect.gen(function* () {
    const config = yield* SandboxesServiceConfig;
    const buildkitBuilder = yield* BuildkitBuilder;

    const repologyClient = createRepologyClient({
      baseUrl: config.repologyApiBaseUrl,
      userAgent: config.repologyUserAgent,
      requestTimeoutMs: config.repologyRequestTimeoutMs,
      minimumIntervalMs: config.repologyMinimumIntervalMs,
    });

    const packageStandardizer = createPackageStandardizer({
      repologyClient,
    });

    const registryClient = createZotRegistryClient({
      baseUrl: config.registryBaseUrl,
      pushRegistry: config.registryPushRegistry,
      ...(config.registryUsername === undefined ? {} : { username: config.registryUsername }),
      ...(config.registryPassword === undefined ? {} : { password: config.registryPassword }),
    });

    return {
      resolvePackage: (input) =>
        withSandboxesServiceError(
          "resolvePackage",
          Effect.tryPromise({
            try: () =>
              packageStandardizer.resolvePackage({
                query: input.query,
                ...(input.targetOs === undefined ? {} : { targetOs: input.targetOs }),
              }),
            catch: (cause) => cause,
          }),
        ),

      pingRegistry: () =>
        withSandboxesServiceError(
          "pingRegistry",
          Effect.tryPromise({
            try: () => registryClient.ping(),
            catch: (cause) => cause,
          }),
        ),

      discoverRegistryExtensions: () =>
        withSandboxesServiceError(
          "discoverRegistryExtensions",
          Effect.tryPromise({
            try: () => registryClient.discoverExtensions(),
            catch: (cause) => cause,
          }),
        ),

      listRegistryTags: (input) =>
        withSandboxesServiceError(
          "listRegistryTags",
          Effect.tryPromise({
            try: () => registryClient.listTags(input.repository),
            catch: (cause) => cause,
          }),
        ),

      getRegistryManifest: (input) =>
        withSandboxesServiceError(
          "getRegistryManifest",
          Effect.tryPromise({
            try: () => registryClient.getManifest(input.repository, input.reference),
            catch: (cause) => cause,
          }),
        ),

      publishSandboxBuildJobRequested: (input) =>
        withSandboxesServiceError(
          "publishSandboxBuildJobRequested",
          Effect.tryPromise({
            try: () =>
              publishSandboxBuildJobRequestedMessage(config.rabbitMqUrl, {
                kind: sandboxBuildJobRequestedMessageKind,
                jobId: input.jobId,
              }),
            catch: (cause) => cause,
          }),
        ),

      selectBuildkitOsFamily: (input) =>
        withSandboxesServiceError(
          "selectBuildkitOsFamily",
          buildkitBuilder.selectBuildkitOsFamily(input),
        ),

      mapBlueprintToBuildkitImagePlan: (input) =>
        withSandboxesServiceError(
          "mapBlueprintToBuildkitImagePlan",
          buildkitBuilder.mapBlueprintToBuildkitImagePlan(input),
        ),

      compileSandboxBuildSpec: (input) =>
        withSandboxesServiceError(
          "compileSandboxBuildSpec",
          buildkitBuilder.compileSandboxBuildSpec(input),
        ),
    } satisfies SandboxesServiceApi;
  }),
);

const buildkitCompilerOptionsFromConfig = (
  config: SandboxesServiceConfigValue,
): BuildkitCompilerOptions | undefined => {
  const options: BuildkitCompilerOptions = {
    ...(config.buildkitCommandRunner === undefined
      ? {}
      : { commandRunner: config.buildkitCommandRunner }),
    ...(config.buildkitAutoOsFamilyOrder === undefined
      ? {}
      : { autoOsFamilyOrder: config.buildkitAutoOsFamilyOrder }),
  };

  if (options.commandRunner === undefined && options.autoOsFamilyOrder === undefined) {
    return undefined;
  }

  return options;
};

export const sandboxesServiceLayer = (config: SandboxesServiceConfigValue) => {
  const configLayer = Layer.succeed(SandboxesServiceConfig, config);
  const buildkitLayer = buildkitBuilderLayer(buildkitCompilerOptionsFromConfig(config) ?? {});

  return SandboxesServiceLive.pipe(Layer.provide(buildkitLayer), Layer.provide(configLayer));
};
