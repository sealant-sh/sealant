import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

export const systemIndexResponseSchema = Schema.Struct({
  name: NonEmptyString,
  version: NonEmptyString,
  docsPath: NonEmptyString,
  openApiPath: NonEmptyString,
});
export type SystemIndexResponse = typeof systemIndexResponseSchema.Type;

export const systemHealthResponseSchema = Schema.Struct({
  status: Schema.Literal("ok"),
});
export type SystemHealthResponse = typeof systemHealthResponseSchema.Type;

export const SystemGroup = HttpApiGroup.make("system")
  .add(HttpApiEndpoint.get("getIndex", "/", { success: systemIndexResponseSchema }))
  .add(HttpApiEndpoint.get("health", "/healthz", { success: systemHealthResponseSchema }))
  .add(HttpApiEndpoint.get("ready", "/readyz", { success: systemHealthResponseSchema }))
  .annotate(OpenApi.Description, "System metadata and health probes.");
