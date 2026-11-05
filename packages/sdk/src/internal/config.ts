/**
 * Internal SDK configuration.
 *
 * The PUBLIC surface (`SealantConfig` in `../types.ts`) is intentionally minimal: `{ baseUrl, apiKey }`.
 * The SDK is now a thin HTTP client (run execution + telemetry moved server-side), so the only
 * host-local concerns left are the owner principal and the registry id used on create/run
 * payloads. The owner comes from `SealantConfig.ownerUserId` when a product acts on behalf of a
 * specific user (one client per user), else from the environment with docker-compose defaults.
 */
import type { RequestPriority, SealantConfig } from "../types.js";

export interface SealantHostLocalConfig {
  /** Owner principal the control plane attributes workspaces/runs to (pre-auth). */
  readonly ownerUserId: string;
  /** Registry the workspace image is published to and launched from. */
  readonly registryId: string;
}

export interface SealantInternalConfig {
  readonly requestPriority?: SealantConfig["requestPriority"];
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly fetch: typeof fetch | undefined;
  readonly hostLocal: SealantHostLocalConfig;
}

const DEFAULT_OWNER_USER_ID = "usr_local";
// Must match the control-plane's REGISTRY_NAME (defaults to "default"); the API 404s otherwise.
const DEFAULT_REGISTRY_ID = "default";

/** Resolve the caller's priority at dispatch, before falling back to the operation default. */
export const resolveRequestPriority = (
  configured: SealantConfig["requestPriority"],
  operationDefault: RequestPriority = "normal",
): RequestPriority =>
  typeof configured === "function" ? configured() : (configured ?? operationDefault);

const env = (key: string): string | undefined => {
  const value = process.env[key];
  return value === undefined || value.length === 0 ? undefined : value;
};

/** Resolves the public config plus host-local needs (from env, with docker-compose defaults). */
export const resolveInternalConfig = (config: SealantConfig): SealantInternalConfig => ({
  baseUrl: config.baseUrl,
  ...(config.requestPriority === undefined ? {} : { requestPriority: config.requestPriority }),
  apiKey: config.apiKey,
  fetch: config.fetch,
  hostLocal: {
    ownerUserId: config.ownerUserId ?? env("SEALANT_OWNER_USER_ID") ?? DEFAULT_OWNER_USER_ID,
    registryId: env("SEALANT_REGISTRY_ID") ?? DEFAULT_REGISTRY_ID,
  },
});
