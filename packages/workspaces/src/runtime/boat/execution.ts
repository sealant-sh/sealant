import {
  constants,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  randomUUID,
} from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { CredentialCipher, type CredentialCipherError } from "@sealant/credentials";
import {
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  type BoatExecutionStoreError,
  type SealantDB,
} from "@sealant/db";
import { RuntimeState } from "@sealant/runtime-protocol";
import {
  boatAdmissionPinsSchema,
  boatNetworkIntentSchema,
  boatWireGuardKeySchema,
  boatExecutionTargetSchema,
  type BoatAdmissionPins,
  type BoatExecutionRecord,
  type BoatExecutionTarget,
  type BoatNetworkIntent,
} from "@sealant/validators";
import { Context, Effect, Layer, Redacted } from "effect";
import { z } from "zod";

import receiverRoutes from "../../../boat-image/receiver-routes.json" with { type: "json" };
import { safeCommandTail } from "../../images/boat/command-diagnostics.js";
import type { SealantRuntimeService, SealantTarget } from "../../sealantd/runtime.js";
import type { BoatApi } from "./api.js";
import { BoatApiError, BoatSecret, boatSandboxIdSchema, parseBoatUrl } from "./config.js";
import { boatControlConnection, type BoatHostedControl } from "./connection.js";
import {
  boatLaunchDiagnostic,
  boatLaunchSummary,
  type BoatLaunchDiagnostic,
} from "./launch-diagnostics.js";

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const identitySchema = z.strictObject({
  deployment_id: name,
  instance_id: name,
  disk_lineage: name,
});
const statusSchema = z.strictObject({
  format: z.literal("sealant-receiver-status-v1"),
  identity: identitySchema,
  boot_id: z.uuid(),
  admission: z.literal("held"),
  execution: z.enum(["unavailable", "issued", "running", "ended", "unresolved"]),
  epoch: z.number().int().positive().nullable(),
  operation_id: z.string().nullable(),
  stage: z.enum(["empty", "prepared", "installed", "previous-boot"]),
});
type Status = z.infer<typeof statusSchema>;
const fileSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  data: z.string().max((2 * 1024 * 1024 * 4) / 3 + 4),
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const stageSchema = z.strictObject({
  format: z.literal("sealant-admission-stage-v1"),
  identity: identitySchema,
  boot_id: z.uuid(),
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  operation_id: z.uuid(),
  files: z.array(fileSchema).min(1).max(16),
});
const envelopeSchema = z.strictObject({ wire: stageSchema, pins: boatAdmissionPinsSchema });
const bootstrapSchema = z.strictObject({
  format: z.literal("sealant-bootstrap-v1"),
  identity: identitySchema,
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

const receiverRouteNames = [
  "status",
  "stage",
  "start",
  "isolate",
  "permit",
  "readiness",
  "recover",
  "park",
] as const;
export type BoatReceiverRoute = (typeof receiverRouteNames)[number];
const reasonCode = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const receiverContract = z
  .strictObject({
    format: z.literal("sealant-receiver-routes-v1"),
    routes: z.array(
      z.strictObject({
        name: z.enum(receiverRouteNames),
        path: z.string(),
        method: z.enum(["GET", "POST"]),
        budgetMs: z.number().int().positive(),
      }),
    ),
    transientReasons: z.array(reasonCode),
  })
  .parse(receiverRoutes);
/** Receiver reasons that report an observation which may change on retry, not a policy refusal. */
export const boatReceiverTransientReasons: ReadonlySet<string> = new Set(
  receiverContract.transientReasons,
);
/** Budgets come from the route list the relay and the guest receiver also read. */
export const boatReceiverRoutes: ReadonlyMap<
  BoatReceiverRoute,
  { readonly method: "GET" | "POST"; readonly budgetMs: number }
> = (() => {
  const routes = receiverContract.routes;
  const table = new Map(routes.map((route) => [route.name, route]));
  if (
    table.size !== routes.length ||
    table.size !== receiverRouteNames.length ||
    routes.some((route) => route.path !== `/sealant/bootstrap/${route.name}`)
  )
    throw new Error("Boat receiver route list does not match Core's routes");
  return table;
})();
const receiverRoute = (route: BoatReceiverRoute) => {
  const found = boatReceiverRoutes.get(route);
  if (found === undefined) throw new BoatExecutionError("invalid-input");
  return found;
};

/**
 * The receiver's reason decides, not its status alone: a transient observation such as a lost DNS
 * answer stays retryable, a policy refusal is final. No reply and 5xx stay transport failures.
 */
export type BoatReceiverFailureCode =
  | "receiver-rejected"
  | "receiver-unauthorized"
  | "receiver-route-missing"
  | "receiver-refused"
  | "receiver-not-ready"
  | "transport-unavailable";
export const boatReceiverFailureCode = (status: number, reason?: string): BoatReceiverFailureCode =>
  (status === 400 || status === 409) &&
  reason !== undefined &&
  boatReceiverTransientReasons.has(reason)
    ? "receiver-not-ready"
    : status === 400
      ? "receiver-rejected"
      : status === 401 || status === 403
        ? "receiver-unauthorized"
        : status === 404
          ? "receiver-route-missing"
          : status === 409
            ? "receiver-refused"
            : "transport-unavailable";
/** The one retry rule for guest work: lost transport or a receiver that is not ready yet. */
export const boatExecutionRetryable = (error: unknown): boolean =>
  error instanceof BoatExecutionError &&
  (error.code === "transport-unavailable" || error.code === "receiver-not-ready");
const receiverReasonSchema = z.object({
  error: reasonCode,
  detail: z
    .string()
    .regex(/^[A-Za-z0-9_./,=+-]{1,256}$/)
    .optional(),
});
/** The receiver's classified reason code, never its free text. */
const receiverReason = (tail: string): { reason?: string; detail?: string } => {
  try {
    const parsed = receiverReasonSchema.safeParse(JSON.parse(tail));
    return parsed.success
      ? {
          reason: parsed.data.error,
          ...(parsed.data.detail === undefined ? {} : { detail: parsed.data.detail }),
        }
      : {};
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
      | BoatReceiverFailureCode,
    diagnostic?: BoatLaunchDiagnostic,
  ) {
    const safe =
      diagnostic === undefined ? undefined : boatLaunchDiagnostic({ diagnostic }, diagnostic.step);
    super(`Boat execution: ${code}${boatLaunchSummary(safe)}`);
    this.diagnostic = safe;
  }
}
type Failure = BoatExecutionError | BoatExecutionStoreError | CredentialCipherError;
const attempt = <A>(code: BoatExecutionError["code"], run: () => A) =>
  Effect.try({ try: run, catch: () => new BoatExecutionError(code) });
const io = <A>(
  run: (signal: AbortSignal) => Promise<A>,
  step: BoatLaunchDiagnostic["step"] = "receiver-request",
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
const receiverFailureTail = async (
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
      // A failed upstream may echo staging data, including base64 files and credential values.
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
  readonly bind: (target: BoatExecutionTarget, request: unknown) => Promise<unknown>;
  readonly host: (target: BoatExecutionTarget) => Promise<BoatHostedControl>;
  /** Only read-only status probes retry transient startup failures: at most 20 reads / 20 seconds. */
  readonly call: (
    access: BoatHostedControl,
    bearer: BoatSecret,
    route: BoatReceiverRoute,
    body?: Redacted.Redacted<string>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  /** Round-trips daemon health and capabilities through the authenticated relay. */
  readonly probe: (access: BoatHostedControl, bearer: BoatSecret) => Promise<BoatDaemonReady>;
}

/** Safe daemon observation. The generated runtime ID is correlated by the surrounding invocation reads. */
export interface BoatDaemonReady {
  readonly runtimeId: string;
  readonly healthy: boolean;
  readonly supports: readonly string[];
}

/** Only public identity requests use the provider command channel. Launch secrets use hosted HTTPS. */
export const boatGuestPublicCommand = (action: "bind" | "resume", request: unknown) => {
  const raw = JSON.stringify(request);
  if (raw.length > 8192) throw new BoatExecutionError("invalid-input");
  const root = "/var/lib/sealant/guest";
  return `/usr/bin/sudo -n -- ${root}/bundle/lib64/ld-linux-x86-64.so.2 --inhibit-cache --library-path ${root}/bundle/lib/x86_64-linux-gnu:${root}/bundle/usr/lib/x86_64-linux-gnu:${root}/bundle/usr/lib/x86_64-linux-gnu/systemd ${root}/bundle/usr/bin/python3 -I -S -B ${root}/guest_boot.py ${action} '${raw.replaceAll("'", "'\\''")}'`;
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
  const receiverRequest: BoatGuestTransport["call"] = async (
    access,
    bearer,
    route,
    body,
    signal,
  ) => {
    const origin = parseBoatUrl(access.origin);
    if (!origin.ok || origin.value.href !== `${access.origin}/`)
      throw new BoatExecutionError("invalid-input");
    const pathClass = `/sealant/bootstrap/${route}` as const;
    const { method, budgetMs } = receiverRoute(route);
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
          new BoatApiError(`receiver-${route}`, null, "transport_error", error),
          "receiver-request",
        ),
        receiver: { pathClass, responseTail: "" },
      });
    }
    if (!response.ok) {
      const responseTail = await receiverFailureTail(
        response,
        [access.cookie.reveal(), bearer.reveal()],
        body,
      );
      const reason = receiverReason(responseTail);
      const code = boatReceiverFailureCode(response.status, reason.reason);
      throw new BoatExecutionError(code, {
        step: "receiver-request",
        errorClass: "BoatExecutionError",
        code,
        provider: { operation: `receiver-${route}`, status: response.status, causeClass: null },
        receiver: { pathClass, responseTail, ...reason },
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
      return JSON.parse(raw);
    } catch (error) {
      if (error instanceof BoatExecutionError) throw error;
      throw new BoatExecutionError("invalid-reply", {
        ...boatLaunchDiagnostic(
          new BoatApiError(`receiver-${route}`, response.status, "invalid_reply", error),
          "receiver-request",
        ),
        receiver: { pathClass, responseTail: "" },
      });
    } finally {
      await reader.cancel().catch(() => {});
    }
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
            const capabilities = yield* session.capabilities;
            return {
              runtimeId: health.runtimeId,
              healthy: health.state === RuntimeState.HEALTHY,
              supports: capabilities.supports,
            };
          }),
        ).pipe(Effect.timeout(15_000)),
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
      const command = boatGuestPublicCommand("bind", publicRequest.data);
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
      )
        throw new BoatExecutionError("transport-unavailable", {
          step: "bind-exchange",
          errorClass: "BoatExecutionError",
          command: {
            exitCode: result.value.exitCode,
            timedOut: result.value.timedOut,
            stdoutTail: safeCommandTail(result.value.stdout),
            stderrTail: safeCommandTail(result.value.stderr),
          },
        });
      return JSON.parse(result.value.stdout);
    },
    host: async (target) => {
      const result = await api.hostControl(await verify(target));
      if (!result.ok)
        throw new BoatExecutionError(
          "transport-unavailable",
          boatLaunchDiagnostic(result.error, "host-receiver"),
        );
      return result.value;
    },
    call: async (access, bearer, route, body, signal) => {
      if (route !== "status") return receiverRequest(access, bearer, route, body, signal);
      // Only this read-only authenticated probe may retry. No POST is replayed by the transport.
      const budget = AbortSignal.any([
        AbortSignal.timeout(20_000),
        ...(signal === undefined ? [] : [signal]),
      ]);
      let last: BoatExecutionError | undefined;
      for (let count = 0; count < 20; count++) {
        try {
          return await receiverRequest(
            access,
            bearer,
            route,
            body,
            AbortSignal.any([budget, AbortSignal.timeout(receiverRoute("status").budgetMs)]),
          );
        } catch (error) {
          const provider =
            error instanceof BoatExecutionError ? error.diagnostic?.provider : undefined;
          if (
            !(error instanceof BoatExecutionError) ||
            !provider ||
            provider.operation !== "receiver-status" ||
            !(provider.status === null || [502, 503, 504].includes(provider.status))
          )
            throw error;
          last = error;
          if (budget.aborted || count === 19) throw error;
          try {
            await delay(500, undefined, { signal: budget });
          } catch {
            throw error;
          }
        }
      }
      throw last ?? new BoatExecutionError("transport-unavailable");
    },
  };
};

/** This layer is deliberately absent from ordinary runtime registration until isolation and custody land. */
export class BoatGuestTransportService extends Context.Service<
  BoatGuestTransportService,
  BoatGuestTransport
>()("@sealant/workspaces/boat/BoatGuestTransport") {}
/** Owns sealed bootstrap and one frozen admission. Running acknowledges an invocation, not daemon readiness. */
export interface BoatExecutionService {
  /** Reopens only the original encrypted payload for its canonical custody owner. Never reads guest disk secrets. */
  readonly parkingMaterial: (target: BoatExecutionTarget) => Effect.Effect<
    Redacted.Redacted<{
      readonly files: readonly { readonly name: string; readonly bytes: Uint8Array }[];
      readonly pins: BoatAdmissionPins;
    }>,
    Failure
  >;
  /** Replays only the reserved exchange; a different target or boot refuses. */
  readonly exchange: (target: BoatExecutionTarget) => Effect.Effect<void, Failure>;
  /** The payload is used only on first preparation. Later calls deliver the original sealed envelope. */
  readonly stage: (
    id: string,
    payload: Redacted.Redacted<{
      readonly files: readonly { readonly name: string; readonly bytes: Uint8Array }[];
      readonly pins: BoatAdmissionPins;
    }>,
  ) => Effect.Effect<void, Failure>;
  /** A lost reply may adopt the exact running invocation. Ended or ambiguous disks remain held. */
  readonly start: (id: string) => Effect.Effect<"running", Failure>;
  /** Authenticated network setup for the installed epoch only. It never issues an execution permit. */
  readonly isolate: (
    target: BoatExecutionTarget,
    input: BoatGuestNetworkInput,
  ) => Effect.Effect<BoatGuestNetworkReceipt, Failure>;

  /** Authenticated capture control for the original running or terminally held invocation. */
  readonly control: (
    target: BoatExecutionTarget,
  ) => Effect.Effect<Redacted.Redacted<SealantTarget>, Failure>;
  /** Irreversibly prevents new worker starts, issued or running, without disturbing FINAL's daemon. */
  readonly hold: (target: BoatExecutionTarget) => Effect.Effect<void, Failure>;
  /** Capture-only restart on the original boot. Missing original tmpfs remains held. */
  readonly recover: (
    target: BoatExecutionTarget,
  ) => Effect.Effect<"running" | "pending" | "held", Failure>;
  /** Closes the held invocation's writers and returns its durable volatile-data capsule. */
  readonly park: (
    target: BoatExecutionTarget,
    operationId: string,
  ) => Effect.Effect<BoatParkingReceipt, Failure>;
  /** Freezes isolation receipts before authenticated, replay-safe permit issuance. */
  readonly permit: (
    target: BoatExecutionTarget,
    receipts: NonNullable<BoatExecutionRecord["isolation"]>,
  ) => Effect.Effect<void, Failure>;
  /** Fresh observation only. Never starts, grants a permit or publishes a runtime row. */
  readonly readiness: (target: BoatExecutionTarget) => Effect.Effect<BoatReadyReceipt, Failure>;
}
/** Correlated guest evidence only. Provider stop, snapshot custody and deletion are separate. */
export interface BoatParkingReceipt {
  readonly operationId: string;
  readonly capsuleHash: string;
  readonly archiveHash: string;
  readonly contentBytes: number;
  readonly storedBytes: number;
  readonly entries: number;
}
/** A current observation, never durable authority to admit a later request. */
export interface BoatReadyReceipt {
  readonly invocation: string;
  readonly runtimeId: string;
  readonly permitReceipt: string;
  readonly handshake: "verified";
  readonly admission: "held";
}
/** Private key stays redacted until the authenticated HTTPS body is serialized. */
export interface BoatGuestNetworkInput {
  readonly network: BoatNetworkIntent;
  readonly privateKey: Redacted.Redacted<string>;
  readonly publicKey: string;
  readonly gatewayKey: string;
  readonly port: number;
}
/** This acknowledgement proves configuration, not a handshake, resource reach or daemon health. */
export interface BoatGuestNetworkReceipt {
  readonly receipt: string;
  readonly handshake: "unverified";
  readonly admission: "held";
}
/** Ordinary runtime registration does not provide this service until all activation gates pass. */
export class BoatExecution extends Context.Service<BoatExecution, BoatExecutionService>()(
  "@sealant/workspaces/boat/BoatExecution",
) {}

const make: Effect.Effect<
  BoatExecution["Service"],
  never,
  BoatExecutionRepo | CredentialCipher | BoatGuestTransportService
> = Effect.gen(function* () {
  const repo = yield* BoatExecutionRepo;
  const cipher = yield* CredentialCipher;
  const transport = yield* BoatGuestTransportService;
  const seal = (
    record: Pick<BoatExecutionRecord, "target" | "exchangeId">,
    purpose: string,
    value: Redacted.Redacted<unknown>,
  ) =>
    cipher
      .encrypt(
        JSON.stringify({
          context: { target: record.target, exchangeId: record.exchangeId, purpose },
          value: Redacted.value(value),
        }),
      )
      .pipe(Effect.map((sealed) => sealed.sealed));
  const open = <T>(
    record: BoatExecutionRecord,
    purpose: string,
    sealed: string,
    schema: z.ZodType<T>,
  ) =>
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
  const load = (id: string) =>
    repo
      .get(id)
      .pipe(
        Effect.flatMap((record) =>
          record === undefined
            ? Effect.fail(new BoatExecutionError("invalid-input"))
            : Effect.succeed(record),
        ),
      );
  const checkStatus = (record: BoatExecutionRecord, value: unknown, staged: boolean) =>
    attempt("invalid-reply", () => {
      const result = statusSchema.parse(value);
      if (
        !isDeepStrictEqual(result.identity, identity(record.target)) ||
        result.boot_id !== record.target.bootId ||
        result.stage === "previous-boot" ||
        (!staged &&
          (result.stage !== "empty" ||
            result.epoch !== null ||
            result.operation_id !== null ||
            result.execution !== "unavailable")) ||
        (staged &&
          (result.epoch !== record.admission?.epoch ||
            result.operation_id !== record.admission?.operationId))
      )
        throw new Error();
      return result;
    });
  const access = (record: BoatExecutionRecord) =>
    Effect.gen(function* () {
      if (record.sealedControl === null)
        return yield* Effect.fail(new BoatExecutionError("invalid-input"));
      const opened = yield* open(record, "control", record.sealedControl, controlSchema);
      const stored = Redacted.value(opened);
      // Hosted cookies may expire; each request refreshes access without repeating bootstrap.
      const hosted = yield* io(() => transport.host(record.target), "host-receiver");
      const bearer = yield* attempt("seal-context-mismatch", () => {
        const parsed = BoatSecret.parse(stored.bearer);
        if (!parsed.ok) throw new Error();
        return parsed.value;
      });
      return { hosted, bearer };
    });
  const exchange = Effect.fn("BoatExecution.exchange")(function* (input: BoatExecutionTarget) {
    const target = yield* attempt("invalid-input", () => boatExecutionTargetSchema.parse(input));
    let record = yield* repo.get(target.runtimeInstanceId);
    if (record !== undefined && !isDeepStrictEqual(record.target, target))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    if (record === undefined) {
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
      record = yield* repo.reserve({
        ...reserved,
        publicKey: key.publicKey,
        sealedExchange,
        sealedControl: null,
        admission: null,
        phase: "exchange",
      });
    }
    if (record.phase === "aborted")
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    if (record.phase !== "exchange") return;
    if (record.sealedExchange === null)
      return yield* Effect.fail(new BoatExecutionError("invalid-input"));
    const request = {
      format: "sealant-bootstrap-v1",
      identity: identity(target),
      boot_id: target.bootId,
      manifest_digest: target.manifestDigest,
      operation_id: record.exchangeId,
      public_key: record.publicKey,
    };
    const raw = yield* io(() => transport.bind(target, request), "bind-exchange");
    const reply = yield* attempt("invalid-reply", () => {
      const parsed = z
        .object({
          format: z.literal("sealant-bootstrap-reply-v1"),
          identity: identitySchema,
          boot_id: z.uuid(),
          operation_id: z.uuid(),
          ciphertext: z.string().regex(/^[A-Za-z0-9+/]{512}$/),
          admission: z.literal("held"),
          boot: z.object({ status: z.literal("compatible") }),
        })
        .parse(raw);
      if (
        !isDeepStrictEqual(parsed.identity, request.identity) ||
        parsed.boot_id !== target.bootId ||
        parsed.operation_id !== record.exchangeId
      )
        throw new Error();
      return parsed;
    });
    const key = yield* open(record, "exchange", record.sealedExchange, exchangeSchema);
    const bearer = yield* attempt("invalid-reply", () => {
      const label = JSON.stringify([
        request.format,
        target.deploymentId,
        target.sandboxId,
        target.diskLineage,
        target.bootId,
        record.exchangeId,
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
    const hosted = yield* io(() => transport.host(target), "host-receiver");
    yield* checkStatus(
      record,
      yield* io((signal) => transport.call(hosted, bearer, "status", undefined, signal)),
      false,
    );
    const sealedControl = yield* seal(
      record,
      "control",
      Redacted.make({
        origin: hosted.origin,
        cookie: hosted.cookie.reveal(),
        bearer: bearer.reveal(),
      }),
    );
    yield* repo.advance(record, {
      ...record,
      phase: "control",
      sealedExchange: null,
      sealedControl,
    });
  });
  const stage = Effect.fn("BoatExecution.stage")(function* (
    id: string,
    payload: Parameters<BoatExecutionService["stage"]>[1],
  ) {
    let record = yield* load(id);
    if (record.phase === "exchange" || record.phase === "aborted")
      return yield* Effect.fail(new BoatExecutionError("invalid-input"));
    if (record.phase === "control") {
      const wire = yield* attempt("invalid-input", () => {
        const value = Redacted.value(payload);
        const files = value.files.map((file) => ({
          name: file.name,
          data: Buffer.from(file.bytes).toString("base64"),
          size: file.bytes.byteLength,
          sha256: sha256(file.bytes),
        }));
        if (
          new Set(files.map((file) => file.name)).size !== files.length ||
          files.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024
        )
          throw new Error();
        const pins = boatAdmissionPinsSchema.parse(value.pins);
        if (
          pins.dotfiles.some(
            (pin) => !files.some((file) => file.name === pin.name && file.sha256 === pin.sha256),
          ) ||
          new Set(pins.credentialVersions.map((pin) => pin.id)).size !==
            pins.credentialVersions.length ||
          new Set(pins.dotfiles.map((pin) => pin.name)).size !== pins.dotfiles.length
        )
          throw new Error();
        return envelopeSchema.parse({
          wire: {
            format: "sealant-admission-stage-v1",
            identity: identity(record.target),
            boot_id: record.target.bootId,
            epoch: 1,
            operation_id:
              record.target.runtimeInstanceId === record.target.runId
                ? randomUUID()
                : record.target.launchAttemptId,
            files,
          },
          pins,
        });
      });
      const sealedEnvelope = yield* seal(record, "admission", Redacted.make(wire));
      record = yield* repo.advance(record, {
        ...record,
        phase: "prepared",
        admission: {
          epoch: wire.wire.epoch,
          operationId: wire.wire.operation_id,
          digest: sha256(canonical(wire)),
          sealedEnvelope,
          sealedResumeEnvelope: sealedEnvelope,
        },
      });
    }
    if (record.phase !== "prepared") return;
    if (record.admission?.sealedEnvelope === null || record.admission === null)
      return yield* Effect.fail(new BoatExecutionError("invalid-input"));
    const envelope = yield* open(
      record,
      "admission",
      record.admission.sealedEnvelope,
      envelopeSchema,
    );
    const wire = Redacted.value(envelope);
    if (sha256(canonical(wire)) !== record.admission.digest)
      return yield* Effect.fail(new BoatExecutionError("seal-context-mismatch"));
    const connection = yield* access(record);
    const result = yield* checkStatus(
      record,
      yield* io(() =>
        transport.call(
          connection.hosted,
          connection.bearer,
          "stage",
          Redacted.make(JSON.stringify(wire.wire)),
        ),
      ),
      true,
    );
    if (result.stage !== "installed")
      return yield* Effect.fail(new BoatExecutionError("invalid-reply"));
    yield* repo.advance(record, { ...record, phase: "installed" });
  });
  const start = Effect.fn("BoatExecution.start")(function* (id: string) {
    let record = yield* load(id);
    if (record.phase === "held")
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    if (record.phase !== "installed" && record.phase !== "issued" && record.phase !== "running")
      return yield* Effect.fail(new BoatExecutionError("invalid-input"));
    if (record.isolation === undefined)
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    if (record.phase === "installed")
      record = yield* repo.advance(record, { ...record, phase: "issued" });
    const connection = yield* access(record);
    const result: Status = yield* checkStatus(
      record,
      yield* io(() =>
        transport.call(
          connection.hosted,
          connection.bearer,
          "start",
          Redacted.make(
            JSON.stringify({
              format: "sealant-invocation-start-v1",
              identity: identity(record.target),
              boot_id: record.target.bootId,
              epoch: record.admission?.epoch,
              operation_id: record.admission?.operationId,
            }),
          ),
        ),
      ),
      true,
    );
    if (result.execution === "issued")
      return yield* Effect.fail(new BoatExecutionError("transport-unavailable"));
    if (
      (record.phase === "issued" ||
        (record.phase === "running" && result.execution !== "running")) &&
      record.admission !== null
    )
      yield* repo.advance(record, {
        ...record,
        phase: result.execution === "running" ? "running" : "held",
        admission: { ...record.admission, sealedEnvelope: null },
      });
    if (result.execution !== "running")
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    return "running" as const;
  });
  const isolate = Effect.fn("BoatExecution.isolate")(function* (
    target: BoatExecutionTarget,
    input: BoatGuestNetworkInput,
  ) {
    const record = yield* load(target.runtimeInstanceId);
    if (!isDeepStrictEqual(record.target, target))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    if (!["installed", "issued", "running"].includes(record.phase) || record.admission === null)
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    const network = yield* attempt("invalid-input", () =>
      boatNetworkIntentSchema.parse(input.network),
    );
    if (
      network.epoch !== record.admission.epoch ||
      network.operationId !== record.admission.operationId
    )
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    const binding = {
      identity: identity(target),
      boot_id: target.bootId,
      epoch: network.epoch,
      operation_id: network.operationId,
    };
    const body = yield* attempt("invalid-input", () =>
      Redacted.make(
        JSON.stringify({
          format: "sealant-guest-network-v1",
          binding,
          private_key: boatWireGuardKeySchema.parse(Redacted.value(input.privateKey)),
          public_key: boatWireGuardKeySchema.parse(input.publicKey),
          gateway_key: boatWireGuardKeySchema.parse(input.gatewayKey),
          endpoint: network.endpoint,
          port: z.number().int().min(40000).max(40015).parse(input.port),
          subnet: network.subnet,
        }),
      ),
    );
    const connection = yield* access(record);
    const current = yield* checkStatus(
      record,
      yield* io(() => transport.call(connection.hosted, connection.bearer, "status")),
      true,
    );
    if (
      current.stage !== "installed" ||
      current.execution === "ended" ||
      current.execution === "unresolved"
    )
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    const result = yield* io(() =>
      transport.call(connection.hosted, connection.bearer, "isolate", body),
    );
    const receipt = yield* attempt("invalid-reply", () => {
      const parsed = z
        .strictObject({
          format: z.literal("sealant-guest-network-status-v1"),
          binding: z.unknown(),
          receipt: z.string().regex(/^[a-f0-9]{64}$/),
          configured: z.literal(true),
          handshake: z.literal("unverified"),
          admission: z.literal("held"),
        })
        .parse(result);
      if (!isDeepStrictEqual(parsed.binding, binding)) throw new Error();
      return { receipt: parsed.receipt, handshake: parsed.handshake, admission: parsed.admission };
    });
    if (!isDeepStrictEqual(yield* load(target.runtimeInstanceId), record))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    return receipt;
  });
  const permitWire = (record: BoatExecutionRecord) => ({
    format: "sealant-execution-permit-v2",
    binding: {
      identity: identity(record.target),
      boot_id: record.target.bootId,
      epoch: record.admission?.epoch,
      operation_id: record.admission?.operationId,
    },
    resource_receipt: record.isolation?.resourceReceipt,
    tunnel_receipt: record.isolation?.tunnelReceipt,
    limits: { memory_bytes: 2147483648, cpu_millicores: 1000, tasks: 512 },
  });
  const permit = Effect.fn("BoatExecution.permit")(function* (
    target: BoatExecutionTarget,
    receipts: NonNullable<BoatExecutionRecord["isolation"]>,
  ) {
    let record = yield* load(target.runtimeInstanceId);
    if (!isDeepStrictEqual(record.target, target))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    record = yield* repo.isolate(record, receipts);
    const wire = permitWire(record);
    const connection = yield* access(record);
    const result = yield* io(() =>
      transport.call(
        connection.hosted,
        connection.bearer,
        "permit",
        Redacted.make(JSON.stringify(wire)),
      ),
    );
    yield* attempt("invalid-reply", () => {
      const parsed = z
        .strictObject({
          format: z.literal("sealant-execution-permitted-v1"),
          binding: z.unknown(),
          receipt: z.string(),
          handshake: z.literal("verified"),
          dns: z.literal("udp-and-tcp"),
          admission: z.literal("held"),
        })
        .parse(result);
      if (
        !isDeepStrictEqual(parsed.binding, wire.binding) ||
        parsed.receipt !== sha256(canonical(wire))
      )
        throw new Error();
    });
    if (!isDeepStrictEqual(yield* load(target.runtimeInstanceId), record))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
  });
  const readiness = Effect.fn("BoatExecution.readiness")(function* (target: BoatExecutionTarget) {
    const record = yield* load(target.runtimeInstanceId);
    if (!isDeepStrictEqual(record.target, target))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    if (record.phase !== "running" || record.isolation === undefined)
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    const wire = permitWire(record);
    const receipt = sha256(canonical(wire));
    const connection = yield* access(record);
    const observe = () =>
      io(() =>
        transport.call(
          connection.hosted,
          connection.bearer,
          "readiness",
          Redacted.make(
            JSON.stringify({
              format: "sealant-readiness-v1",
              binding: wire.binding,
              permit_receipt: receipt,
            }),
          ),
        ),
      ).pipe(
        Effect.flatMap((result) =>
          attempt("invalid-reply", () => {
            const parsed = z
              .strictObject({
                format: z.literal("sealant-readiness-status-v1"),
                binding: z.unknown(),
                permit_receipt: z.literal(receipt),
                invocation: z.string().regex(/^[a-f0-9]{32}$/),
                handshake: z.literal("verified"),
                dns: z.literal("udp-and-tcp"),
                limits: z.unknown(),
                admission: z.literal("held"),
              })
              .parse(result);
            if (
              !isDeepStrictEqual(parsed.binding, wire.binding) ||
              !isDeepStrictEqual(parsed.limits, wire.limits)
            )
              throw new Error();
            return parsed;
          }),
        ),
      );
    const before = yield* observe();
    const daemon = yield* io(
      () => transport.probe(connection.hosted, connection.bearer),
      "readiness",
    );
    if (
      !daemon.healthy ||
      !/^rt_[a-zA-Z0-9_-]+$/.test(daemon.runtimeId) ||
      !["exec.user", "dotfiles.user", "restore.owner_map", "process.secret-env.v1"].every(
        (capability) => daemon.supports.includes(capability),
      )
    )
      return yield* Effect.fail(new BoatExecutionError("invalid-reply"));
    const after = yield* observe();
    if (
      !isDeepStrictEqual(before, after) ||
      !isDeepStrictEqual(yield* load(target.runtimeInstanceId), record)
    )
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    return {
      invocation: after.invocation,
      runtimeId: daemon.runtimeId,
      permitReceipt: receipt,
      handshake: after.handshake,
      admission: after.admission,
    };
  });

  const control = Effect.fn("BoatExecution.control")(function* (target: BoatExecutionTarget) {
    const record = yield* load(target.runtimeInstanceId);
    if (!isDeepStrictEqual(record.target, target))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    if (record.phase !== "running" && record.phase !== "held")
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    const connection = yield* access(record);
    return Redacted.make<SealantTarget>({
      kind: "websocket",
      ...boatControlConnection(connection.hosted, connection.bearer),
      auth: { bearerToken: connection.bearer.reveal() },
    });
  });
  const hold = Effect.fn("BoatExecution.hold")(function* (target: BoatExecutionTarget) {
    const record = yield* load(target.runtimeInstanceId);
    if (!isDeepStrictEqual(record.target, target))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    if (record.phase === "held") return;
    // An issued start whose reply never came is fenced too: Core never sends start again, and the
    // guest only ever observes an invocation it already recorded (audit S5).
    if ((record.phase !== "running" && record.phase !== "issued") || record.admission === null)
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    yield* repo.advance(record, {
      ...record,
      phase: "held",
      admission: { ...record.admission, sealedEnvelope: null },
    });
  });
  const recover = Effect.fn("BoatExecution.recover")(function* (target: BoatExecutionTarget) {
    const record = yield* load(target.runtimeInstanceId);
    if (!isDeepStrictEqual(record.target, target))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    if (record.phase !== "held" || record.admission === null || record.isolation === undefined)
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    const binding = {
      identity: identity(target),
      boot_id: target.bootId,
      epoch: record.admission.epoch,
      operation_id: record.admission.operationId,
    };
    const connection = yield* access(record);
    const result = yield* io(() =>
      transport.call(
        connection.hosted,
        connection.bearer,
        "recover",
        Redacted.make(
          JSON.stringify({
            format: "sealant-capture-recovery-v1",
            binding,
          }),
        ),
      ),
    );
    const reply = yield* attempt("invalid-reply", () => {
      const parsed = z
        .strictObject({
          format: z.literal("sealant-capture-recovery-status-v1"),
          binding: z.unknown(),
          execution: z.enum(["unavailable", "issued", "running", "ended", "unresolved"]),
          mode: z.enum(["original", "recovery"]),
        })
        .parse(result);
      if (
        !isDeepStrictEqual(parsed.binding, binding) ||
        (parsed.mode === "original" && parsed.execution !== "running")
      )
        throw new Error();
      return parsed;
    });
    if (!isDeepStrictEqual(yield* load(target.runtimeInstanceId), record))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    return reply.execution === "running"
      ? "running"
      : reply.execution === "issued"
        ? "pending"
        : "held";
  });
  const park = Effect.fn("BoatExecution.park")(function* (
    target: BoatExecutionTarget,
    operationId: string,
  ) {
    const record = yield* load(target.runtimeInstanceId);
    if (!isDeepStrictEqual(record.target, target))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    if (record.phase !== "held" || record.admission === null || record.isolation === undefined)
      return yield* Effect.fail(new BoatExecutionError("invocation-held"));
    const request = yield* attempt("invalid-input", () => ({
      format: "sealant-parking-close-v1",
      binding: {
        identity: identity(target),
        boot_id: target.bootId,
        epoch: record.admission?.epoch,
        operation_id: record.admission?.operationId,
      },
      operation_id: z.uuid().parse(operationId),
    }));
    const connection = yield* access(record);
    const result = yield* io(() =>
      transport.call(
        connection.hosted,
        connection.bearer,
        "park",
        Redacted.make(JSON.stringify(request)),
      ),
    );
    const receipt = yield* attempt("invalid-reply", () => {
      const parsed = z
        .strictObject({
          format: z.literal("sealant-parking-status-v1"),
          request: z.unknown(),
          phase: z.literal("closed"),
          writers: z.literal("closed"),
          capsule: z.strictObject({
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            archive_sha256: z.string().regex(/^[a-f0-9]{64}$/),
            bytes: z
              .number()
              .int()
              .nonnegative()
              .max(16 * 1024 ** 3),
            stored_bytes: z
              .number()
              .int()
              .positive()
              .max(16 * 1024 ** 3 + 64 * 1024 ** 2),
            entries: z.number().int().nonnegative().max(200_000),
          }),
        })
        .parse(result);
      if (!isDeepStrictEqual(parsed.request, request)) throw new Error();
      return {
        operationId,
        capsuleHash: parsed.capsule.sha256,
        archiveHash: parsed.capsule.archive_sha256,
        contentBytes: parsed.capsule.bytes,
        storedBytes: parsed.capsule.stored_bytes,
        entries: parsed.capsule.entries,
      };
    });
    if (!isDeepStrictEqual(yield* load(target.runtimeInstanceId), record))
      return yield* Effect.fail(new BoatExecutionError("target-mismatch"));
    return receipt;
  });
  return BoatExecution.of({
    parkingMaterial: (target) =>
      Effect.gen(function* () {
        const record = yield* load(target.runtimeInstanceId);
        if (
          !isDeepStrictEqual(record.target, target) ||
          record.admission?.sealedResumeEnvelope == null
        )
          return yield* Effect.fail(new BoatExecutionError("invocation-held"));
        const envelope = yield* open(
          record,
          "admission",
          record.admission.sealedResumeEnvelope,
          envelopeSchema,
        );
        const value = Redacted.value(envelope);
        if (sha256(canonical(value)) !== record.admission.digest)
          return yield* Effect.fail(new BoatExecutionError("seal-context-mismatch"));
        return Redacted.make({
          pins: value.pins,
          files: value.wire.files.map((file) => ({
            name: file.name,
            bytes: Buffer.from(file.data, "base64"),
          })),
        });
      }),
    exchange,
    stage,
    start,
    isolate,
    permit,
    readiness,
    control,
    hold,
    recover,
    park,
  });
});
/** Open assembly for worker infrastructure and faithful test transports. */
export const boatExecutionLayerNoDeps: Layer.Layer<
  BoatExecution,
  never,
  BoatExecutionRepo | CredentialCipher | BoatGuestTransportService
> = Layer.effect(BoatExecution, make);
/** Owns its PostgreSQL repository; the worker supplies cipher and authenticated guest transport. */
export const boatExecutionLayer: Layer.Layer<
  BoatExecution,
  never,
  SealantDB | CredentialCipher | BoatGuestTransportService
> = boatExecutionLayerNoDeps.pipe(Layer.provide(BoatExecutionRepoLive));
