import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

export const registryIdParamsSchema = Schema.Struct({
  registryId: NonEmptyString,
});
export type RegistryIdParams = typeof registryIdParamsSchema.Type;

export const registrySummarySchema = Schema.Struct({
  name: NonEmptyString,
  baseUrl: Schema.String,
  pushRegistry: NonEmptyString,
  hasBasicAuth: Schema.Boolean,
});
export type RegistrySummary = typeof registrySummarySchema.Type;

export const registryPingSchema = Schema.Struct({
  name: NonEmptyString,
  reachable: Schema.Literal(true),
});
export type RegistryPing = typeof registryPingSchema.Type;

export const registryExtensionSchema = Schema.Struct({
  name: NonEmptyString,
  url: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  endpoints: Schema.Array(Schema.String),
});

export const registryExtensionsResponseSchema = Schema.Struct({
  extensions: Schema.Array(registryExtensionSchema),
});
export type RegistryExtensionsResponse = typeof registryExtensionsResponseSchema.Type;

export const registryTagsQuerySchema = Schema.Struct({
  repository: NonEmptyString,
});
export type RegistryTagsQuery = typeof registryTagsQuerySchema.Type;

export const registryTagsResponseSchema = Schema.Struct({
  repository: NonEmptyString,
  tags: Schema.Array(Schema.String),
});
export type RegistryTagsResponse = typeof registryTagsResponseSchema.Type;

export const registryManifestQuerySchema = Schema.Struct({
  repository: NonEmptyString,
  reference: NonEmptyString,
});
export type RegistryManifestQuery = typeof registryManifestQuerySchema.Type;

export const registryManifestResponseSchema = Schema.Struct({
  repository: NonEmptyString,
  reference: NonEmptyString,
  digest: Schema.optional(Schema.String),
  contentType: Schema.Union([Schema.String, Schema.Null]),
  manifest: Schema.Unknown,
});
export type RegistryManifestResponse = typeof registryManifestResponseSchema.Type;

export class RegistriesNotFoundError extends Schema.TaggedErrorClass<RegistriesNotFoundError>()(
  "RegistriesNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class RegistriesBadGatewayError extends Schema.TaggedErrorClass<RegistriesBadGatewayError>()(
  "RegistriesBadGatewayError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {}

const registryIdParams = Schema.Struct({ registryId: NonEmptyString });

export const RegistriesGroup = HttpApiGroup.make("registries")
  .add(
    HttpApiEndpoint.get("getRegistry", "/:registryId", {
      params: registryIdParams,
      success: registrySummarySchema,
      error: RegistriesNotFoundError,
    }),
  )
  .add(
    HttpApiEndpoint.get("pingRegistry", "/:registryId/ping", {
      params: registryIdParams,
      success: registryPingSchema,
      error: [RegistriesNotFoundError, RegistriesBadGatewayError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listRegistryExtensions", "/:registryId/extensions", {
      params: registryIdParams,
      success: registryExtensionsResponseSchema,
      error: [RegistriesNotFoundError, RegistriesBadGatewayError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listRegistryTags", "/:registryId/tags", {
      params: registryIdParams,
      query: registryTagsQuerySchema,
      success: registryTagsResponseSchema,
      error: [RegistriesNotFoundError, RegistriesBadGatewayError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRegistryManifest", "/:registryId/manifest", {
      params: registryIdParams,
      query: registryManifestQuerySchema,
      success: registryManifestResponseSchema,
      error: [RegistriesNotFoundError, RegistriesBadGatewayError],
    }),
  )
  .annotate(OpenApi.Description, "Registry metadata and OCI read operations.");
