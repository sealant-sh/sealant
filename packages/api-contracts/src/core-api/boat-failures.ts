/**
 * Why Boat refused, or did not answer, a request Core made for a workspace: a launch's VM create, an
 * image build's VM or saved snapshot, a key check. One closed set of kinds, each with what a caller
 * can do about it, plus what Boat itself said: its error code, its own message, its request id (for
 * Boat's support), when to retry and its billing link.
 *
 * Nothing else of Boat's answer is kept, and no part of a Boat key is ever in it.
 */
import { Schema } from "effect";

/**
 * - `key-refused`: Boat does not accept the key (401: unknown, revoked or malformed).
 * - `key-expired`: the key's lifetime ended (`api_key_expired`). Make a new key.
 * - `permission-missing`: the key lacks a permission the call needs (`api_key_action_forbidden`);
 *   `permission` names it.
 * - `sandbox-outside-key`: the key is limited to some VMs or environments, and this is not one of
 *   them (`api_key_sandbox_forbidden`).
 * - `organization-mismatch`: the key belongs to another Boat organization than the one the request
 *   names, or an organization key was refused a call only personal keys may make
 *   (`api_key_org_mismatch`, `api_key_org_forbidden`).
 * - `account-suspended`: the Boat account or organization is suspended (`org_suspended`).
 * - `billing-required`: the wallet must be paid or topped up first (`billing_required`,
 *   `insufficient_balance`, `credit_required`); `billingUrl` is Boat's link when it sent one.
 * - `running-limit`: the plan's limit of running VMs is reached (`limit_reached`).
 * - `member-cap`: the organization's member cap is reached (`member_limit_reached`,
 *   `team_member_cap_reached`).
 * - `rate-limited`: too many starts or requests in a window (`rate_limited`); `retryAfterSeconds`
 *   and `retryAt` say when.
 * - `trial-restricted`: the account is on a trial and the call needs a paid plan
 *   (`trial_*`, `machine_class_plan_required`).
 * - `no-machine`: Boat has no machine of the size right now (`no_ready_machine`, `out_of_capacity`).
 * - `snapshot-allowance-full`: the wallet keeps all its included saved snapshots and cannot pay for
 *   another (`credit_required` on a save).
 * - `no-answer`: Boat did not answer, or answered with a server error or a reply Core cannot read.
 * - `refused`: Boat refused for another reason; `code` is Boat's own.
 */
export const BOAT_FAILURE_KINDS = [
  "key-refused",
  "key-expired",
  "permission-missing",
  "sandbox-outside-key",
  "organization-mismatch",
  "account-suspended",
  "billing-required",
  "running-limit",
  "member-cap",
  "rate-limited",
  "trial-restricted",
  "no-machine",
  "snapshot-allowance-full",
  "no-answer",
  "refused",
] as const;
export type BoatFailureKind = (typeof BOAT_FAILURE_KINDS)[number];

/** Kinds that can succeed on a later try with the same key and request. The others cannot. */
export const BOAT_RETRYABLE_FAILURE_KINDS: ReadonlySet<BoatFailureKind> = new Set([
  "rate-limited",
  "no-machine",
  "no-answer",
]);

export const boatFailureKindSchema = Schema.Literals(BOAT_FAILURE_KINDS);

export const boatFailureSchema = Schema.Struct({
  kind: boatFailureKindSchema,
  /** Whether the same call may succeed later as it stands (see `BOAT_RETRYABLE_FAILURE_KINDS`). */
  retryable: Schema.Boolean,
  /** Core's call that Boat refused (`create`, `saveSnapshot`, `verify`), when known. */
  operation: Schema.optional(Schema.String),
  /** Boat's error code (`api_key_expired`). Absent when Boat did not answer with one. */
  code: Schema.optional(Schema.String),
  /** Boat's own message, bounded and with anything shaped like a secret removed. */
  message: Schema.optional(Schema.String),
  /** Boat's request id (`req_…`), to give Boat's support. */
  requestId: Schema.optional(Schema.String),
  /** The HTTP status Boat answered with. Absent when it did not answer. */
  status: Schema.optional(Schema.Int),
  /** The Boat permission the call needs (`sandbox.create`), for `permission-missing`. */
  permission: Schema.optional(Schema.String),
  /** Seconds Boat asked to wait before trying again. */
  retryAfterSeconds: Schema.optional(Schema.Int),
  /** When Boat said the next start is allowed (ISO 8601). */
  retryAt: Schema.optional(Schema.String),
  /** Boat's billing link, for `billing-required`. */
  billingUrl: Schema.optional(Schema.String),
});
export type BoatFailure = typeof boatFailureSchema.Type;
