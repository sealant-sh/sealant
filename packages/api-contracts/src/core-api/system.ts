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

export const setupStateSshGatewaySchema = Schema.Struct({
  host: NonEmptyString,
  // Defaults (22 / "ws") are applied server-side so clients never hardcode them.
  port: Schema.Number,
  usernamePrefix: NonEmptyString,
});
export type SetupStateSshGateway = typeof setupStateSshGatewaySchema.Type;

export const setupStateResponseSchema = Schema.Struct({
  // True while nobody can sign in (zero better-auth accounts); drives the first-run wizard. The
  // seeded SDK owner (usr_local) has no credentials and does not count.
  needsSetup: Schema.Boolean,
  // Null when WORKSPACE_SSH_GATEWAY_HOST is not configured on the API.
  sshGateway: Schema.NullOr(setupStateSshGatewaySchema),
});
export type SetupStateResponse = typeof setupStateResponseSchema.Type;

export class SystemInternalServerError extends Schema.TaggedErrorClass<SystemInternalServerError>()(
  "SystemInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export const SystemGroup = HttpApiGroup.make("system")
  .add(HttpApiEndpoint.get("getIndex", "/", { success: systemIndexResponseSchema }))
  .add(HttpApiEndpoint.get("health", "/healthz", { success: systemHealthResponseSchema }))
  .add(HttpApiEndpoint.get("ready", "/readyz", { success: systemHealthResponseSchema }))
  .add(
    // Public by design: pre-auth gating in the web app needs it. Exposes only needsSetup and the
    // gateway connect coordinates (host/port/prefix), which every workspace endpoint echoes anyway.
    HttpApiEndpoint.get("getSetupState", "/v1/system/setup-state", {
      success: setupStateResponseSchema,
      error: [SystemInternalServerError],
    }),
  )
  .annotate(OpenApi.Description, "System metadata, health probes, and first-run setup state.");
