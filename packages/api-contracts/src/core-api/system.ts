import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";

const NonEmptyString = Schema.NonEmptyTrimmedString;

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
  .add(HttpApiEndpoint.get("getIndex", "/").addSuccess(systemIndexResponseSchema))
  .add(HttpApiEndpoint.get("health", "/healthz").addSuccess(systemHealthResponseSchema))
  .add(HttpApiEndpoint.get("ready", "/readyz").addSuccess(systemHealthResponseSchema))
  .annotate(OpenApi.Description, "System metadata and health probes.");
