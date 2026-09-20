/**
 * Lambda MicroVM runtime configuration (worker; the API and SSH gateway need only the region and
 * agent port to mint endpoint tokens for control connections).
 *
 * Validated once from the environment; nothing here touches AWS. Docker, Kubernetes and
 * Cloudflare deployments never construct this — the adapter is only built when
 * `SEALANT_MICROVM_BUILD_ROLE_ARN` is set. There is no image to configure: every workspace boots
 * the image built from its own blueprint (docs/workspace-image-builders-design.md), so what is
 * configured is how those images are built. `RunMicrovm` takes no vCPU/memory/disk — they are
 * properties of the image (`resources.minimumMemoryInMiB`, vCPU = memory / 2 GiB, disk by tier:
 * 16 GiB at 4 GiB), so sizing is a build setting: `SEALANT_MICROVM_MEMORY_MIB`.
 *
 * Sources (read 2026-09-13): https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html
 * (maximumDurationInSeconds 1–28800), https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmAuthToken.html
 * (expirationInMinutes ≤ 60), https://docs.aws.amazon.com/lambda/latest/microvm-api/API_MicrovmHooks.html
 * (hook timeouts 1–60 s), https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html#microvms-images-sizing.
 */
import { z } from "zod";

import { AGENT_DEFAULT_PORT } from "./agent-contract.js";

export { AGENT_DEFAULT_PORT };

/** The platform's hard lifetime cap, suspended time included (not adjustable). */
export const MICROVM_MAX_DURATION_CAP_SECONDS = 28_800;
/** The longest a runtime hook may run before the platform gives up on it. */
export const MICROVM_HOOK_TIMEOUT_CAP_SECONDS = 60;
/** The longest-lived endpoint token the platform mints. */
export const MICROVM_ENDPOINT_TOKEN_MAX_MINUTES = 60;

/** The managed base the platform boots under a recipe's root filesystem, or an account's own. */
const baseImageArnSchema = z
  .string()
  .trim()
  .regex(
    /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:(\d{12}|aws):microvm-image:[A-Za-z0-9_-]+$/,
    "must be a MicroVM image ARN (arn:aws:lambda:<region>:<account or aws>:microvm-image:<name>)",
  );

/** The only managed base there is (observed 2026-09-20). A recipe's own `FROM` is free. */
export const managedBaseImageArn = (region: string): string =>
  `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`;

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
    /** How workspace images are built. Nothing here is a tenant's to choose. */
    build: z.strictObject({
      /**
       * The role the managed image build runs recipe steps under. A step can obtain its
       * credentials, so it holds `s3:GetObject` on the artifacts prefix and the two log actions,
       * and nothing else.
       */
      roleArn: roleArnSchema,
      artifactBucket: z
        .string()
        .trim()
        .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "must be an S3 bucket name"),
      /** Key prefix for build contexts, without a leading or trailing slash. */
      artifactPrefix: z
        .string()
        .trim()
        .regex(
          /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/,
          "must be a key prefix without outer slashes",
        ),
      baseImageArn: baseImageArnSchema,
      /**
       * Every image is named `<prefix>-<plan hash>`, and the cap and retention count and sweep the
       * names with this prefix. Two control planes that share an AWS account take different ones.
       */
      imageNamePrefix: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, "must be 1 to 32 of [A-Za-z0-9_-]"),
      /** `minimumMemoryInMiB`; vCPU and disk follow from it. */
      memoryMiB: z.number().int().min(512),
      /** Past this many images of its own the builder refuses to create another. */
      maxImages: z.number().int().min(1),
      /** CloudWatch log group for build logs; build logging is disabled when unset. */
      logGroup: z.string().trim().min(1).optional(),
      timeoutMs: z.number().int().positive(),
      pollIntervalMs: z.number().int().positive(),
    }),
    /**
     * Whether this install serves `tooling.services.docker`. Such a workspace's image carries the
     * engine and is created with the image-level `ALL` OS capability: an operator decision.
     */
    dockerService: z.boolean(),
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
  readonly SEALANT_MICROVM_BUILD_ROLE_ARN?: string | undefined;
  readonly SEALANT_MICROVM_ARTIFACT_BUCKET?: string | undefined;
  readonly SEALANT_MICROVM_ARTIFACT_PREFIX?: string | undefined;
  readonly SEALANT_MICROVM_BASE_IMAGE_ARN?: string | undefined;
  readonly SEALANT_MICROVM_IMAGE_NAME_PREFIX?: string | undefined;
  readonly SEALANT_MICROVM_MEMORY_MIB?: number | undefined;
  readonly SEALANT_MICROVM_MAX_IMAGES?: number | undefined;
  readonly SEALANT_MICROVM_BUILD_LOG_GROUP?: string | undefined;
  readonly SEALANT_MICROVM_BUILD_TIMEOUT_MS?: number | undefined;
  readonly SEALANT_MICROVM_BUILD_POLL_INTERVAL_MS?: number | undefined;
  readonly SEALANT_MICROVM_DOCKER_ENABLED?: boolean | undefined;
  /** Retired: one hand-registered image for every workspace. Setting any of them is an error. */
  readonly SEALANT_MICROVM_IMAGE_ARN?: string | undefined;
  readonly SEALANT_MICROVM_IMAGE_VERSION?: string | undefined;
  readonly SEALANT_MICROVM_DOCKER_IMAGE_ARN?: string | undefined;
  readonly SEALANT_MICROVM_DOCKER_IMAGE_VERSION?: string | undefined;
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
  const retired = (
    [
      "SEALANT_MICROVM_IMAGE_ARN",
      "SEALANT_MICROVM_IMAGE_VERSION",
      "SEALANT_MICROVM_DOCKER_IMAGE_ARN",
      "SEALANT_MICROVM_DOCKER_IMAGE_VERSION",
    ] as const
  ).filter((key) => env[key] !== undefined);
  if (retired.length > 0) {
    throw new MicrovmRuntimeConfigError(
      `${retired.join(", ")} ${retired.length === 1 ? "is" : "are"} retired. A MicroVM workspace no longer boots one registered image: it boots the image built from its blueprint. Remove ${retired.length === 1 ? "it" : "them"} and set SEALANT_MICROVM_BUILD_ROLE_ARN and SEALANT_MICROVM_ARTIFACT_BUCKET (docs/workspace-image-builders-design.md).`,
    );
  }
  if (env.SEALANT_MICROVM_BUILD_ROLE_ARN === undefined) {
    return undefined;
  }
  const missing = (key: string): never => {
    throw new MicrovmRuntimeConfigError(
      `${key} must be set when SEALANT_MICROVM_BUILD_ROLE_ARN is configured.`,
    );
  };
  const region = env.SEALANT_MICROVM_REGION ?? missing("SEALANT_MICROVM_REGION");
  const candidate = {
    region,
    build: {
      roleArn: env.SEALANT_MICROVM_BUILD_ROLE_ARN,
      artifactBucket:
        env.SEALANT_MICROVM_ARTIFACT_BUCKET ?? missing("SEALANT_MICROVM_ARTIFACT_BUCKET"),
      artifactPrefix: env.SEALANT_MICROVM_ARTIFACT_PREFIX ?? "sealant/workspace-images",
      baseImageArn: env.SEALANT_MICROVM_BASE_IMAGE_ARN ?? managedBaseImageArn(region),
      imageNamePrefix: env.SEALANT_MICROVM_IMAGE_NAME_PREFIX ?? "sealant-ws",
      // 4 GiB: 2 vCPU and a 16 GiB disk on the platform's tiers.
      memoryMiB: env.SEALANT_MICROVM_MEMORY_MIB ?? 4096,
      maxImages: env.SEALANT_MICROVM_MAX_IMAGES ?? 50,
      ...(env.SEALANT_MICROVM_BUILD_LOG_GROUP === undefined
        ? {}
        : { logGroup: env.SEALANT_MICROVM_BUILD_LOG_GROUP }),
      // A managed build took 144 to 205 s when measured; thirty minutes is its own script's bound.
      timeoutMs: env.SEALANT_MICROVM_BUILD_TIMEOUT_MS ?? 1_800_000,
      pollIntervalMs: env.SEALANT_MICROVM_BUILD_POLL_INTERVAL_MS ?? 10_000,
    },
    dockerService: env.SEALANT_MICROVM_DOCKER_ENABLED ?? false,
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
    agentPort: env.SEALANT_MICROVM_AGENT_PORT ?? AGENT_DEFAULT_PORT,
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
