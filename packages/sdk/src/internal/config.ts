/**
 * Internal SDK configuration.
 *
 * The PUBLIC surface (`SealantConfig` in `../types.ts`) is intentionally minimal: `{ baseUrl, apiKey }`.
 * The current host-local slice also needs an owner principal, a registry id, and direct database
 * access for run bookkeeping. Those concerns live HERE — resolved from the environment with
 * docker-compose defaults — so they never leak into the published `SealantConfig`. As later phases
 * move all reads/writes behind authenticated HTTP endpoints, this internal shape shrinks with no
 * change to the public type.
 */
import type { SealantConfig } from "../types.js";

export interface SealantHostLocalConfig {
  /** Owner principal the control plane attributes sandboxes/runs to (pre-auth). */
  readonly ownerUserId: string;
  /** Registry the sandbox image is published to and launched from. */
  readonly registryId: string;
  /** Control-plane Postgres URL — host-local run bookkeeping until a server-side run API lands. */
  readonly databaseUrl: string;
}

export interface SealantInternalConfig {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly fetch: typeof fetch | undefined;
  readonly hostLocal: SealantHostLocalConfig;
}

const DEFAULT_DATABASE_URL = "postgresql://sealant:sealant@127.0.0.1:5433/sealant_control_plane";
const DEFAULT_OWNER_USER_ID = "usr_local";
// Must match the control-plane's REGISTRY_NAME (defaults to "default"); the API 404s otherwise.
const DEFAULT_REGISTRY_ID = "default";

const env = (key: string): string | undefined => {
  const value = process.env[key];
  return value === undefined || value.length === 0 ? undefined : value;
};

/** Resolves the public config plus host-local needs (from env, with docker-compose defaults). */
export const resolveInternalConfig = (config: SealantConfig): SealantInternalConfig => ({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  fetch: config.fetch,
  hostLocal: {
    ownerUserId: env("SEALANT_OWNER_USER_ID") ?? DEFAULT_OWNER_USER_ID,
    registryId: env("SEALANT_REGISTRY_ID") ?? DEFAULT_REGISTRY_ID,
    databaseUrl: env("SEALANT_DATABASE_URL") ?? env("DATABASE_URL") ?? DEFAULT_DATABASE_URL,
  },
});
