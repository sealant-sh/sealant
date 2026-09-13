/**
 * Lambda MicroVM runtime configuration (worker; the API and SSH gateway need only the region and
 * agent port to mint endpoint tokens for control connections).
 *
 * Validated once from the environment; nothing here touches AWS. Docker, Kubernetes and
 * Cloudflare deployments never construct this — the adapter is only built when
 * `SEALANT_MICROVM_IMAGE_ARN` is set. Sizing is NOT here on purpose: `RunMicrovm` takes no
 * vCPU/memory/disk — they are properties of the image version (`resources.minimumMemoryInMiB`,
 * vCPU = memory / 2 GiB, disk by tier: 16 GiB at 4 GiB), set by `microvm-image/build-image.sh`.
 * The POC defaults (4 GiB → 2 vCPU / 16 GiB) live there.
 *
 * Sources (read 2026-09-13): https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html
 * (maximumDurationInSeconds 1–28800), https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmAuthToken.html
 * (expirationInMinutes ≤ 60), https://docs.aws.amazon.com/lambda/latest/microvm-api/API_MicrovmHooks.html
 * (hook timeouts 1–60 s), https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html#microvms-images-sizing.
 */
import { z } from "zod";

/** The platform's hard lifetime cap, suspended time included (not adjustable). */
export const MICROVM_MAX_DURATION_CAP_SECONDS = 28_800;
/** The longest a runtime hook may run before the platform gives up on it. */
export const MICROVM_HOOK_TIMEOUT_CAP_SECONDS = 60;
/** The longest-lived endpoint token the platform mints. */
export const MICROVM_ENDPOINT_TOKEN_MAX_MINUTES = 60;

const imageArnSchema = z
  .string()
  .trim()
  .regex(
    /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:microvm-image:[A-Za-z0-9_-]+$/,
    "must be a MicroVM image ARN (arn:aws:lambda:<region>:<account>:microvm-image:<name>)",
  );

const roleArnSchema = z
  .string()
  .trim()
  .regex(/^arn:aws[a-z-]*:iam::\d{12}:role\/.+$/, "must be an IAM role ARN");

const connectorArnSchema = z
  .string()
  .trim()
  .regex(/^arn:aws[a-z-]*:lambda:[a-z0-9-]+:(\d{12}|aws):network-connector:.+$/, {
    message: "must be a Lambda network connector ARN",
  });

/** The AWS-managed connector that gives a VM its inbound endpoint (control reach needs it). */
export const managedIngressConnectorArn = (region: string): string =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;

export const microvmRuntimeConfigSchema = z
  .strictObject({
    region: z
      .string()
      .trim()
      .regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "must be an AWS region"),
    imageArn: imageArnSchema,
    /** Defaults to the image's latest ACTIVE version. */
    imageVersion: z.string().trim().min(1).optional(),
    executionRoleArn: roleArnSchema,
    egressNetworkConnector: connectorArnSchema.optional(),
    ingressNetworkConnector: connectorArnSchema,
    maxDurationSeconds: z.number().int().min(1).max(MICROVM_MAX_DURATION_CAP_SECONDS),
    /** CloudWatch log group for the VM's console; logging is disabled when unset. */
    logGroup: z.string().trim().min(1).optional(),
    /** The in-VM agent's port: endpoint target and lifecycle hooks alike. */
    agentPort: z.number().int().min(1).max(65_535),
    /** RunMicrovm → RUNNING → launch material accepted → daemon health, all within this. */
    readinessTimeoutMs: z.number().int().positive(),
    /** Fence bound: TerminateMicrovm → TERMINATED, waiting through the terminate hook. */
    terminateTimeoutMs: z.number().int().positive(),
    /** `watchExits` cadence (GetMicrovm is quota'd at 100 TPS; 15 s per VM is generous). */
    exitPollIntervalMs: z.number().int().positive(),
    endpointTokenTtlMinutes: z.number().int().min(1).max(MICROVM_ENDPOINT_TOKEN_MAX_MINUTES),
    /** A token this close to expiry is re-minted before use. */
    endpointTokenRefreshMarginMs: z.number().int().positive(),
    /** Delivered to the agent; must leave the hook time to answer after the flush. */
    flushTimeoutMs: z
      .number()
      .int()
      .positive()
      .max((MICROVM_HOOK_TIMEOUT_CAP_SECONDS - 5) * 1000),
    /**
     * How the endpoint token rides a WebSocket upgrade. `header` sends `X-aws-proxy-auth` /
     * `X-aws-proxy-port` (documented for every request); `subprotocol` offers the
     * `lambda-microvms.*` subprotocols documented for browser clients — a Node client then
     * requires the proxy to echo one back, which is unconfirmed, hence not the default.
     */
    endpointWebSocketAuth: z.enum(["header", "subprotocol"]),
    /** The deployment's control bearer token (SEALANT_CONTROL_BEARER_TOKEN). */
    controlBearerToken: z.string().trim().min(1),
  })
  .refine(
    (config) => config.endpointTokenRefreshMarginMs < config.endpointTokenTtlMinutes * 60_000,
    {
      message: "the endpoint token refresh margin must be shorter than the token TTL",
      path: ["endpointTokenRefreshMarginMs"],
    },
  );

export type MicrovmRuntimeConfig = z.infer<typeof microvmRuntimeConfigSchema>;

export interface MicrovmRuntimeEnvLike {
  readonly SEALANT_MICROVM_REGION?: string | undefined;
  readonly SEALANT_MICROVM_IMAGE_ARN?: string | undefined;
  readonly SEALANT_MICROVM_IMAGE_VERSION?: string | undefined;
  readonly SEALANT_MICROVM_EXEC_ROLE_ARN?: string | undefined;
  readonly SEALANT_MICROVM_EGRESS_CONNECTOR?: string | undefined;
  readonly SEALANT_MICROVM_INGRESS_CONNECTOR?: string | undefined;
  readonly SEALANT_MICROVM_MAX_DURATION_SECONDS?: number | undefined;
  readonly SEALANT_MICROVM_LOG_GROUP?: string | undefined;
  readonly SEALANT_MICROVM_AGENT_PORT?: number | undefined;
  readonly SEALANT_MICROVM_READINESS_TIMEOUT_MS?: number | undefined;
  readonly SEALANT_MICROVM_TERMINATE_TIMEOUT_MS?: number | undefined;
  readonly SEALANT_MICROVM_EXIT_POLL_INTERVAL_MS?: number | undefined;
  readonly SEALANT_MICROVM_TOKEN_TTL_MINUTES?: number | undefined;
  readonly SEALANT_MICROVM_TOKEN_REFRESH_MARGIN_MS?: number | undefined;
  readonly SEALANT_MICROVM_FLUSH_TIMEOUT_MS?: number | undefined;
  readonly SEALANT_MICROVM_WS_AUTH?: "header" | "subprotocol" | undefined;
  readonly SEALANT_CONTROL_BEARER_TOKEN?: string | undefined;
}

export class MicrovmRuntimeConfigError extends Error {
  override readonly name = "MicrovmRuntimeConfigError";
}

/** Undefined when the deployment is not configured for MicroVMs; throws on a half-set contract. */
export const microvmRuntimeConfigFromEnv = (
  env: MicrovmRuntimeEnvLike,
): MicrovmRuntimeConfig | undefined => {
  if (env.SEALANT_MICROVM_IMAGE_ARN === undefined) {
    return undefined;
  }
  const missing = (key: string): never => {
    throw new MicrovmRuntimeConfigError(
      `${key} must be set when SEALANT_MICROVM_IMAGE_ARN is configured.`,
    );
  };
  const region = env.SEALANT_MICROVM_REGION ?? missing("SEALANT_MICROVM_REGION");
  const candidate = {
    region,
    imageArn: env.SEALANT_MICROVM_IMAGE_ARN,
    ...(env.SEALANT_MICROVM_IMAGE_VERSION === undefined
      ? {}
      : { imageVersion: env.SEALANT_MICROVM_IMAGE_VERSION }),
    executionRoleArn: env.SEALANT_MICROVM_EXEC_ROLE_ARN ?? missing("SEALANT_MICROVM_EXEC_ROLE_ARN"),
    ...(env.SEALANT_MICROVM_EGRESS_CONNECTOR === undefined
      ? {}
      : { egressNetworkConnector: env.SEALANT_MICROVM_EGRESS_CONNECTOR }),
    ingressNetworkConnector:
      env.SEALANT_MICROVM_INGRESS_CONNECTOR ?? managedIngressConnectorArn(region),
    maxDurationSeconds:
      env.SEALANT_MICROVM_MAX_DURATION_SECONDS ?? MICROVM_MAX_DURATION_CAP_SECONDS,
    ...(env.SEALANT_MICROVM_LOG_GROUP === undefined
      ? {}
      : { logGroup: env.SEALANT_MICROVM_LOG_GROUP }),
    agentPort: env.SEALANT_MICROVM_AGENT_PORT ?? 8080,
    readinessTimeoutMs: env.SEALANT_MICROVM_READINESS_TIMEOUT_MS ?? 300_000,
    terminateTimeoutMs: env.SEALANT_MICROVM_TERMINATE_TIMEOUT_MS ?? 90_000,
    exitPollIntervalMs: env.SEALANT_MICROVM_EXIT_POLL_INTERVAL_MS ?? 15_000,
    endpointTokenTtlMinutes:
      env.SEALANT_MICROVM_TOKEN_TTL_MINUTES ?? MICROVM_ENDPOINT_TOKEN_MAX_MINUTES,
    endpointTokenRefreshMarginMs: env.SEALANT_MICROVM_TOKEN_REFRESH_MARGIN_MS ?? 300_000,
    flushTimeoutMs: env.SEALANT_MICROVM_FLUSH_TIMEOUT_MS ?? 50_000,
    endpointWebSocketAuth: env.SEALANT_MICROVM_WS_AUTH ?? "header",
    controlBearerToken: env.SEALANT_CONTROL_BEARER_TOKEN ?? missing("SEALANT_CONTROL_BEARER_TOKEN"),
  };
  const parsed = microvmRuntimeConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new MicrovmRuntimeConfigError(
      `SEALANT_MICROVM_* configuration is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
};
