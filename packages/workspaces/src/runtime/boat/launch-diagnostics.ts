import { z } from "zod";

import { safeCommandTail } from "../../images/boat/command-diagnostics.js";
import { BoatApiError, boatProviderFailureSchema } from "./config.js";

/** What a diagnostic keeps of a guest service's output: its last lines, at most this many bytes. */
const GUEST_OUTPUT_LINES = 20;
const GUEST_OUTPUT_BYTES = 2048;
// Values shorter than this are not redacted: replacing every "1" or "on" would destroy the text,
// and a value that short is not a credential (the agent uses the same bound).
const MIN_REDACTED_LENGTH = 8;
const URL_PATTERN = /\b(https?|wss?|ssh|git):\/\/(?:[^\s/?#<>"'@]*@)?([^\s/?#<>"']+)[^\s<>"']*/gi;

/**
 * A guest service's output as a diagnostic may carry it. A URL keeps only its scheme and host (which
 * endpoint a boot could not reach is the point of the tail; a path or query can hold a presigned
 * signature, userinfo a password), then the command-tail redactions apply: private keys, `Bearer`
 * and `Basic` values, and `token=`-shaped assignments. The last {@link GUEST_OUTPUT_LINES} lines are
 * kept, and at most {@link GUEST_OUTPUT_BYTES} bytes of them.
 */
const safeGuestOutput = (raw: string): string => {
  const text = safeCommandTail(
    // JSON serializers may escape `/` as `\/`; unescape first so such a URL loses its query too.
    raw
      .replaceAll("\\/", "/")
      .replace(URL_PATTERN, (_url, scheme: string, host: string) => `[url ${scheme} ${host}]`),
  )
    .trim()
    .split("\n")
    .slice(-GUEST_OUTPUT_LINES)
    .join("\n");
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - GUEST_OUTPUT_BYTES);
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
};

/**
 * The output to put in a diagnostic, with every value in `secrets` removed first: what the launch
 * delivered (the agent removes the same values, but an older agent may not have). The diagnostic's
 * own schema then bounds it and removes what is shaped like a secret.
 */
export const boatGuestOutput = (raw: string, secrets: readonly string[]): string => {
  let text = raw;
  // A daemon may print a value as it is, JSON-escaped (with or without `\/`), or base64-encoded.
  const forms = [...new Set(secrets)]
    .filter((value) => value.length >= MIN_REDACTED_LENGTH)
    .flatMap((value) => {
      const escaped = JSON.stringify(value).slice(1, -1);
      return [
        value,
        escaped,
        escaped.replaceAll("/", "\\/"),
        Buffer.from(value).toString("base64").replace(/=+$/, ""),
      ];
    });
  for (const form of [...new Set(forms)].toSorted((a, b) => b.length - a.length)) {
    text = text.split(form).join("[REDACTED]");
  }
  return text;
};

/** Fixed names only. Exception messages, request bodies and bootstrap replies can contain secrets. */
const diagnosticSchema = z.object({
  step: z.enum([
    "prepare-launch",
    "prepare-allocation",
    "read-source",
    "create",
    "discover",
    "observe-sandbox",
    "read-boot-id",
    "bind-exchange",
    "host-agent",
    "agent-request",
    "readiness",
    "control",
    "report-started",
    "report-ready",
    "credentials",
  ]),
  errorClass: z.enum([
    "BoatApiError",
    "BoatAllocationError",
    "BoatAllocationStoreError",
    "BoatExecutionError",
    "BoatExecutionStoreError",
    "BoatReadinessError",
    "BoatResourcesError",
    "BoatTunnelError",
    "BoatTunnelCredentialsError",
    "BoatTunnelStoreError",
    "ResourceInstanceRepoError",
    "BoatAdapterError",
    "TransportError",
    "SealantControlError",
    "SealantUnexpectedError",
    "ZodError",
    "Error",
    "TypeError",
    "SyntaxError",
    "TimeoutError",
    "unknown",
  ]),
  code: z
    .enum([
      "invalid-input",
      "provider-unavailable",
      "allocation-pending",
      "allocation-held",
      "source-mismatch",
      "target-mismatch",
      "transport-unavailable",
      "invalid-reply",
      "seal-context-mismatch",
      "invocation-held",
      "agent-rejected",
      "agent-unauthorized",
      "agent-route-missing",
      "agent-refused",
      "agent-not-ready",
      "guest-failed",
      "carrier-unavailable",
      "admission-refused",
      "launch-held",
      "close-pending",
      "held",
      "unavailable",
      "binding-conflict",
      "stale-transition",
      "run-stopped",
      "pin-unavailable",
      "invalid-record",
      "gateway-unavailable",
      "ownership-conflict",
      "sandbox-absent",
    ])
    .optional(),
  sandboxState: z
    .enum([
      "init",
      "provisioning",
      "provisioned",
      "cloning",
      "ready",
      "idle",
      "running",
      "archiving",
      "archived",
      "error",
      "cancelled",
    ])
    .optional(),
  hydrated: z.boolean().optional(),
  resourceOperation: z
    .enum([
      "check-authority",
      "prepare-credentials",
      "allocate-subnet",
      "persist-network",
      "read-resources",
      "configure-gateway",
      "settle-gateway",
      "isolate-guest",
    ])
    .optional(),
  provider: boatProviderFailureSchema.optional(),
  /** The guest agent's answer: which route, its status and its classified reason. Never free text. */
  agent: z
    .object({
      pathClass: z.enum([
        "/sealant/launch",
        "/sealant/health",
        "/sealant/network",
        "/sealant/recover",
      ]),
      responseTail: z.string().transform(safeCommandTail),
      /** The agent's reason code (`recover-new-boot`, a bind refusal). */
      reason: z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,63}$/)
        .optional(),
      detail: z
        .string()
        .regex(/^[A-Za-z0-9_./,=+-]{1,256}$/)
        .optional(),
    })
    .optional(),
  /**
   * The readiness check that did not pass (`readiness`: an `agent-not-ready` that is retried, or
   * a `guest-failed` that is not), in the order the checks run. Never free text.
   */
  check: z.enum(["booted", "control-socket", "docker", "network", "handshake", "dns"]).optional(),
  /**
   * The tunnel's byte counters when its handshake was not verified (`check: handshake`): sent with
   * nothing received is a gateway the carrier's datagrams do not reach, or that never answers.
   */
  tunnel: z
    .object({
      sentBytes: z.number().int().nonnegative().optional(),
      receivedBytes: z.number().int().nonnegative().optional(),
      /** Whether Core's end of the carrier was attached. Not attached, nothing could flow. */
      carrierAttached: z.boolean().optional(),
    })
    .optional(),
  /** What the agent's health said went wrong inside the VM: the daemon or its Docker service. */
  guest: z
    .object({
      service: z.enum(["sealantd", "docker"]),
      exitCode: z.number().int().nullable().optional(),
      reason: z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,63}$/)
        .optional(),
      /**
       * The end of what sealantd printed before it exited, as the agent's health reports it: a boot
       * that fails before the control socket has nowhere else to say why. Bounded and redacted
       * ({@link safeGuestOutput}); absent when it printed nothing.
       */
      outputTail: z.string().transform(safeGuestOutput).optional(),
    })
    .optional(),
  /** The authenticated control stream to sealantd: where it failed and who refused it, and why. */
  control: z
    .object({
      /** The runtime client operation that failed (`open`, `health`, ...), or `probe` on its deadline. */
      operation: z.string().regex(/^[a-zA-Z]{1,32}$/),
      /** HTTP status of a refused upgrade: the agent answers a daemon socket it cannot reach as 503. */
      status: z.number().int().optional(),
      /** The agent's classified reason, e.g. `control-unavailable`. Never free text. */
      reason: z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,63}$/)
        .optional(),
      /** The daemon's own error code, when it answered with one. */
      daemonCode: z.number().int().optional(),
    })
    .optional(),
  command: z
    .object({
      exitCode: z.number().int().nullable(),
      timedOut: z.boolean(),
      stdoutTail: z.string().transform(safeCommandTail).optional(),
      stderrTail: z.string().transform(safeCommandTail).optional(),
    })
    .optional(),
});
export type BoatLaunchDiagnostic = z.infer<typeof diagnosticSchema>;

/** Preserve deeper safe context through service wrappers, never an arbitrary exception or cause text. */
export const boatLaunchDiagnostic = (
  error: unknown,
  step: BoatLaunchDiagnostic["step"],
): BoatLaunchDiagnostic => {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    const fields = z
      .object({ diagnostic: z.unknown().optional(), cause: z.unknown().optional() })
      .safeParse(current);
    if (!fields.success) break;
    const known = diagnosticSchema.safeParse(fields.data.diagnostic);
    if (known.success) return known.data;
    if (fields.data.cause === undefined) break;
    current = fields.data.cause;
  }
  const named = z
    .object({
      _tag: z.string().optional(),
      name: z.string().optional(),
      code: z.unknown().optional(),
    })
    .safeParse(current);
  const { _tag: tag, name } = named.success ? named.data : {};
  const classified = diagnosticSchema.shape.errorClass.safeParse(tag ?? name);
  const errorClass = classified.success ? classified.data : "unknown";
  // A daemon that answered with its own error: which operation it refused and its code, so the
  // launch says more than a class name. The daemon's message is free text and stays out.
  const refusal = z
    .object({
      _tag: z.literal("SealantControlError"),
      operation: z.string(),
      code: z.number().int(),
    })
    .safeParse(current);
  const control = refusal.success
    ? diagnosticSchema.shape.control.safeParse({
        operation: refusal.data.operation,
        daemonCode: refusal.data.code,
      })
    : undefined;
  return diagnosticSchema.parse({
    step,
    errorClass,
    ...(control?.success === true && control.data !== undefined ? { control: control.data } : {}),
    ...(named.success && diagnosticSchema.shape.code.safeParse(named.data.code).success
      ? { code: named.data.code }
      : {}),
    ...(current instanceof BoatApiError
      ? { provider: boatProviderFailureSchema.parse(current) }
      : {}),
  });
};

/** This serialized allowlist survives the worker's errorMessage projection into the runtime row. */
export const boatLaunchSummary = (diagnostic: BoatLaunchDiagnostic | undefined): string =>
  diagnostic === undefined
    ? ""
    : `; diagnostic ${JSON.stringify(diagnosticSchema.parse(diagnostic))}`;
