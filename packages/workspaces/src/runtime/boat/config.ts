import { inspect } from "node:util";

import { nativeBuildOwnershipSchema, type NativeBuildOwnership } from "@sealant/validators";
import { z } from "zod";

const causeClassSchema = z.enum([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ABORT_ERR",
  "AbortError",
  "TimeoutError",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "Error",
  "unknown",
]);
const providerCauseClass = (error: unknown): z.infer<typeof causeClassSchema> => {
  let current = error;
  let name: z.infer<typeof causeClassSchema> = "unknown";
  for (let depth = 0; depth < 8 && current !== undefined; depth++) {
    const parsed = z
      .object({
        code: z.unknown().optional(),
        name: z.unknown().optional(),
        cause: z.unknown().optional(),
      })
      .safeParse(current);
    if (!parsed.success) break;
    const code = causeClassSchema.safeParse(parsed.data.code);
    if (code.success) return code.data;
    const classified = causeClassSchema.safeParse(parsed.data.name);
    if (classified.success) name = classified.data;
    current = parsed.data.cause;
  }
  return name;
};

/** Only approved operation/status/class fields may leave the HTTP boundary, never exception text. */
export const boatProviderFailureSchema = z.object({
  operation: z
    .enum([
      "create",
      "discover",
      "get",
      "execute",
      "commandStatus",
      "stopCommand",
      "writeFile",
      "uploadUrl",
      "uploadFile",
      "host",
      "stop",
      "resume",
      "deleteSandbox",
      "getDeletion",
      "saveSnapshot",
      "getSnapshot",
      "deleteSnapshot",
      "verifyRecoveryFile",
      "personalSnapshots",
      "savePersonalSnapshot",
      "unknown",
    ])
    .catch("unknown"),
  status: z.number().int().min(100).max(599).nullable(),
  causeClass: causeClassSchema.nullable(),
});
export type BoatProviderFailure = z.infer<typeof boatProviderFailureSchema>;

export class BoatApiError extends Error {
  readonly _tag = "BoatApiError";
  readonly causeClass;

  constructor(
    readonly operation: string,
    readonly status: number | null,
    readonly code: string,
    cause?: unknown,
  ) {
    const classified = cause === undefined ? null : providerCauseClass(cause);
    super(
      `Boat request failed during ${operation}: ${code}${status === null ? "" : ` (HTTP ${status})`}${classified === null ? "" : `; cause ${classified}`}`,
    );
    this.causeClass = classified;
  }
}

export type BoatResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BoatApiError };

export class BoatSecret {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static parse(value: unknown): BoatResult<BoatSecret> {
    if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{16,4096}$/.test(value)) {
      return { ok: false, error: new BoatApiError("credential", null, "invalid_credential") };
    }
    return { ok: true, value: new BoatSecret(value) };
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }

  [inspect.custom](): string {
    return "[REDACTED]";
  }
}

export const boatSandboxIdSchema = z
  .string()
  .regex(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/)
  .brand<"BoatSandboxId">();
export type BoatSandboxId = z.infer<typeof boatSandboxIdSchema>;
export const boatDeletionIdSchema = z
  .string()
  .regex(/^bdop_[a-f0-9]{32}$/)
  .brand<"BoatDeletionId">();
export type BoatDeletionId = z.infer<typeof boatDeletionIdSchema>;
/** Snapshot names are provider handles, independent of source sandbox lifetime. */
export const boatSnapshotNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
  .brand<"BoatSnapshotName">();
export type BoatSnapshotName = z.infer<typeof boatSnapshotNameSchema>;

const ownershipValueSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}]+$/u)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 256);
const ownershipSchema = z.object({
  deploymentId: ownershipValueSchema.brand<"BoatDeploymentId">(),
  workspaceId: ownershipValueSchema.brand<"BoatWorkspaceId">(),
  runId: ownershipValueSchema.brand<"BoatRunId">(),
  runtimeInstanceId: ownershipValueSchema.brand<"BoatRuntimeInstanceId">(),
  launchAttemptId: ownershipValueSchema.brand<"BoatLaunchAttemptId">(),
  sourceId: ownershipValueSchema.brand<"BoatSourceId">(),
});

/** Exact allocation identity. Parsing enforces Boat's 256-byte label value limit. */
export class BoatOwnership {
  /** Deployment that owns the allocation, independent of a reconciler claim. */
  readonly deploymentId;
  /** Workspace whose disk this allocation holds. */
  readonly workspaceId;
  /** Durable execution record, unchanged by provider retries. */
  readonly runId;
  /** Runtime instance reserved by the durable executor owner. */
  readonly runtimeInstanceId;
  /** Launch attempt reserved before issuing create. */
  readonly launchAttemptId;
  /** Exact source artifact identity recorded by the executor owner. */
  readonly sourceId;

  private constructor(identity: z.infer<typeof ownershipSchema>) {
    this.deploymentId = identity.deploymentId;
    this.workspaceId = identity.workspaceId;
    this.runId = identity.runId;
    this.runtimeInstanceId = identity.runtimeInstanceId;
    this.launchAttemptId = identity.launchAttemptId;
    this.sourceId = identity.sourceId;
    Object.freeze(this);
  }

  /** Invalid identities fail before any provider request. */
  static parse(input: unknown): BoatResult<BoatOwnership> {
    const parsed = ownershipSchema.safeParse(input);
    return parsed.success
      ? { ok: true, value: new BoatOwnership(parsed.data) }
      : { ok: false, error: new BoatApiError("ownership", null, "invalid_ownership") };
  }
}

/** Immutable scratch ownership, without invented run or runtime-instance identities. */
export class BoatBuildOwnership {
  private constructor(
    readonly owner: string,
    readonly reservation: NativeBuildOwnership,
  ) {}

  /** Parse durable ownership before creating or discovering scratch allocations. */
  static parse(input: unknown): BoatResult<BoatBuildOwnership> {
    const parsed = z
      .object({ owner: z.uuid(), reservation: nativeBuildOwnershipSchema })
      .safeParse(input);
    return parsed.success
      ? { ok: true, value: new BoatBuildOwnership(parsed.data.owner, parsed.data.reservation) }
      : { ok: false, error: new BoatApiError("ownership", null, "invalid_build_ownership") };
  }
}

const lifetimeSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("production-session") }).strict(),
    z
      .object({
        kind: z.literal("bounded"),
        ttlSeconds: z.number().int().min(60).max(1800).optional(),
      })
      .strict(),
  ])
  .readonly();

/** Production never inherits the bounded caller's default of 900 seconds. */
export type BoatLifetime = z.infer<typeof lifetimeSchema>;

/** Bounded TTL limits are local build/proof policy, not Boat API limits. */
export function parseBoatLifetime(input: unknown): BoatResult<number | null> {
  const parsed = lifetimeSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: new BoatApiError("lifetime", null, "invalid_lifetime") };
  return {
    ok: true,
    value:
      parsed.data.kind === "production-session"
        ? null
        : parsed.data.ttlSeconds === undefined
          ? 900
          : parsed.data.ttlSeconds,
  };
}

export const parseBoatUrl = (input: string): BoatResult<URL> => {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.on\.boat\.dev$/.test(url.hostname) ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      return { ok: false, error: new BoatApiError("url", null, "invalid_provider_url") };
    }
    return { ok: true, value: url };
  } catch {
    return { ok: false, error: new BoatApiError("url", null, "invalid_provider_url") };
  }
};
