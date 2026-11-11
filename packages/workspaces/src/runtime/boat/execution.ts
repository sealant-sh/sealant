import {
  constants,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  randomUUID,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { CredentialCipher, type CredentialCipherError } from "@sealant/credentials";
import { BoatRunRepo, BoatRunRepoLive, type BoatRunStoreError, type SealantDB } from "@sealant/db";
import { RuntimeState } from "@sealant/runtime-protocol";
import {
  boatAdmissionPinsSchema,
  boatNetworkIntentSchema,
  boatWireGuardKeySchema,
  boatExecutionTargetSchema,
  boatRunLaunchPhase,
  type BoatAdmissionPins,
  type BoatExecutionTarget,
  type BoatNetworkIntent,
  type BoatRun,
  type BoatRunIsolation,
} from "@sealant/validators";
import { Cause, Context, Effect, Layer, Redacted, Schedule } from "effect";
import { z } from "zod";

import { safeCommandTail } from "../../images/boat/command-diagnostics.js";
import {
  SealantControlError,
  TransportError,
  type SealantError,
  type SealantRuntimeService,
  type SealantTarget,
} from "../../sealantd/runtime.js";
import {
  AGENT_CONTRACT_VERSION,
  AGENT_HEALTH_ROUTE,
  AGENT_LAUNCH_ROUTE,
  AGENT_RECOVER_CONTRACT_VERSION,
  AGENT_RECOVER_ROUTE,
  DOCKER_AGENT_CONTRACT_VERSION,
  agentHealthResponseSchema,
  agentLaunchResponseSchema,
  type AgentLaunchRequest,
} from "../microvm/agent-contract.js";
import {
  BOAT_AGENT_BIND_REFUSALS,
  BOAT_AGENT_NETWORK_ROUTE,
  BOAT_AGENT_RECOVER_REFUSALS,
  boatAgentBindReplySchema,
  boatAgentIdentitySchema,
  boatAgentNetworkResponseSchema,
  boatAgentNetworkStatusSchema,
  boatAgentRecoverResponseSchema,
  boatAgentRefusalSchema,
  type BoatAgentBindRequest,
  type BoatAgentNetworkRequest,
} from "./agent-contract.js";
import type { BoatApi } from "./api.js";
import { BoatApiError, BoatSecret, boatSandboxIdSchema, parseBoatUrl } from "./config.js";
import {
  boatControlConnection,
  boatTunnelConnection,
  type BoatHostedControl,
} from "./connection.js";
import {
  boatGuestOutput,
  boatLaunchDiagnostic,
  boatLaunchSummary,
  type BoatLaunchDiagnostic,
} from "./launch-diagnostics.js";

/** The agent's kill switch for a hung capture flush in its lifecycle hooks; none run on Boat. */
const BOAT_FLUSH_TIMEOUT_MS = 30_000;

/**
 * How long the bind proof waits for the agent to answer health to the exchanged bearer: the unit
 * starts after `network-online.target`, so a fresh VM's proxy answers for the agent for a while
 * (a 5xx of its own, not the agent's), and the first answer is slower than on a warm one. Ten
 * tries a second apart, each within the health route's own budget.
 */
const BIND_PROOF_RETRIES = {
  times: 9,
  schedule: Schedule.spaced("1 second"),
  while: (error: unknown) => boatExecutionRetryable(error),
};

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
/** What a launch is made of, sealed as the admission envelope and pushed to the agent once. */
const envelopeSchema = z.strictObject({
  bootEnv: z.record(envName, z.string()),
  secretEnv: z.record(z.string(), z.string()),
  pins: boatAdmissionPinsSchema,
  docker: z.boolean(),
});
const bootstrapSchema = z.strictObject({
  format: z.literal("sealant-bootstrap-v1"),
  identity: boatAgentIdentitySchema,
  boot_id: z.uuid(),
  manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
  operation_id: z.uuid(),
  public_key: z
    .string()
    .min(100)
    .max(4096)
    .regex(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/),
});
const controlSchema = z.strictObject({
  origin: z.string(),
  cookie: z.string(),
  bearer: z.string().regex(/^[a-f0-9]{64}$/),
});
const exchangeSchema = z.strictObject({ privateKey: z.string() });

/**
 * The agent routes Core calls over the hosted proxy, each with the budget Core gives one request
 * and the statuses whose body the caller reads itself (every other status is a typed failure).
 */
export type BoatAgentRoute = "launch" | "health" | "network" | "network-status" | "recover";
interface BoatAgentRouteSpec {
  readonly method: "GET" | "POST";
  readonly pathClass: NonNullable<BoatLaunchDiagnostic["agent"]>["pathClass"];
  readonly budgetMs: number;
  readonly answered: readonly number[];
}
export const boatAgentRoutes: Readonly<Record<BoatAgentRoute, BoatAgentRouteSpec>> = {
  launch: { method: "POST", pathClass: AGENT_LAUNCH_ROUTE, budgetMs: 30_000, answered: [200, 409] },
  health: { method: "GET", pathClass: AGENT_HEALTH_ROUTE, budgetMs: 10_000, answered: [200, 503] },
  network: {
    method: "POST",
    pathClass: BOAT_AGENT_NETWORK_ROUTE,
    budgetMs: 30_000,
    answered: [200],
  },
  "network-status": {
    method: "GET",
    pathClass: BOAT_AGENT_NETWORK_ROUTE,
    budgetMs: 10_000,
    answered: [200],
  },
  // The agent waits for a recovery boot to settle (15 s by default) before it answers.
  recover: {
    method: "POST",
    pathClass: AGENT_RECOVER_ROUTE,
    budgetMs: 45_000,
    answered: [200, 409],
  },
};

/** An answered agent request: a status the caller reads, with its parsed JSON body. */
export interface BoatAgentReply {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The agent's status decides, never its text: 400 is a request Core built wrong, 401 a bearer the
 * agent does not hold, 404 an agent without the route, 409 a refusal whose reason the body names.
 * 502/503/504 (the proxy's VM still booting, an agent not yet listening, or the agent's own
 * `503 {reason: daemon-stop-unverified | docker-stop-unverified}` on a recovery it could not
 * finish) and lost transport are the only retryable failures; their reason, when the body
 * names one, is kept.
 */
export type BoatAgentFailureCode =
  | "agent-rejected"
  | "agent-unauthorized"
  | "agent-route-missing"
  | "agent-refused"
  | "agent-not-ready"
  | "transport-unavailable";
export const boatAgentFailureCode = (status: number): BoatAgentFailureCode =>
  status === 400
    ? "agent-rejected"
    : status === 401 || status === 403
      ? "agent-unauthorized"
      : status === 404
        ? "agent-route-missing"
        : status === 409
          ? "agent-refused"
          : status === 502 || status === 503 || status === 504
            ? "agent-not-ready"
            : "transport-unavailable";
/** The one retry rule for guest work: lost transport or an agent that is not ready yet. */
export const boatExecutionRetryable = (error: unknown): boolean =>
  error instanceof BoatExecutionError &&
  (error.code === "transport-unavailable" || error.code === "agent-not-ready");
/** The agent's classified reason code (`{reason}`), never its free text. */
const agentReason = (tail: string): { reason?: string } => {
  try {
    const parsed = boatAgentRefusalSchema.safeParse(JSON.parse(tail));
    return parsed.success ? { reason: parsed.data.reason } : {};
  } catch {
    return {};
  }
};

/** Failure summaries contain only classified metadata and bounded, redacted command tails. */
export class BoatExecutionError extends Error {
  readonly _tag = "BoatExecutionError";
  readonly diagnostic: BoatLaunchDiagnostic | undefined;
  constructor(
    readonly code:
      | "invalid-input"
      | "target-mismatch"
      | "transport-unavailable"
      | "invalid-reply"
      | "seal-context-mismatch"
      | "invocation-held"
      /** The agent's health named a daemon exit or a failed guest service: the launch is lost. */
      | "guest-failed"
      /** The agent cannot carry the tunnel over HTTPS (an image older than the carrier). */
      | "carrier-unavailable"
      | BoatAgentFailureCode,
    diagnostic?: BoatLaunchDiagnostic,
  ) {
    const safe =
      diagnostic === undefined ? undefined : boatLaunchDiagnostic({ diagnostic }, diagnostic.step);
    super(`Boat execution: ${code}${boatLaunchSummary(safe)}`);
    this.diagnostic = safe;
  }
}
type Failure = BoatExecutionError | BoatRunStoreError | CredentialCipherError;
const attempt = <A>(code: BoatExecutionError["code"], run: () => A) =>
  Effect.try({ try: run, catch: () => new BoatExecutionError(code) });
const io = <A>(
  run: (signal: AbortSignal) => Promise<A>,
  step: BoatLaunchDiagnostic["step"] = "agent-request",
) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof BoatExecutionError
        ? error
        : new BoatExecutionError("transport-unavailable", boatLaunchDiagnostic(error, step)),
  });
const identity = (target: BoatExecutionTarget) => ({
  deployment_id: target.deploymentId,
  instance_id: target.sandboxId,
  disk_lineage: target.diskLineage,
});
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
};
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Read a bounded failure prefix; cancel even an infinite or oversized response. */
const agentFailureTail = async (
  response: Response,
  redactions: readonly string[],
  body: Redacted.Redacted<string> | undefined,
) => {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (size < 16_384) {
      const part = await reader.read();
      if (part.done) break;
      const bytes = Buffer.from(part.value).subarray(0, 16_384 - size);
      chunks.push(bytes);
      size += bytes.length;
    }
  } catch {
    // An interrupted failure body must not erase its HTTP status or the bytes already received.
  } finally {
    await reader.cancel().catch(() => {});
  }
  let text = Buffer.concat(chunks).toString("utf8");
  if (size === 16_384) {
    // Do not emit a token prefix cut in half by the byte bound.
    text = text.slice(0, Math.max(0, text.lastIndexOf("\n"))) + "\n[TRUNCATED_RESPONSE]";
  }
  const scrub = (value: unknown): void => {
    if (typeof value === "string" && value.length >= 8) text = text.split(value).join("[REDACTED]");
    else if (Array.isArray(value)) value.forEach(scrub);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(scrub);
  };
  redactions.forEach(scrub);
  if (body !== undefined) {
    const raw = Redacted.value(body);
    scrub(raw);
    try {
      // A failed upstream may echo launch material, including the boot env and secret values.
      const request: unknown = JSON.parse(raw);
      scrub(request);
    } catch {
      // No raw request or parse error leaves this boundary.
    }
  }
  return safeCommandTail(text);
};

/** Public commands and hosted HTTPS only. Implementations must authenticate the exact provider target. */
export interface BoatGuestTransport {
  /** The bind exchange: `boat-bind.mjs` over Boat exec. A refusal is a typed `agent-refused`. */
  readonly bind: (target: BoatExecutionTarget, request: unknown) => Promise<unknown>;
  readonly host: (target: BoatExecutionTarget) => Promise<BoatHostedControl>;
  /** One authenticated agent request; the caller reads the statuses the route lists as answered. */
  readonly request: (
    access: BoatHostedControl,
    bearer: BoatSecret,
    route: BoatAgentRoute,
    body?: Redacted.Redacted<string>,
    signal?: AbortSignal,
  ) => Promise<BoatAgentReply>;
  /** Round-trips daemon health through the agent's control relay. */
  readonly probe: (access: BoatHostedControl, bearer: BoatSecret) => Promise<BoatDaemonReady>;
}

/** Safe daemon observation. The generated runtime ID is correlated by the surrounding reads. */
export interface BoatDaemonReady {
  readonly runtimeId: string;
  readonly healthy: boolean;
}

/** The daemon probe's cause, as the runtime client classified it, kept for the runtime row. */
export const boatControlFailure = (error: SealantError | Cause.TimeoutError) =>
  new BoatExecutionError("transport-unavailable", {
    step: "readiness",
    code: "transport-unavailable",
    ...(Cause.isTimeoutError(error)
      ? { errorClass: "TimeoutError", control: { operation: "probe" } }
      : error instanceof TransportError
        ? {
            errorClass: "TransportError",
            control: {
              operation: error.operation,
              ...(error.status === undefined ? {} : { status: error.status }),
              ...(error.reason === undefined ? {} : { reason: error.reason }),
            },
          }
        : error instanceof SealantControlError
          ? {
              errorClass: "SealantControlError",
              control: { operation: error.operation, daemonCode: error.code },
            }
          : { errorClass: "SealantUnexpectedError", control: { operation: error.operation } }),
  });

/**
 * The one provider command Core runs in a workspace VM: the bind exchange, with its public JSON
 * request as the only argument. Launch secrets never travel this way; they go over hosted HTTPS.
 */
export const boatGuestPublicCommand = (request: BoatAgentBindRequest) => {
  const raw = JSON.stringify(request);
  if (raw.length > 8192) throw new BoatExecutionError("invalid-input");
  return `/usr/bin/sudo -n -- /opt/sealant/node /opt/sealant/boat-bind.mjs '${raw.replaceAll("'", "'\\''")}'`;
};

/** The only production transport: no provider upload or command receives launch secrets. */
export const createBoatGuestTransport = (
  api: Pick<BoatApi, "get" | "execute" | "hostControl">,
  runtime: SealantRuntimeService,
): BoatGuestTransport => {
  const verify = async (target: BoatExecutionTarget) => {
    const id = boatSandboxIdSchema.parse(target.sandboxId);
    const found = await api.get(id);
    if (!found.ok)
      throw new BoatExecutionError(
        "transport-unavailable",
        boatLaunchDiagnostic(found.error, "observe-sandbox"),
      );
    const expected = {
      "sealant-runtime": "boat",
      "sealant-deployment": target.deploymentId,
      "sealant-workspace": target.workspaceId,
      "sealant-run": target.runId,
      "sealant-instance": target.runtimeInstanceId,
      "sealant-attempt": target.launchAttemptId,
      "sealant-source": target.sourceId,
    };
    if (
      found.value.id !== id ||
      !Object.entries(expected).every(([key, value]) => found.value.labels?.[key] === value)
    )
      throw new BoatExecutionError("target-mismatch");
    return id;
  };
  return {
    probe: (access, bearer) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = boatControlConnection(access, bearer);
            const session = yield* runtime.connect({
              kind: "websocket",
              ...connection,
              auth: { bearerToken: bearer.reveal() },
            });
            const health = yield* session.health;
            return {
              runtimeId: health.runtimeId,
              healthy: health.state === RuntimeState.HEALTHY,
            };
          }),
        ).pipe(Effect.timeout(15_000), Effect.mapError(boatControlFailure)),
      ),
    bind: async (target, request) => {
      const id = await verify(target);
      const publicRequest = bootstrapSchema.safeParse(request);
      if (
        !publicRequest.success ||
        !isDeepStrictEqual(publicRequest.data.identity, identity(target)) ||
        publicRequest.data.boot_id !== target.bootId ||
        publicRequest.data.manifest_digest !== target.manifestDigest
      )
        throw new BoatExecutionError("invalid-input");
      const key = createPublicKey(publicRequest.data.public_key);
      if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 3072)
        throw new BoatExecutionError("invalid-input");
      const command = boatGuestPublicCommand(publicRequest.data);
      const result = await api.execute(id, command, { timeoutSeconds: 90 });
      if (!result.ok)
        throw new BoatExecutionError(
          "transport-unavailable",
          boatLaunchDiagnostic(result.error, "bind-exchange"),
        );
      if (
        result.value.timedOut ||
        result.value.exitCode !== 0 ||
        result.value.stdout.length > 65536
      ) {
        // The bind CLI's stderr is one reason code on a refusal; anything else is a lost exchange.
        const stderr = result.value.stderr.trim();
        const refusal = BOAT_AGENT_BIND_REFUSALS.find((reason) => reason === stderr);
        throw new BoatExecutionError(
          refusal === undefined ? "transport-unavailable" : "agent-refused",
          {
            step: "bind-exchange",
            errorClass: "BoatExecutionError",
            code: refusal === undefined ? "transport-unavailable" : "agent-refused",
            command: {
              exitCode: result.value.exitCode,
              timedOut: result.value.timedOut,
              stdoutTail: safeCommandTail(result.value.stdout),
              stderrTail: safeCommandTail(result.value.stderr),
            },
          },
        );
      }
      return JSON.parse(result.value.stdout);
    },
    host: async (target) => {
      const result = await api.hostControl(await verify(target));
      if (!result.ok)
        throw new BoatExecutionError(
          "transport-unavailable",
          boatLaunchDiagnostic(result.error, "host-agent"),
        );
      return result.value;
    },
    request: async (access, bearer, route, body, signal) => {
      const origin = parseBoatUrl(access.origin);
      if (!origin.ok || origin.value.href !== `${access.origin}/`)
        throw new BoatExecutionError("invalid-input");
      const { method, pathClass, budgetMs, answered } = boatAgentRoutes[route];
      let response: Response;
      try {
        response = await fetch(`${access.origin}${pathClass}`, {
          method,
          redirect: "error",
          signal: signal ?? AbortSignal.timeout(budgetMs),
          headers: {
            Cookie: `_port_auth=${access.cookie.reveal()}`,
            Authorization: `Bearer ${bearer.reveal()}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: Redacted.value(body) }),
        });
      } catch (error) {
        throw new BoatExecutionError("transport-unavailable", {
          ...boatLaunchDiagnostic(
            new BoatApiError(`agent-${route}`, null, "transport_error", error),
            "agent-request",
          ),
          agent: { pathClass, responseTail: "" },
        });
      }
      if (!answered.includes(response.status)) {
        const responseTail = await agentFailureTail(
          response,
          [access.cookie.reveal(), bearer.reveal()],
          body,
        );
        const reason = agentReason(responseTail);
        const code = boatAgentFailureCode(response.status);
        throw new BoatExecutionError(code, {
          step: "agent-request",
          errorClass: "BoatExecutionError",
          code,
          provider: { operation: `agent-${route}`, status: response.status, causeClass: null },
          agent: { pathClass, responseTail, ...reason },
        });
      }
      const reader = response.body?.getReader();
      if (reader === undefined) throw new BoatExecutionError("invalid-reply");
      let raw = "";
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          raw += Buffer.from(part.value).toString("utf8");
          if (raw.length > 65536) throw new BoatExecutionError("invalid-reply");
        }
        return { status: response.status, body: JSON.parse(raw) };
      } catch (error) {
        if (error instanceof BoatExecutionError) throw error;
        // The route lists 503 as answered because the agent's health is a JSON 503 before a
        // launch; a 5xx that is not JSON is the hosted proxy's own (its VM booting, the agent's
        // port not open yet), not an answer: the VM is not ready, and the same request is retried.
        const code = boatAgentFailureCode(response.status);
        if (code === "agent-not-ready")
          throw new BoatExecutionError(code, {
            step: "agent-request",
            errorClass: "BoatExecutionError",
            code,
            provider: { operation: `agent-${route}`, status: response.status, causeClass: null },
            agent: { pathClass, responseTail: "" },
          });
        throw new BoatExecutionError("invalid-reply", {
          ...boatLaunchDiagnostic(
            new BoatApiError(`agent-${route}`, response.status, "invalid_reply", error),
            "agent-request",
          ),
          agent: { pathClass, responseTail: "" },
        });
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  };
};

/** This layer is deliberately absent from ordinary runtime registration until isolation and custody land. */
export class BoatGuestTransportService extends Context.Service<
  BoatGuestTransportService,
  BoatGuestTransport
>()("@sealant/workspaces/boat/BoatGuestTransport") {}

/** What a launch is made of; sealed once and pushed to the agent as the launch body. */
export type BoatLaunchMaterial = z.infer<typeof envelopeSchema>;

/**
 * What the agent said of a held workspace's capture when asked to recover it. `running`: its
 * daemon is up. `restarted`: the agent started sealantd again in recovery mode on the VM's disk.
 * `nothing-to-save` carries the agent's basis: `no-launch` (this boot was bound and never
 * launched: nothing ran) or `daemon` (the recovery boot found no materialized capture, sealantd
 * exit 76), with the daemon's own line when it gave one.
 */
export type BoatRecoveryOutcome =
  | "running"
  | "restarted"
  | {
      readonly outcome: "nothing-to-save";
      readonly basis: "no-launch" | "daemon";
      readonly detail?: string;
    };

/**
 * What a run's records and its agent say of the daemon on its VM, in one read. `up`: the agent
 * reports the launch it accepted on this boot, and names no exit. `exited`: the agent's health
 * names the daemon's exit. `not-booted`: the agent reports no launch on this boot. `never-launched`:
 * the run was fenced before any launch push, so nothing ran.
 * `unasked`: the launch has not been accepted yet (or never bound a bearer), so the agent's
 * `booted: false` would describe a launch still in flight; it is not asked.
 */
export type BoatDaemonObservation =
  | { readonly kind: "up" | "not-booted" | "never-launched" | "unasked" }
  | {
      readonly kind: "exited";
      readonly exitCode: number | null;
      /** A signal name as the agent gave it, or `unrecognized` for anything that is not one. */
      readonly signal: string | null;
      /** The daemon's last output, bounded, with the run's bearer redacted. */
      readonly output?: string;
    };

/** Owns sealed bootstrap and one frozen admission. Running acknowledges an accepted launch, not daemon readiness. */
export interface BoatExecutionService {
  /**
   * Replays only the reserved exchange; a different target or boot refuses. Returns the binding
   * receipt: a digest of the public bind (identity, boot, operation), the same on every replay.
   */
  readonly exchange: (target: BoatExecutionTarget) => Effect.Effect<string, Failure>;
  /** The material is sealed on first call. Later calls keep the original sealed envelope. */
  readonly stage: (
    id: string,
    material: Redacted.Redacted<BoatLaunchMaterial>,
  ) => Effect.Effect<void, Failure>;
  /**
   * Freezes what a launch was isolated under: the receipts its network was prepared under, or the
   * fact that it has no resource network (`{ resources: "none" }`), after which `isolate` and
   * `tunnel` refuse the run for good. The run's row is the only reader.
   */
  readonly recordIsolation: (
    target: BoatExecutionTarget,
    receipts: BoatRunIsolation,
  ) => Effect.Effect<void, Failure>;
  /** Pushes the sealed launch to the agent once. A lost reply adopts the agent's durable launch record. */
  readonly launch: (id: string) => Effect.Effect<"running", Failure>;
  /** Authenticated network setup for the admitted epoch only. */
  readonly isolate: (
    target: BoatExecutionTarget,
    input: BoatGuestNetworkInput,
  ) => Effect.Effect<BoatGuestNetworkReceipt, Failure>;
  /**
   * Where Core's end of the tunnel's WebSocket carrier connects (`/sealant/tunnel` through Boat's
   * hosted HTTPS, with a fresh hosted cookie and the control token), from network setup until the
   * launch is held. Read again for every reconnect: the hosted cookie may expire.
   */
  readonly tunnel: (
    target: BoatExecutionTarget,
  ) => Effect.Effect<Redacted.Redacted<BoatTunnelConnection>, Failure>;
  /** Authenticated capture control for the original running or terminally held launch. */
  readonly control: (
    target: BoatExecutionTarget,
  ) => Effect.Effect<Redacted.Redacted<SealantTarget>, Failure>;
  /** Irreversibly prevents new worker starts, issued or running, without disturbing FINAL's daemon. */
  readonly hold: (target: BoatExecutionTarget) => Effect.Effect<void, Failure>;
  /**
   * Capture-only restart on the original boot of a held launch, handed the recovery boot's secret
   * env (the capture token the executor was launched with, as the recovery sweep unsealed it).
   * The agent's typed refusals (`BOAT_AGENT_RECOVER_REFUSALS`) fail as `agent-refused`.
   */
  readonly recover: (
    target: BoatExecutionTarget,
    secretEnv: Redacted.Redacted<Readonly<Record<string, string>>>,
  ) => Effect.Effect<BoatRecoveryOutcome, Failure>;
  /**
   * Fresh observation only: agent health, the tunnel's handshake and DNS, then daemon health. A
   * run without resources has no tunnel to observe: agent health, then daemon health.
   */
  readonly readiness: (target: BoatExecutionTarget) => Effect.Effect<BoatReadyReceipt, Failure>;
  /**
   * Whether the daemon of this run is up: its record, then one read of the agent's health for a
   * launch that was accepted (`running`) or fenced after it was issued (`held`). No tunnel and no
   * daemon probe. A failed read fails; it is never an exit.
   */
  readonly daemon: (target: BoatExecutionTarget) => Effect.Effect<BoatDaemonObservation, Failure>;
  /**
   * Opens the run's sealed bearer under the context it was sealed in, and nothing else: no Boat
   * request, no agent request. Fails if it does not open. A running session whose bearer no longer
   * opens cannot be drained, so the worker checks every one at start and says so.
   */
  readonly verifyBearer: (runId: string) => Effect.Effect<void, Failure>;
}
/** A current observation, never durable authority to admit a later request. */
export interface BoatReadyReceipt {
  readonly runtimeId: string;
  /** The boot the launch was accepted on: the agent's launch record is per boot. */
  readonly bootId: string;
  /** Digest of the binding and the frozen resource and tunnel receipts the launch ran under. */
  readonly isolationReceipt: string;
  /** `none`: a run without resources has no tunnel, so nothing shook hands and nothing resolves. */
  readonly handshake: "verified" | "none";
  readonly dns: "udp-and-tcp" | "none";
  readonly admission: "held";
}
/** Private key stays redacted until the authenticated HTTPS body is serialized. */
export interface BoatGuestNetworkInput {
  readonly network: BoatNetworkIntent;
  readonly privateKey: Redacted.Redacted<string>;
  readonly publicKey: string;
  readonly gatewayKey: string;
}
/** This acknowledgement proves configuration, not a handshake, resource reach or daemon health. */
export interface BoatGuestNetworkReceipt {
  readonly receipt: string;
  readonly handshake: "unverified";
  readonly admission: "held";
}
/** Core's end of the tunnel's WebSocket carrier: the URL and the headers that authenticate it. */
export interface BoatTunnelConnection {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}
/** Ordinary runtime registration does not provide this service until all activation gates pass. */
export class BoatExecution extends Context.Service<BoatExecution, BoatExecutionService>()(
  "@sealant/workspaces/boat/BoatExecution",
) {}

/** The launch body the agent contract names, from the sealed material and the exchanged bearer. */
export const boatLaunchRequest = (
  material: BoatLaunchMaterial,
  runId: string,
  bearer: string,
): AgentLaunchRequest => {
  const common = {
    runId,
    controlToken: bearer,
    flushTimeoutMs: BOAT_FLUSH_TIMEOUT_MS,
    bootEnv: material.bootEnv,
    secretEnvJson: JSON.stringify(material.secretEnv),
  };
  return material.docker
    ? { version: DOCKER_AGENT_CONTRACT_VERSION, ...common, services: { docker: "required" } }
    : { version: AGENT_CONTRACT_VERSION, ...common };
};

const bindingOf = (run: BoatRun, target: BoatExecutionTarget) => ({
  identity: identity(target),
  boot_id: target.bootId,
  epoch: run.admissionEpoch ?? undefined,
  operation_id: run.admissionOperationId ?? undefined,
});
/** A launch frozen with no resource network: its workspace was created without resources. */
const withoutResources = (run: BoatRun) => run.isolation !== null && "resources" in run.isolation;
/** What the readiness receipt digests: the binding and the frozen isolation receipts. */
const isolationReceiptOf = (run: BoatRun, target: BoatExecutionTarget) =>
  sha256(
    canonical(
      run.isolation !== null && "resources" in run.isolation
        ? { binding: bindingOf(run, target), resources: run.isolation.resources }
        : {
            binding: bindingOf(run, target),
            resource_receipt: run.isolation?.resourceReceipt,
            tunnel_receipt: run.isolation?.tunnelReceipt,
          },
    ),
  );
const bindingReceiptOf = (target: BoatExecutionTarget, exchangeId: string) =>
  sha256(
    canonical({ identity: identity(target), boot_id: target.bootId, operation_id: exchangeId }),
  );
/** What every secret of a run is sealed under: its bound target and its exchange. */
interface SealContext {
  readonly target: BoatExecutionTarget;
  readonly exchangeId: string;
}
/** A run whose bind exchange is reserved: the launch owner acts on nothing less. */
type BoundRun = BoatRun & SealContext;
/** What an external call must find unmoved when it returns: the launch, not the VM's observation. */
const launchState = (run: BoatRun) => ({
  phase: boatRunLaunchPhase(run),
  target: run.target,
  exchangeId: run.exchangeId,
  sealedControl: run.sealedControl,
  admissionOperationId: run.admissionOperationId,
  admissionEpoch: run.admissionEpoch,
  isolation: run.isolation,
});

const make: Effect.Effect<
  BoatExecution["Service"],
  never,
  BoatRunRepo | CredentialCipher | BoatGuestTransportService
> = Effect.gen(function* () {
  const runs = yield* BoatRunRepo;
  const cipher = yield* CredentialCipher;
  const transport = yield* BoatGuestTransportService;
  const seal = (record: SealContext, purpose: string, value: Redacted.Redacted<unknown>) =>
    cipher
      .encrypt(
        JSON.stringify({
          context: { target: record.target, exchangeId: record.exchangeId, purpose },
          value: Redacted.value(value),
        }),
      )
      .pipe(Effect.map((sealed) => sealed.sealed));
  const open = <T>(record: SealContext, purpose: string, sealed: string, schema: z.ZodType<T>) =>
    cipher.decrypt(sealed).pipe(
      Effect.flatMap((raw) =>
        attempt("seal-context-mismatch", () => {
          const parsed = z
            .strictObject({ context: z.unknown(), value: schema })
            .parse(JSON.parse(raw));
          if (
            !isDeepStrictEqual(parsed.context, {
              target: record.target,
              exchangeId: record.exchangeId,
              purpose,
            })
          )
            throw new Error();
          return Redacted.make(parsed.value);
        }),
      ),
    );
  /** The run with its bind exchange reserved, or fenced before one: what the launch owner owns. */
  const bound = (run: BoatRun | undefined): Effect.Effect<BoundRun, BoatExecutionError> => {
    if (run === undefined || run.target === null)
      return Effect.fail(new BoatExecutionError("invalid-input"));
    const { target, exchangeId } = run;
    if (exchangeId === null)
      return run.fencedAt === null
        ? Effect.fail(new BoatExecutionError("invalid-input"))
        : Effect.fail(new BoatExecutionError("invocation-held"));
    return Effect.succeed({ ...run, target, exchangeId });
  };
  const load = (id: string) => runs.get(id).pipe(Effect.flatMap(bound));
  const loadTarget = (target: BoatExecutionTarget) =>
    runs
      .get(target.runId)
      .pipe(
        Effect.flatMap((run) =>
          run === undefined
            ? Effect.fail(new BoatExecutionError("invalid-input"))
            : isDeepStrictEqual(run.target, target)
              ? bound(run)
              : Effect.fail(new BoatExecutionError("target-mismatch")),
        ),
      );
  /** The launch must not have moved under an external call that read it. */
  const unchanged = (run: BoatRun) =>
    runs
      .get(run.runId)
      .pipe(
        Effect.flatMap((now) =>
          now !== undefined && isDeepStrictEqual(launchState(now), launchState(run))
            ? Effect.void
            : Effect.fail(new BoatExecutionError("target-mismatch")),
        ),
      );
  /** The sealed launch material, checked against the frozen digest. */
  const openMaterial = (run: BoundRun, sealed: string) =>
    open(run, "admission", sealed, envelopeSchema).pipe(
      Effect.flatMap((envelope) =>
        sha256(canonical(Redacted.value(envelope))) === run.admissionDigest
          ? Effect.succeed(envelope)
          : Effect.fail(new BoatExecutionError("seal-context-mismatch")),
      ),
    );
  /** The run's bearer, opened under the context it was sealed in. Asks nothing of Boat. */
  const bearerOf = (run: BoundRun) =>
    Effect.gen(function* () {
      if (run.sealedControl === null)
        return yield* Effect.fail(new BoatExecutionError("invalid-input"));
      const opened = yield* open(run, "control", run.sealedControl, controlSchema);
      const stored = Redacted.value(opened);
      return yield* attempt("seal-context-mismatch", () => {
        const parsed = BoatSecret.parse(stored.bearer);
        if (!parsed.ok) throw new Error();
        return parsed.value;
      });
    });
  const access = (run: BoundRun) =>
    Effect.gen(function* () {
      const bearer = yield* bearerOf(run);
      // Hosted cookies may expire; each request refreshes access without repeating bootstrap.
      const hosted = yield* io(() => transport.host(run.target), "host-agent");
      return { hosted, bearer };
    });
  /**
   * Every secret value this launch handed the VM: the bearer, the hosted cookie and the launch's
   * secret environment. A material that no longer opens leaves the first two.
   */
  const launchSecrets = (
    run: BoundRun,
    connection: { hosted: BoatHostedControl; bearer: BoatSecret },
  ) =>
    (run.sealedLaunch === null
      ? Effect.succeed([])
      : openMaterial(run, run.sealedLaunch).pipe(
          Effect.map((material) => Object.values(Redacted.value(material).secretEnv)),
          Effect.orElseSucceed(() => []),
        )
    ).pipe(
      Effect.map((values) => [
        connection.bearer.reveal(),
        connection.hosted.cookie.reveal(),
        ...values,
      ]),
    );
  const call = (
    connection: { hosted: BoatHostedControl; bearer: BoatSecret },
    route: BoatAgentRoute,
    body?: Redacted.Redacted<string>,
  ) => io((signal) => transport.request(connection.hosted, connection.bearer, route, body, signal));
  /** A 409 whose body names a reason is the agent's refusal; typed, so it reads as one. */
  const refusal = (
    route: BoatAgentRoute,
    reply: BoatAgentReply,
    known: readonly string[],
  ): BoatExecutionError => {
    const parsed = boatAgentRefusalSchema.safeParse(reply.body);
    if (!parsed.success || !known.includes(parsed.data.reason))
      return new BoatExecutionError("invalid-reply");
    return new BoatExecutionError("agent-refused", {
      step: "agent-request",
      errorClass: "BoatExecutionError",
      code: "agent-refused",
      provider: { operation: `agent-${route}`, status: reply.status, causeClass: null },
      agent: {
        pathClass: boatAgentRoutes[route].pathClass,
        responseTail: "",
        reason: parsed.data.reason,
      },
    });
  };

  /**
   * The agent's health, parsed. The route lists 503 as answered because the agent's own health
   * is a JSON 503 before a launch and while its daemon is down; a 503 of any other shape is the
   * hosted proxy's (its VM booting, the agent's port not open yet): not ready, retried, never an
   * invalid reply.
   */
  const healthReply = (reply: BoatAgentReply) =>
    Effect.suspend(() => {
      const parsed = agentHealthResponseSchema.safeParse(reply.body);
      if (parsed.success) return Effect.succeed(parsed.data);
      return Effect.fail(
        reply.status === 503
          ? new BoatExecutionError("agent-not-ready", {
              step: "agent-request",
              errorClass: "BoatExecutionError",
              code: "agent-not-ready",
              provider: { operation: "agent-health", status: reply.status, causeClass: null },
              agent: { pathClass: AGENT_HEALTH_ROUTE, responseTail: "" },
            })
          : new BoatExecutionError("invalid-reply"),
      );
    });

  const exchange = Effect.fn("BoatExecution.exchange")(function* (input: BoatExecutionTarget) {
    const target = yield* attempt("invalid-input", () => boatExecutionTargetSchema.parse(input));
    let stored = yield* runs.get(target.runId);
    if (stored === undefined) return yield* Effect.fail(new BoatExecutionError("invalid-input"));
    if (!isDeepStrictEqual(stored.target, target))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    if (boatRunLaunchPhase(stored) === "none") {
      const key = yield* attempt("invalid-input", () =>
        generateKeyPairSync("rsa", {
          modulusLength: 3072,
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        }),
      );
      const reserved = { target, exchangeId: randomUUID() };
      const sealedExchange = yield* seal(
        reserved,
        "exchange",
        Redacted.make({ privateKey: key.privateKey }),
      );
      // Another reservation that won is returned in its place: one exchange per run.
      stored = yield* runs.beginExchange(target, {
        exchangeId: reserved.exchangeId,
        publicKey: key.publicKey,
        sealedExchange,
      });
    }
    const run = yield* bound(stored);
    const phase = boatRunLaunchPhase(run);
    if (phase === "aborted") return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    if (phase !== "exchange") return bindingReceiptOf(target, run.exchangeId);
    if (run.sealedExchange === null || run.exchangePublicKey === null)
      return yield* Effect.fail(new BoatExecutionError("invalid-input"));
    const request: BoatAgentBindRequest = {
      format: "sealant-bootstrap-v1",
      identity: identity(target),
      boot_id: target.bootId,
      manifest_digest: target.manifestDigest,
      operation_id: run.exchangeId,
      public_key: run.exchangePublicKey,
    };
    const raw = yield* io(() => transport.bind(target, request), "bind-exchange");
    const reply = yield* attempt("invalid-reply", () => {
      const parsed = boatAgentBindReplySchema.parse(raw);
      if (
        !isDeepStrictEqual(parsed.identity, request.identity) ||
        parsed.boot_id !== target.bootId ||
        parsed.operation_id !== run.exchangeId
      )
        throw new Error();
      return parsed;
    });
    const key = yield* open(run, "exchange", run.sealedExchange, exchangeSchema);
    const bearer = yield* attempt("invalid-reply", () => {
      const label = JSON.stringify([
        request.format,
        target.deploymentId,
        target.sandboxId,
        target.diskLineage,
        target.bootId,
        run.exchangeId,
        target.manifestDigest,
      ]);
      const plaintext = privateDecrypt(
        {
          key: Redacted.value(key).privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
          oaepLabel: Buffer.from(label),
        },
        Buffer.from(reply.ciphertext, "base64"),
      ).toString("utf8");
      if (!/^[a-f0-9]{64}$/.test(plaintext)) throw new Error();
      const parsed = BoatSecret.parse(plaintext);
      if (!parsed.ok) throw new Error();
      return parsed.value;
    });
    const hosted = yield* io(() => transport.host(target), "host-agent");
    // The bearer is proven end to end before it is sealed: the agent answers health to it (503
    // before a launch, as nothing is booted) and refuses any other bearer. Until the agent
    // listens, the proxy answers for it and the proof is tried again (`BIND_PROOF_RETRIES`).
    const health = yield* call({ hosted, bearer }, "health").pipe(
      Effect.flatMap(healthReply),
      Effect.retry(BIND_PROOF_RETRIES),
    );
    yield* attempt("invalid-reply", () => {
      if (health.booted) throw new Error();
    });
    const sealedControl = yield* seal(
      run,
      "control",
      Redacted.make({
        origin: hosted.origin,
        cookie: hosted.cookie.reveal(),
        bearer: bearer.reveal(),
      }),
    );
    yield* runs.sealControl(run.runId, run.exchangeId, sealedControl);
    return bindingReceiptOf(target, run.exchangeId);
  });
  const stage = Effect.fn("BoatExecution.stage")(function* (
    id: string,
    payload: Redacted.Redacted<BoatLaunchMaterial>,
  ) {
    const run = yield* load(id);
    const phase = boatRunLaunchPhase(run);
    if (phase === "exchange" || phase === "aborted")
      return yield* Effect.fail(new BoatExecutionError("invalid-input"));
    if (phase !== "control") return;
    const material = yield* attempt("invalid-input", () => {
      const value = envelopeSchema.parse(Redacted.value(payload));
      if (
        new Set(value.pins.credentialVersions.map((pin) => pin.id)).size !==
          value.pins.credentialVersions.length ||
        new Set(value.pins.dotfiles.map((pin) => pin.name)).size !== value.pins.dotfiles.length
      )
        throw new Error();
      return value;
    });
    const sealedLaunch = yield* seal(run, "admission", Redacted.make(material));
    yield* runs.stage(id, {
      epoch: 1,
      operationId: randomUUID(),
      digest: sha256(canonical(material)),
      docker: material.docker,
      sealedLaunch,
    });
  });
  const launch = Effect.fn("BoatExecution.launch")(function* (id: string) {
    let run = yield* load(id);
    const phase = boatRunLaunchPhase(run);
    if (phase === "held") return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    if (phase !== "installed" && phase !== "issued" && phase !== "running")
      return yield* Effect.fail(new BoatExecutionError("invalid-input"));
    if (run.isolation === null)
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    // The agent's launch record is durable per boot: an acknowledged launch is the one it adopted.
    if (phase === "running") return "running" as const;
    // Issuing and fencing compete on the row: once fenced, no push is ever issued.
    if (phase === "installed") run = yield* bound(yield* runs.issueLaunch(id));
    if (run.sealedLaunch === null)
      return yield* Effect.fail(new BoatExecutionError("invalid-input"));
    const material = yield* openMaterial(run, run.sealedLaunch);
    const connection = yield* access(run);
    const body = boatLaunchRequest(
      Redacted.value(material),
      run.target.runId,
      connection.bearer.reveal(),
    );
    const reply = yield* call(connection, "launch", Redacted.make(JSON.stringify(body)));
    if (reply.status === 409) {
      // The agent's "already booted" is this launch, accepted by an earlier push whose reply was
      // lost: adopted, never pushed again. A `{reason}` is no such answer (today's agent refuses
      // no launch that way), so it is never adopted as one.
      if (boatAgentRefusalSchema.safeParse(reply.body).success)
        return yield* Effect.fail(new BoatExecutionError("invalid-reply"));
    } else {
      yield* attempt("invalid-reply", () => agentLaunchResponseSchema.parse(reply.body));
    }
    yield* runs.acceptLaunch(id);
    return "running" as const;
  });
  const isolate = Effect.fn("BoatExecution.isolate")(function* (
    target: BoatExecutionTarget,
    input: BoatGuestNetworkInput,
  ) {
    const run = yield* loadTarget(target);
    if (
      !["installed", "issued", "running"].includes(boatRunLaunchPhase(run)) ||
      run.admissionOperationId === null ||
      // Frozen without a resource network: this guest is never given one.
      withoutResources(run)
    )
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    const network = yield* attempt("invalid-input", () =>
      boatNetworkIntentSchema.parse(input.network),
    );
    if (network.epoch !== run.admissionEpoch || network.operationId !== run.admissionOperationId)
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    const binding = bindingOf(run, target);
    const connection = yield* access(run);
    // The tunnel is carried over the agent's `/sealant/tunnel`, the only way it is: the VM dials
    // nothing. An agent that does not say it can carry it (an image older than the carrier) cannot
    // be given a tunnel, and says so by name instead of failing at the handshake.
    const carried = yield* call(connection, "network-status").pipe(
      Effect.flatMap((status) =>
        attempt(
          "invalid-reply",
          () =>
            boatAgentNetworkStatusSchema.parse(status.body).carriers?.includes("websocket") ===
            true,
        ),
      ),
    );
    if (!carried)
      return yield* Effect.fail(
        new BoatExecutionError("carrier-unavailable", {
          step: "readiness",
          errorClass: "BoatExecutionError",
          code: "carrier-unavailable",
          resourceOperation: "isolate-guest",
        }),
      );
    const body = yield* attempt("invalid-input", () =>
      Redacted.make(
        JSON.stringify({
          format: "sealant-guest-network-v1",
          binding,
          private_key: boatWireGuardKeySchema.parse(Redacted.value(input.privateKey)),
          public_key: boatWireGuardKeySchema.parse(input.publicKey),
          gateway_key: boatWireGuardKeySchema.parse(input.gatewayKey),
          carrier: "websocket",
          subnet: network.subnet,
        } satisfies BoatAgentNetworkRequest),
      ),
    );
    const reply = yield* call(connection, "network", body);
    const receipt = yield* attempt("invalid-reply", () => {
      const parsed = boatAgentNetworkResponseSchema.parse(reply.body);
      if (!isDeepStrictEqual(parsed.binding, binding)) throw new Error();
      return { receipt: parsed.receipt, handshake: parsed.handshake, admission: "held" as const };
    });
    yield* unchanged(run);
    return receipt;
  });
  const recordIsolation = Effect.fn("BoatExecution.recordIsolation")(function* (
    target: BoatExecutionTarget,
    receipts: BoatRunIsolation,
  ) {
    const run = yield* loadTarget(target);
    yield* runs.isolate(run.runId, receipts);
  });
  const readiness = Effect.fn("BoatExecution.readiness")(function* (target: BoatExecutionTarget) {
    const run = yield* loadTarget(target);
    if (boatRunLaunchPhase(run) !== "running" || run.isolation === null || run.docker === null)
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    const docker = run.docker;
    const connection = yield* access(run);
    // Every failure names the check that did not pass (`check`): what is retried until the VM is
    // ready (`agent-not-ready`) and what is lost for good (`guest-failed`) read the same way.
    type Check = NonNullable<BoatLaunchDiagnostic["check"]>;
    const notReady = (
      pathClass: NonNullable<BoatLaunchDiagnostic["agent"]>["pathClass"],
      check: Check,
      tunnel?: BoatLaunchDiagnostic["tunnel"],
    ) =>
      new BoatExecutionError("agent-not-ready", {
        step: "readiness",
        errorClass: "BoatExecutionError",
        code: "agent-not-ready",
        check,
        agent: { pathClass, responseTail: "" },
        ...(tunnel === undefined ? {} : { tunnel }),
      });
    const guestFailure = (guest: NonNullable<BoatLaunchDiagnostic["guest"]>, check?: Check) =>
      new BoatExecutionError("guest-failed", {
        step: "readiness",
        errorClass: "BoatExecutionError",
        code: "guest-failed",
        ...(check === undefined ? {} : { check }),
        guest,
      });
    // 1. The agent: the daemon it started is up with its control socket, and Docker when asked.
    const health = yield* call(connection, "health");
    const observed = yield* healthReply(health);
    if (observed.daemonExit !== undefined) {
      const output = observed.daemonExit.output;
      return yield* Effect.fail(
        guestFailure({
          service: "sealantd",
          exitCode: observed.daemonExit.code,
          ...(output === undefined
            ? {}
            : { outputTail: boatGuestOutput(output, yield* launchSecrets(run, connection)) }),
        }),
      );
    }
    if (docker && !("version" in observed))
      return yield* Effect.fail(new BoatExecutionError("invalid-reply"));
    if ("version" in observed && observed.services.docker.status === "failed")
      return yield* Effect.fail(
        guestFailure(
          {
            service: "docker",
            exitCode: observed.services.docker.code,
            reason: observed.services.docker.reason,
            ...(observed.services.docker.output === undefined
              ? {}
              : {
                  outputTail: boatGuestOutput(
                    observed.services.docker.output,
                    yield* launchSecrets(run, connection),
                  ),
                }),
          },
          "docker",
        ),
      );
    if (!observed.booted) return yield* Effect.fail(notReady(AGENT_HEALTH_ROUTE, "booted"));
    if (!observed.controlSocket)
      return yield* Effect.fail(notReady(AGENT_HEALTH_ROUTE, "control-socket"));
    if (docker && !("version" in observed && observed.services.docker.status === "ready"))
      return yield* Effect.fail(notReady(AGENT_HEALTH_ROUTE, "docker"));
    // 3. The daemon itself, through the agent's authenticated control relay.
    const probeDaemon = Effect.gen(function* () {
      const daemon = yield* io(
        () => transport.probe(connection.hosted, connection.bearer),
        "readiness",
      );
      if (!daemon.healthy || !/^rt_[a-zA-Z0-9_-]+$/.test(daemon.runtimeId))
        return yield* Effect.fail(new BoatExecutionError("invalid-reply"));
      yield* unchanged(run);
      return daemon.runtimeId;
    });
    // A run without resources has no tunnel: nothing to shake hands with and no resolver of ours.
    if (withoutResources(run))
      return {
        runtimeId: yield* probeDaemon,
        bootId: target.bootId,
        isolationReceipt: isolationReceiptOf(run, target),
        handshake: "none" as const,
        dns: "none" as const,
        admission: "held" as const,
      };
    // 2. The tunnel: the gateway shook hands and its resolver answers over UDP and TCP.
    const network = yield* call(connection, "network-status");
    const tunnel = yield* attempt("invalid-reply", () =>
      boatAgentNetworkStatusSchema.parse(network.body),
    );
    if (!tunnel.configured)
      return yield* Effect.fail(notReady(BOAT_AGENT_NETWORK_ROUTE, "network"));
    if (tunnel.handshake !== "verified")
      return yield* Effect.fail(
        notReady(
          BOAT_AGENT_NETWORK_ROUTE,
          "handshake",
          tunnel.transfer === undefined && tunnel.carrier_attached === undefined
            ? undefined
            : {
                ...(tunnel.transfer === undefined
                  ? {}
                  : { sentBytes: tunnel.transfer.sent, receivedBytes: tunnel.transfer.received }),
                ...(tunnel.carrier_attached === undefined
                  ? {}
                  : { carrierAttached: tunnel.carrier_attached }),
              },
        ),
      );
    if (tunnel.dns !== "udp-and-tcp")
      return yield* Effect.fail(notReady(BOAT_AGENT_NETWORK_ROUTE, "dns"));
    return {
      runtimeId: yield* probeDaemon,
      bootId: target.bootId,
      isolationReceipt: isolationReceiptOf(run, target),
      handshake: "verified" as const,
      dns: "udp-and-tcp" as const,
      admission: "held" as const,
    };
  });

  const tunnel = Effect.fn("BoatExecution.tunnel")(function* (target: BoatExecutionTarget) {
    const run = yield* loadTarget(target);
    if (
      !["installed", "issued", "running"].includes(boatRunLaunchPhase(run)) ||
      run.admissionOperationId === null ||
      withoutResources(run)
    )
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    const connection = yield* access(run);
    return Redacted.make<BoatTunnelConnection>(
      boatTunnelConnection(connection.hosted, connection.bearer),
    );
  });
  const control = Effect.fn("BoatExecution.control")(function* (target: BoatExecutionTarget) {
    const run = yield* loadTarget(target);
    const phase = boatRunLaunchPhase(run);
    if (phase !== "running" && phase !== "held")
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    const connection = yield* access(run);
    return Redacted.make<SealantTarget>({
      kind: "websocket",
      ...boatControlConnection(connection.hosted, connection.bearer),
      auth: { bearerToken: connection.bearer.reveal() },
    });
  });
  const hold = Effect.fn("BoatExecution.hold")(function* (target: BoatExecutionTarget) {
    const run = yield* loadTarget(target);
    const phase = boatRunLaunchPhase(run);
    if (phase === "held") return;
    // An issued launch whose reply never came is fenced too: Core never pushes it again, and the
    // agent only ever adopts a launch it already recorded (audit S5).
    if (phase !== "running" && phase !== "issued")
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    yield* runs.fence(run.runId);
  });
  const recover = Effect.fn("BoatExecution.recover")(function* (
    target: BoatExecutionTarget,
    secretEnv: Redacted.Redacted<Readonly<Record<string, string>>>,
  ) {
    const run = yield* loadTarget(target);
    if (boatRunLaunchPhase(run) !== "held" || run.isolation === null)
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    // The capture token travels with the recovery: a recovery boot without it could ship nothing.
    const token = Redacted.value(secretEnv)["SEALANT_CAPTURE_TOKEN"];
    if (token === undefined || token.length === 0)
      return yield* Effect.fail(new BoatExecutionError("invalid-input"));
    const connection = yield* access(run);
    const reply = yield* call(
      connection,
      "recover",
      Redacted.make(
        JSON.stringify({
          version: AGENT_RECOVER_CONTRACT_VERSION,
          runId: target.runId,
          // The agent takes exactly the capture token, whatever else the sweep handed over.
          secretEnvJson: JSON.stringify({ SEALANT_CAPTURE_TOKEN: token }),
        }),
      ),
    );
    if (reply.status === 409)
      return yield* Effect.fail(refusal("recover", reply, BOAT_AGENT_RECOVER_REFUSALS));
    const outcome = yield* attempt("invalid-reply", () =>
      boatAgentRecoverResponseSchema.parse(reply.body),
    );
    yield* unchanged(run);
    if (outcome.outcome === "running") return "running" as const;
    if (outcome.outcome === "restarted") return "restarted" as const;
    return {
      outcome: "nothing-to-save" as const,
      basis: outcome.basis,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    };
  });
  const daemon = Effect.fn("BoatExecution.daemon")(function* (target: BoatExecutionTarget) {
    const stored = yield* runs.get(target.runId);
    if (stored === undefined) return yield* Effect.fail(new BoatExecutionError("invalid-input"));
    if (!isDeepStrictEqual(stored.target, target))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    const phase = boatRunLaunchPhase(stored);
    // Fenced before any launch push: nothing was ever started on the VM.
    if (phase === "aborted") return { kind: "never-launched" } as const;
    if (phase !== "running" && phase !== "held") return { kind: "unasked" } as const;
    const run = yield* bound(stored);
    const connection = yield* access(run);
    const observed = yield* call(connection, "health").pipe(Effect.flatMap(healthReply));
    if (observed.daemonExit !== undefined) {
      const output = observed.daemonExit.output;
      return {
        kind: "exited" as const,
        exitCode: observed.daemonExit.code,
        // The guest's word: only a signal's name is repeated.
        signal:
          observed.daemonExit.signal === null ||
          /^SIG[A-Z0-9]{1,12}$/.test(observed.daemonExit.signal)
            ? observed.daemonExit.signal
            : "unrecognized",
        // The agent removes the launch's secrets itself; the bearer is removed again here.
        ...(output === undefined
          ? {}
          : { output: safeCommandTail(boatGuestOutput(output, [connection.bearer.reveal()])) }),
      };
    }
    return { kind: observed.booted ? "up" : "not-booted" } as const;
  });
  const verifyBearer = Effect.fn("BoatExecution.verifyBearer")(function* (runId: string) {
    yield* bearerOf(yield* load(runId));
  });
  return BoatExecution.of({
    exchange,
    stage,
    recordIsolation,
    launch,
    isolate,
    readiness,
    tunnel,
    control,
    hold,
    recover,
    daemon,
    verifyBearer,
  });
});
/** Open assembly for worker infrastructure and faithful test transports. */
export const boatExecutionLayerNoDeps: Layer.Layer<
  BoatExecution,
  never,
  BoatRunRepo | CredentialCipher | BoatGuestTransportService
> = Layer.effect(BoatExecution, make);
/** Owns its PostgreSQL repository; the worker supplies cipher and authenticated guest transport. */
export const boatExecutionLayer: Layer.Layer<
  BoatExecution,
  never,
  SealantDB | CredentialCipher | BoatGuestTransportService
> = boatExecutionLayerNoDeps.pipe(Layer.provide(BoatRunRepoLive));

export type { BoatAdmissionPins };
