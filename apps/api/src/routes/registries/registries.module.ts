import {
  RegistriesBadGatewayError,
  RegistriesNotFoundError,
  type RegistryManifestQuery,
  type RegistryManifestResponse,
  type RegistryPing,
  type RegistrySummary,
  type RegistryTagsQuery,
  type RegistryTagsResponse,
  type RegistryExtensionsResponse,
} from "@sealant/api-contracts";
import { RegistryClientHttpError } from "@sealant/sandboxes";
import { Effect } from "effect";

import { env } from "../../runtime-env.js";
import { RegistryClientService } from "../../services/control-plane-capabilities.js";

const toErrorMessage = (error: unknown, fallback: string): string => {
  return error instanceof Error ? error.message : fallback;
};

const ensureRegistry = (registryId: string) => {
  if (registryId === env.REGISTRY_NAME) {
    return Effect.void;
  }

  return Effect.fail(
    new RegistriesNotFoundError({
      message: `Unknown registry: ${registryId}`,
    }),
  );
};

const mapRegistryFailure = (error: unknown) => {
  if (error instanceof RegistryClientHttpError) {
    return new RegistriesBadGatewayError({
      message: `Registry request failed with status ${error.status}.`,
    });
  }

  return new RegistriesBadGatewayError({
    message: toErrorMessage(error, "Registry request failed."),
  });
};

const withRegistryFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  return effect.pipe(Effect.mapError(mapRegistryFailure));
};

export const getRegistry = (registryId: string) => {
  return Effect.gen(function* () {
    yield* ensureRegistry(registryId);

    return {
      name: env.REGISTRY_NAME,
      baseUrl: env.REGISTRY_BASE_URL,
      pushRegistry: env.REGISTRY_PUSH_REGISTRY,
      hasBasicAuth: env.REGISTRY_USERNAME !== undefined,
    } satisfies RegistrySummary;
  });
};

export const pingRegistry = (registryId: string) => {
  return Effect.gen(function* () {
    const registryClient = yield* RegistryClientService;
    yield* ensureRegistry(registryId);
    yield* withRegistryFailure(
      Effect.tryPromise({
        try: () => registryClient.ping(),
        catch: (error) => error,
      }),
    );

    return {
      name: env.REGISTRY_NAME,
      reachable: true,
    } satisfies RegistryPing;
  });
};

export const listRegistryExtensions = (registryId: string) => {
  return Effect.gen(function* () {
    const registryClient = yield* RegistryClientService;
    yield* ensureRegistry(registryId);

    const extensions = yield* withRegistryFailure(
      Effect.tryPromise({
        try: () => registryClient.discoverExtensions(),
        catch: (error) => error,
      }),
    );

    return {
      extensions,
    } satisfies RegistryExtensionsResponse;
  });
};

export const listRegistryTags = (input: {
  readonly registryId: string;
  readonly query: RegistryTagsQuery;
}) => {
  return Effect.gen(function* () {
    const registryClient = yield* RegistryClientService;
    yield* ensureRegistry(input.registryId);

    const tags = yield* withRegistryFailure(
      Effect.tryPromise({
        try: () => registryClient.listTags(input.query.repository),
        catch: (error) => error,
      }),
    );

    return {
      repository: input.query.repository,
      tags,
    } satisfies RegistryTagsResponse;
  });
};

export const getRegistryManifest = (input: {
  readonly registryId: string;
  readonly query: RegistryManifestQuery;
}) => {
  return Effect.gen(function* () {
    const registryClient = yield* RegistryClientService;
    yield* ensureRegistry(input.registryId);

    const manifest = yield* withRegistryFailure(
      Effect.tryPromise({
        try: () => registryClient.getManifest(input.query.repository, input.query.reference),
        catch: (error) => error,
      }),
    );

    if (manifest === null) {
      return yield* new RegistriesNotFoundError({
        message: `Manifest not found for ${input.query.repository}:${input.query.reference}`,
      });
    }

    return {
      repository: input.query.repository,
      reference: input.query.reference,
      ...(manifest.digest === undefined ? {} : { digest: manifest.digest }),
      contentType: manifest.contentType,
      manifest: manifest.body,
    } satisfies RegistryManifestResponse;
  });
};
