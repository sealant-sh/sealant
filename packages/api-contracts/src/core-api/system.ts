import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

export const systemIndexResponseSchema = Schema.Struct({
  name: NonEmptyString,
  version: NonEmptyString,
  docsPath: NonEmptyString,
  openApiPath: NonEmptyString,
  /**
   * What this control plane can do that an older one cannot, so a client refuses a request it would
   * otherwise send to a server that ignores part of it, and feature-detects instead of reading a
   * version (a self-built control plane reports `0.0.0`). Absent from older control planes:
   * nothing; an absent field: not this one.
   */
  features: Schema.optional(
    Schema.Struct({
      /**
       * Always `false` from this control plane: `user` on the plain exec and session routes is
       * refused. Kept, and kept false, because SDKs from before the as-user routes read `true` as
       * leave to send `user` on the plain routes, which a control plane from before `user` would
       * accept and run as the workspace's own user.
       */
      processUser: Schema.Boolean,
      /**
       * `POST /v1/workspaces/:id/exec-as-user` and `POST /v1/sessions/as-user` exist: a process
       * runs as a person's Linux user there. Whether a given workspace can is its read's
       * `processUser`; one that cannot is refused there (`409`, `user-unsupported`).
       */
      processUserRoutes: Schema.optional(Schema.Boolean),
      /** `POST /v1/workspaces/:id/dotfiles`: a person's dotfiles applied as their user. */
      dotfilesApply: Schema.optional(Schema.Boolean),
      /** `partial: true` on a credentials put: what is connected is written, the rest reported. */
      credentialsPartialPut: Schema.optional(Schema.Boolean),
      /** `pi` and `opencode` (ChatGPT logins from a Codex account) on a credentials put. */
      credentialsPiOpencode: Schema.optional(Schema.Boolean),
      /** `ownerMap` on a capture source: an executor whose restore gives each person their files. */
      captureOwnerMap: Schema.optional(Schema.Boolean),
    }),
  ),
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
