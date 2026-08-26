/**
 * Cloudflare runtime configuration.
 *
 * The adapter never talks to Cloudflare's API directly: sandboxes can only be driven from inside
 * a Worker, so a deployment ships a *bridge Worker* (deploy/cloudflare) that owns sandbox
 * lifecycle and proxies the sealantd control stream. Everything the adapter needs is the bridge's
 * address and the token that authenticates this control plane to it. Docker and Kubernetes
 * deployments never construct this — the adapter is only built when both are set.
 */
import { z } from "zod";

export const cloudflareRuntimeConfigSchema = z.strictObject({
  /** Base URL of the bridge Worker; the adapter appends `/v1/…` routes. */
  bridgeUrl: z
    .string()
    .trim()
    .min(1)
    .refine((value) => value.startsWith("https://"), "must be https://")
    .transform((value) => value.replace(/\/+$/, "")),
  /** Bearer token authenticating this control plane to the bridge Worker. */
  bridgeToken: z.string().trim().min(1),
});

export type CloudflareRuntimeConfig = z.infer<typeof cloudflareRuntimeConfigSchema>;

export interface CloudflareRuntimeEnvLike {
  readonly SEALANT_CF_BRIDGE_URL?: string | undefined;
  readonly SEALANT_CF_BRIDGE_TOKEN?: string | undefined;
}

/** Undefined when the deployment is not configured for Cloudflare; throws on a half-set pair. */
export const cloudflareRuntimeConfigFromEnv = (
  env: CloudflareRuntimeEnvLike,
): CloudflareRuntimeConfig | undefined => {
  const url = env.SEALANT_CF_BRIDGE_URL;
  const token = env.SEALANT_CF_BRIDGE_TOKEN;
  if (url === undefined && token === undefined) {
    return undefined;
  }
  if (url === undefined || token === undefined) {
    throw new Error(
      "SEALANT_CF_BRIDGE_URL and SEALANT_CF_BRIDGE_TOKEN must be set together to enable the cloudflare runtime adapter.",
    );
  }
  return cloudflareRuntimeConfigSchema.parse({ bridgeUrl: url, bridgeToken: token });
};
