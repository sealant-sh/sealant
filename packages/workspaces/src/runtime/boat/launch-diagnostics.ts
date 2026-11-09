import { z } from "zod";

import { safeCommandTail } from "../../images/boat/command-diagnostics.js";
import { BoatApiError, boatProviderFailureSchema } from "./config.js";

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
    "host-receiver",
    "receiver-request",
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
      "receiver-rejected",
      "receiver-unauthorized",
      "receiver-route-missing",
      "receiver-refused",
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
  receiver: z
    .object({
      pathClass: z.enum([
        "/sealant/bootstrap/status",
        "/sealant/bootstrap/stage",
        "/sealant/bootstrap/start",
        "/sealant/bootstrap/isolate",
        "/sealant/bootstrap/permit",
        "/sealant/bootstrap/readiness",
        "/sealant/bootstrap/recover",
        "/sealant/bootstrap/park",
      ]),
      responseTail: z.string().transform(safeCommandTail),
      /** The receiver's classified reason, e.g. a policy refusal code. Never free text. */
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
  return diagnosticSchema.parse({
    step,
    errorClass,
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
