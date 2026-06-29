/** Runtime config for the `sealant` CLI, resolved from the environment with sensible local defaults. */
export interface CliConfig {
  /** Control-plane base URL (no trailing slash). */
  readonly baseUrl: string;
  /** Owner principal these operations run as. Pre-auth this is the seeded local owner. */
  readonly ownerUserId: string;
  /** Optional bearer token for authenticated deployments. */
  readonly apiKey: string | undefined;
}

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

export const resolveConfig = (env: NodeJS.ProcessEnv = process.env): CliConfig => ({
  baseUrl: stripTrailingSlash(env.SEALANT_BASE_URL ?? "http://localhost:4000"),
  ownerUserId: env.SEALANT_OWNER_USER_ID ?? "usr_local",
  apiKey: env.SEALANT_API_KEY,
});
