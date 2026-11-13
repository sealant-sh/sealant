/**
 * Boat's answer to a refused call, as Core keeps it: a kind from the closed set in
 * `@sealant/api-contracts` (`BOAT_FAILURE_KINDS`) and the few fields of Boat's own that a caller
 * may read: its code, its message (bounded and redacted), its request id, when to retry, its
 * billing link, and the permission the call needs. Nothing else of the body is kept, and no part
 * of the key.
 */
import {
  BOAT_FAILURE_KINDS,
  BOAT_RETRYABLE_FAILURE_KINDS,
  type BoatFailureKind,
} from "@sealant/api-contracts";
import { z } from "zod";

/** A Boat error code as Boat sends them: `api_key_expired`, `IP_RATE_LIMIT_EXCEEDED`. */
export const boatCodeSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const requestIdSchema = z.string().regex(/^req_[A-Za-z0-9_-]{1,128}$/);
/** A Boat permission (action) name: `sandbox.create`, `sandbox.delete-own`, `*`. */
export const boatPermissionSchema = z
  .string()
  .regex(/^(?:\*|[a-z][a-z-]{0,31}(?:\.[a-z-]{1,32})?)$/);
const MESSAGE_CHARS = 300;

/**
 * Boat's billing link, kept only when it is an HTTPS link on boat.dev. Userinfo and fragment are
 * dropped; the query is kept (a checkout link may need it) and the whole is bounded.
 */
export const safeBoatBillingUrl = (raw: unknown): string | undefined => {
  if (typeof raw !== "string" || raw.length > 1024) return undefined;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "boat.dev" || url.hostname.endsWith(".boat.dev")) ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    )
      return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
};

/**
 * Boat's message as a caller may read it: printable, at most {@link MESSAGE_CHARS} characters,
 * with the request's own key removed and anything shaped like a key, a bearer value or a
 * `secret=` assignment replaced. A link to anywhere but boat.dev keeps only its host.
 */
export const safeBoatMessage = (
  raw: unknown,
  secrets: readonly string[] = [],
): string | undefined => {
  if (typeof raw !== "string") return undefined;
  let text = raw.slice(0, 4096);
  for (const secret of secrets.filter((value) => value.length >= 8))
    text = text.split(secret).join("[REDACTED]");
  text = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\bboat_[A-Za-z0-9._~-]+/g, "[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"']+/gi, "[REDACTED_AUTH]")
    .replace(
      /(\b[\w.-]{0,64}(?:token|password|secret|credential|api[_-]?key|authorization)[\w.-]{0,64}\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, (link) => {
      const kept = safeBoatBillingUrl(link);
      if (kept !== undefined) {
        const url = new URL(kept);
        return `${url.origin}${url.pathname}`;
      }
      try {
        return `[link ${new URL(link).hostname}]`;
      } catch {
        return "[link]";
      }
    })
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return undefined;
  return text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS - 1)}…` : text;
};

const kindByCode: ReadonlyMap<string, BoatFailureKind> = new Map(
  Object.entries({
    unauthorized: "key-refused",
    api_key_revoked: "key-refused",
    api_key_invalid: "key-refused",
    invalid_api_key: "key-refused",
    api_key_expired: "key-expired",
    api_key_action_forbidden: "permission-missing",
    api_key_sandbox_forbidden: "sandbox-outside-key",
    api_key_org_mismatch: "organization-mismatch",
    api_key_org_forbidden: "organization-mismatch",
    org_suspended: "account-suspended",
    account_suspended: "account-suspended",
    account_closed: "account-suspended",
    billing_required: "billing-required",
    insufficient_balance: "billing-required",
    limit_reached: "running-limit",
    member_limit_reached: "member-cap",
    team_member_cap_reached: "member-cap",
    rate_limited: "rate-limited",
    IP_RATE_LIMIT_EXCEEDED: "rate-limited",
    trial_compute_limit_reached: "trial-restricted",
    trial_machine_class_not_allowed: "trial-restricted",
    trial_auto_stop_required: "trial-restricted",
    trial_saved_snapshots_not_allowed: "trial-restricted",
    machine_class_plan_required: "trial-restricted",
    no_ready_machine: "no-machine",
    out_of_capacity: "no-machine",
  } satisfies Record<string, BoatFailureKind>),
);

/** The zod mirror of the contract's `boatFailureSchema`; it bounds every field again on parse. */
export const boatFailureSchema = z.object({
  kind: z.enum(BOAT_FAILURE_KINDS),
  retryable: z.boolean(),
  operation: z
    .string()
    .regex(/^[A-Za-z-]{1,32}$/)
    .optional(),
  code: boatCodeSchema.optional(),
  message: z
    .string()
    .transform((value) => safeBoatMessage(value) ?? "")
    .optional(),
  requestId: requestIdSchema.optional(),
  status: z.number().int().min(100).max(599).optional(),
  permission: boatPermissionSchema.optional(),
  retryAfterSeconds: z.number().int().min(0).max(31_536_000).optional(),
  retryAt: z.iso.datetime({ offset: true }).optional(),
  billingUrl: z
    .string()
    .refine((value) => safeBoatBillingUrl(value) === value)
    .optional(),
});
export type BoatFailure = z.infer<typeof boatFailureSchema>;

const fieldsSchema = z
  .object({
    code: z.unknown(),
    message: z.unknown(),
    requestId: z.unknown(),
    retryAfterSeconds: z.unknown(),
    retryAfter: z.unknown(),
    nextStartAt: z.unknown(),
    billingUrl: z.unknown(),
    action: z.unknown(),
    requiredAction: z.unknown(),
    missingAction: z.unknown(),
    permission: z.unknown(),
  })
  .partial();
const envelopeSchema = fieldsSchema.extend({
  error: fieldsSchema.extend({ details: fieldsSchema.optional() }).optional(),
  details: fieldsSchema.optional(),
});

const seconds = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const parsed =
      typeof value === "string" && /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : value;
    if (
      typeof parsed === "number" &&
      Number.isInteger(parsed) &&
      parsed >= 0 &&
      parsed <= 31_536_000
    )
      return parsed;
  }
  return undefined;
};
const first = <T>(schema: z.ZodType<T>, ...values: unknown[]): T | undefined => {
  for (const value of values) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
};

/** The failure for a call Boat did not answer, or answered with nothing Core can read. */
export const boatNoAnswer = (operation: string, status: number | null): BoatFailure => ({
  kind: "no-answer",
  retryable: true,
  ...(/^[A-Za-z-]{1,32}$/.test(operation) ? { operation } : {}),
  ...(status === null ? {} : { status }),
});

/**
 * Classifies Boat's error answer. `permission`: the permission Core's call needs, named when
 * Boat's own answer names none. `secrets`: values removed from Boat's message (the request's key).
 */
export const classifyBoatRefusal = (input: {
  readonly operation: string;
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterHeader?: string | null;
  readonly permission?: string;
  readonly secrets?: readonly string[];
}): BoatFailure => {
  const parsed = envelopeSchema.safeParse(input.body);
  const body = parsed.success ? parsed.data : {};
  const error = body.error ?? {};
  const details = { ...body.details, ...error.details };
  const code = first(boatCodeSchema, body.code, error.code);
  // A code is an identifier Boat chose; anything shaped like key material is not kept as one.
  const keptCode =
    code === undefined ||
    /^boat_/i.test(code) ||
    code.split("_").some((part) => part.length > 24) ||
    (input.secrets ?? []).some((secret) => secret.length >= 8 && secret.includes(code))
      ? undefined
      : code;
  const byCode = keptCode === undefined ? undefined : kindByCode.get(keptCode);
  const kind: BoatFailureKind =
    keptCode === "credit_required"
      ? input.operation === "saveSnapshot"
        ? "snapshot-allowance-full"
        : "billing-required"
      : (byCode ??
        (input.status === 401
          ? "key-refused"
          : input.status === 402
            ? "billing-required"
            : input.status === 429
              ? "rate-limited"
              : input.status >= 500
                ? "no-answer"
                : "refused"));
  const permission =
    kind === "permission-missing"
      ? first(
          boatPermissionSchema,
          details.action,
          details.requiredAction,
          details.missingAction,
          details.permission,
          body.action,
          body.requiredAction,
          input.permission,
        )
      : undefined;
  const retryAfterSeconds = seconds(
    body.retryAfterSeconds,
    details.retryAfterSeconds,
    body.retryAfter,
    details.retryAfter,
    input.retryAfterHeader ?? undefined,
  );
  const retryAt = first(z.iso.datetime({ offset: true }), body.nextStartAt, details.nextStartAt);
  const billingUrl = safeBoatBillingUrl(body.billingUrl) ?? safeBoatBillingUrl(details.billingUrl);
  const message = safeBoatMessage(
    typeof body.message === "string" ? body.message : error.message,
    input.secrets,
  );
  const requestId = first(requestIdSchema, body.requestId);
  return boatFailureSchema.parse({
    kind,
    retryable: BOAT_RETRYABLE_FAILURE_KINDS.has(kind),
    ...(/^[A-Za-z-]{1,32}$/.test(input.operation) ? { operation: input.operation } : {}),
    status: input.status,
    ...(keptCode === undefined ? {} : { code: keptCode }),
    ...(message === undefined ? {} : { message }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(permission === undefined ? {} : { permission }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(retryAt === undefined ? {} : { retryAt }),
    ...(billingUrl === undefined ? {} : { billingUrl }),
  });
};

/** The JSON object that starts at `start` (a `{`), by balanced braces outside strings. */
const objectAt = (text: string, start: number): unknown => {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === "\\") index++;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, index + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};

const carrierSchema = z.object({
  provider: z.object({ boat: z.unknown() }).partial().optional(),
  boat: z.unknown().optional(),
});

/**
 * The Boat failure a launch or image-build error message carries. A Boat launch's message ends in
 * its allowlisted diagnostic (`; diagnostic {…}`) and a native build's in its provider failure
 * (`; provider {…}`); both are Core's own serialization of {@link boatFailureSchema}, read back
 * through the same schema. The last one in the message wins.
 */
export const boatFailureInMessage = (message: unknown): BoatFailure | undefined => {
  // A stored row read through a loose path may carry no message at all.
  if (typeof message !== "string") return undefined;
  let found: BoatFailure | undefined;
  for (const marker of ["; diagnostic {", "; provider {"]) {
    let at = message.indexOf(marker);
    while (at !== -1) {
      const carrier = carrierSchema.safeParse(objectAt(message, at + marker.length - 1));
      if (carrier.success) {
        const failure = boatFailureSchema.safeParse(
          carrier.data.provider?.boat ?? carrier.data.boat,
        );
        if (failure.success) found = failure.data;
      }
      at = message.indexOf(marker, at + marker.length);
    }
  }
  if (found !== undefined) return found;
  // A build quarantined for Boat's reason keeps only its kind (`native-boat-key-expired`, or
  // `native-cleanup-pending-boat-key-expired` while its cleanup waits on the same refusal): a
  // later launch on it reads that kind, without the first refusal's code or request id.
  for (const match of message.matchAll(/\bnative-(?:cleanup-pending-)?boat-([a-z-]+)/g)) {
    const kind = BOAT_FAILURE_KINDS.find((known) => known === match[1]);
    if (kind !== undefined) found = { kind, retryable: BOAT_RETRYABLE_FAILURE_KINDS.has(kind) };
  }
  return found;
};
