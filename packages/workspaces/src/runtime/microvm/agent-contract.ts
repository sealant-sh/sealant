/**
 * The contract between the `microvm` runtime adapter and the agent baked into the MicroVM image
 * (`packages/workspaces/microvm-image/agent.mjs`). The agent is plain JavaScript with no
 * dependencies, so this file is the ONE typed statement of the wire shapes; the agent mirrors
 * it by hand and the agent tests validate its behaviour against these schemas.
 *
 * Why an agent exists at all (sealantd ADR-0013, AWS Lambda MicroVMs networking):
 *
 *   - sealantd's own WebSocket control frontend is mutual-TLS only, and the MicroVM's inbound
 *     endpoint terminates TLS at the AWS proxy, so a plaintext WebSocket ↔ control-socket relay
 *     inside the VM is required (`/sealant/control`).
 *   - `RunMicrovm` takes no environment, no tags and no secrets: `runHookPayload` (≤ 4096
 *     characters per the API constraint) is the only per-run input, delivered to the image's
 *     `/run` lifecycle hook. Everything a launch needs — boot env, the sealed secret env file,
 *     dotfiles — is therefore PUSHED to the agent over the VM's authenticated endpoint
 *     (`/sealant/launch`) once the VM is RUNNING, and only then does the agent start
 *     `sealantd boot`. No secret ever passes through an AWS API field.
 *   - The platform's lifecycle hooks (`/suspend`, `/terminate`) must flush captures before the
 *     VM goes away; the agent runs `sealantctl capture flush` for them.
 *
 * Sources (read 2026-09-13):
 *   https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html
 *   https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html#microvms-launching-lifecycle-hooks
 *   https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html
 */
import { createHmac } from "node:crypto";

import { z } from "zod";

/** Legacy non-Docker guest protocol version, retained for existing MicroVM images. */
export const AGENT_CONTRACT_VERSION = 1;
/** Guest protocol version that makes the Docker service a required launch capability. */
export const DOCKER_AGENT_CONTRACT_VERSION = 2;

/**
 * The one port the agent listens on: the endpoint's default target port, and the port the
 * image registers for lifecycle hooks (`hooks.port` on the image) — one listener serves both.
 */
export const AGENT_DEFAULT_PORT = 8080;

/** Where the platform POSTs lifecycle hooks (OpenAPI `servers.url` of the runtime hooks spec). */
export const HOOK_ROUTE_PREFIX = "/aws/lambda-microvms/runtime/v1";

export const AGENT_LAUNCH_ROUTE = "/sealant/launch";
export const AGENT_HEALTH_ROUTE = "/sealant/health";
export const AGENT_CONTROL_ROUTE = "/sealant/control";

/** In-VM paths; the same ones every other runtime family uses. */
export const CONTROL_SOCKET_PATH = "/run/sealant/control.sock";
/** Guest-local Docker socket. The Docker-capable image never opens a TCP listener. */
export const DOCKER_SOCKET_PATH = "/run/docker/docker.sock";
export const SECRET_ENV_FILE_PATH = "/run/sealant/secrets/env.json";
export const DOTFILES_ARCHIVE_DIR = "/run/sealant/dotfiles";

/** Header the AWS proxy reads the endpoint token from, and the one that picks the target port. */
export const PROXY_AUTH_HEADER = "X-aws-proxy-auth";
export const PROXY_PORT_HEADER = "X-aws-proxy-port";

/** WebSocket subprotocols the proxy accepts instead of the headers (browser clients). */
export const PROXY_SUBPROTOCOL = "lambda-microvms";
export const proxyAuthSubprotocol = (token: string): string =>
  `${PROXY_SUBPROTOCOL}.authentication.${token}`;
export const proxyPortSubprotocol = (port: number): string => `${PROXY_SUBPROTOCOL}.port.${port}`;

/**
 * What `RunMicrovm.runHookPayload` carries, delivered verbatim to the agent's `/run` hook. Only
 * the launch secret — never env, never the secret file — so the payload fits the API's limit
 * and nothing sensitive beyond a one-launch bootstrap credential passes through an AWS API
 * field (whether CloudTrail records request parameters for RunMicrovm is unconfirmed).
 */
const runHookPayloadFields = {
  runId: z.string().trim().min(1),
  launchSecret: z.string().regex(/^[0-9a-f]{64}$/),
};

/** Existing run-hook payload for a launch with no required guest service. */
export const runHookPayloadV1Schema = z.strictObject({
  version: z.literal(AGENT_CONTRACT_VERSION),
  ...runHookPayloadFields,
});

/** Run-hook payload that requires the Docker-capable guest image. */
export const runHookPayloadV2Schema = z.strictObject({
  version: z.literal(DOCKER_AGENT_CONTRACT_VERSION),
  ...runHookPayloadFields,
  services: z.strictObject({ docker: z.literal("required") }),
});

/** Run-hook payload accepted by current and legacy-compatible guest images. */
export const runHookPayloadSchema = z.discriminatedUnion("version", [
  runHookPayloadV1Schema,
  runHookPayloadV2Schema,
]);

export type RunHookPayload = z.infer<typeof runHookPayloadSchema>;

/**
 * The launch secret binds the launch-material push to the launch that created the VM: the
 * adapter derives it from the deployment's control bearer token and the run id, so a
 * redelivered launch for the same run computes the same secret and adopts the VM. It authorises
 * exactly one thing — the first `/sealant/launch` — after which the agent only honours the
 * control token it received inside that push.
 */
export const launchSecretForRun = (controlBearerToken: string, runId: string): string =>
  createHmac("sha256", controlBearerToken).update(`sealant-microvm-launch:${runId}`).digest("hex");

const dotfilesArchiveSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+$/, "archive names are plain file names"),
  contentBase64: z.string().min(1),
});

const agentLaunchRequestFields = {
  runId: z.string().trim().min(1),
  /** Authenticates every later `/sealant/control` and `/sealant/health` request. */
  controlToken: z.string().trim().min(1),
  /** Bound on `sealantctl capture flush` inside the suspend/terminate hooks. */
  flushTimeoutMs: z.number().int().positive(),
  /** The `sealantd boot` process environment (non-secret boot facts AND launch-time env). */
  bootEnv: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
  /** Contents of `SEALANT_SECRET_ENV_FILE` (a JSON object), written 0600 before boot. */
  secretEnvJson: z.string().min(1).optional(),
  dotfiles: z
    .strictObject({
      manifestJson: z.string().min(1),
      archives: z.array(dotfilesArchiveSchema),
    })
    .optional(),
};

/** Existing launch request for a workspace with no required guest service. */
export const agentLaunchRequestV1Schema = z.strictObject({
  version: z.literal(AGENT_CONTRACT_VERSION),
  ...agentLaunchRequestFields,
});

/** Launch request that requires guest-local Docker before `sealantd boot` starts. */
export const agentLaunchRequestV2Schema = z.strictObject({
  version: z.literal(DOCKER_AGENT_CONTRACT_VERSION),
  ...agentLaunchRequestFields,
  services: z.strictObject({ docker: z.literal("required") }),
});

/** Body of `POST /sealant/launch`; the launch secret authenticates it. */
export const agentLaunchRequestSchema = z.discriminatedUnion("version", [
  agentLaunchRequestV1Schema,
  agentLaunchRequestV2Schema,
]);

export type AgentLaunchRequest = z.infer<typeof agentLaunchRequestSchema>;

export const agentLaunchResponseSchema = z.strictObject({
  outcome: z.enum(["booting", "already-booted"]),
});

export type AgentLaunchResponse = z.infer<typeof agentLaunchResponseSchema>;

/** The most output a daemon exit reports (`agent.mjs` keeps the tail of sealantd's output). */
export const DAEMON_EXIT_OUTPUT_MAX_CHARS = 4096;

const processExitSchema = z.strictObject({
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  /**
   * What sealantd printed last before it exited: the end of its stdout, then the end of its
   * stderr (which has first claim on the room), so a failed boot (a dotfiles apply that failed,
   * say) says why without the VM console. The agent redacts the control token and every secret
   * env value first. Absent when the daemon printed nothing, and from agents older than this field.
   */
  output: z.string().max(DAEMON_EXIT_OUTPUT_MAX_CHARS).optional(),
});

const dockerProbeFailureSchema = z.strictObject({
  reason: z.enum(["spawn-failed", "timeout", "exited"]),
  code: z.union([
    z.number().int(),
    z.enum(["EACCES", "EMFILE", "ENFILE", "ENOENT", "ENOEXEC", "ENOMEM", "ETXTBSY"]),
    z.null(),
  ]),
  signal: z
    .string()
    .regex(/^[A-Z0-9]{1,16}$/)
    .nullable(),
});

/** Docker service lifecycle reported by a v2 guest. */
export const dockerServiceHealthSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("starting") }),
  z.strictObject({ status: z.literal("ready"), socket: z.literal(DOCKER_SOCKET_PATH) }),
  z.strictObject({
    status: z.literal("failed"),
    reason: z.enum([
      "spawn-failed",
      "directory-preparation-failed",
      "readiness-timeout",
      "exited",
      "probe-failed",
    ]),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    probe: dockerProbeFailureSchema.optional(),
  }),
]);

/** Legacy health body returned by a v1 image. */
export const agentHealthResponseV1Schema = z.strictObject({
  booted: z.boolean(),
  controlSocket: z.boolean(),
  daemonExit: processExitSchema.optional(),
});

/** Docker-aware health body returned by a v2 image. */
export const agentHealthResponseV2Schema = z.strictObject({
  version: z.literal(DOCKER_AGENT_CONTRACT_VERSION),
  booted: z.boolean(),
  controlSocket: z.boolean(),
  daemonExit: processExitSchema.optional(),
  services: z.strictObject({ docker: dockerServiceHealthSchema }),
});

/** `GET /sealant/health` body for either supported guest protocol version. */
export const agentHealthResponseSchema = z.union([
  agentHealthResponseV2Schema,
  agentHealthResponseV1Schema,
]);

export type AgentHealthResponse = z.infer<typeof agentHealthResponseSchema>;

/** Error body returned by an authenticated agent route. */
export const agentErrorResponseSchema = z.strictObject({
  message: z.string().min(1),
});
