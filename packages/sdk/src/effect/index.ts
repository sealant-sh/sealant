/**
 * @sealant/sdk/effect — the Effect-native core of the SDK, for consumers that are Effect end-to-end.
 *
 * The Promise facade (`@sealant/sdk`) is a thin wrapper over what this subpath exports directly:
 *
 *   - `SealantApiClient` + `sealantApiClientLayer` — the contract-derived control-plane client as an
 *     Effect service. The client is generated from the `@sealant/api-contracts` `HttpApi`, so its
 *     request/response types and tagged error channel are the contract's, by construction.
 *   - The operation effects (`createWorkspaceOp`, `createRunOp`, `getRunTimelineOp`, …) — one per
 *     contract endpoint, returning WIRE types on a typed error channel.
 *   - `makeSdkRuntime` — the managed runtime the facade itself runs on, for consumers who want the
 *     memoized layer build + `SealantError` mapping without hand-rolling a scope.
 *   - The tagged contract errors (`WorkspaceNotFoundError`, `RunNotFoundError`, …) so failures can be
 *     matched with `Effect.catchTag` instead of string-matching a squashed `SealantError`.
 *
 * Errors: effects composed from this subpath fail with the TYPED contract errors (plus Effect HTTP
 * client/schema errors) — nothing is squashed. The plain `SealantError` classes only enter play via
 * `makeSdkRuntime`, which maps the typed channel at the Promise boundary exactly like the facade.
 */

// The contract-derived client service + layer.
export { SealantApiClient, sealantApiClientLayer } from "./api-client.js";
export type { ControlPlaneClient } from "./api-client.js";

// One operation effect per contract endpoint (wire types in, wire types out).
export * from "./operations.js";

// The managed runtime the Promise facade runs on.
export { makeSdkRuntime } from "./runtime.js";
export type { SdkRuntime, SdkServices } from "./runtime.js";

// The config the layer/runtime constructors take, and the resolver from the public `SealantConfig`.
export { resolveInternalConfig } from "../internal/config.js";
export type { SealantHostLocalConfig, SealantInternalConfig } from "../internal/config.js";

// The typed contract errors carried on the client's failure channel (workspaces + runs — the groups
// the operations above call). Re-exported so Effect consumers don't need to depend on the contracts
// package directly to `Effect.catchTag` a failure.
export {
  RunBadRequestError,
  RunInternalServerError,
  RunNotFoundError,
  WorkspaceBadGatewayError,
  WorkspaceBadRequestError,
  WorkspaceConflictError,
  WorkspaceForbiddenError,
  WorkspaceInternalServerError,
  WorkspaceNotFoundError,
  WorkspaceServiceUnavailableError,
  WorkspaceUnauthorizedError,
} from "@sealant/api-contracts";
