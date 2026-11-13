/**
 * What Boat sends for each way it refuses a call, as its docs give it (docs.boat.dev/api/v1.md,
 * /limits.md, /api-keys/scopes.md, the saved-snapshot reference; read 2026-11-13). Arm one with
 * the fake's `refuse` fault. Codes the docs do not give a body for get only the envelope.
 */
import type { BoatFailureKind } from "@sealant/api-contracts";

import type { FakeBoatRefusal } from "./fake-boat.js";

/** One refusal per failure kind Core keeps (`no-answer` is a dropped connection instead). */
export const BOAT_REFUSALS = {
  "key-refused": { status: 401, code: "unauthorized", message: "Unauthorized" },
  "key-expired": { status: 403, code: "api_key_expired", message: "API key expired." },
  "permission-missing": {
    status: 403,
    code: "api_key_action_forbidden",
    message: "This API key cannot perform sandbox.create.",
  },
  "sandbox-outside-key": {
    status: 403,
    code: "api_key_sandbox_forbidden",
    message: "This API key cannot access that sandbox.",
  },
  "organization-mismatch": {
    status: 403,
    code: "api_key_org_mismatch",
    message: "This API key belongs to another organization.",
  },
  "account-suspended": { status: 403, code: "org_suspended", message: "Organization suspended." },
  "billing-required": {
    status: 402,
    code: "billing_required",
    message: "Add a payment method to continue: https://boat.dev/billing?from=api",
    fields: { billingUrl: "https://boat.dev/billing?from=api" },
  },
  "running-limit": {
    status: 429,
    code: "limit_reached",
    message: "Your plan allows 2 running sandboxes.",
    retryAfter: 60,
  },
  "member-cap": {
    status: 402,
    code: "team_member_cap_reached",
    message: "This organization has reached its member cap.",
  },
  "rate-limited": {
    status: 429,
    code: "rate_limited",
    message: "Start limit reached for this minute.",
    fields: {
      window: "minute",
      limit: 10,
      cause: "plan",
      nextStartAt: "2026-11-13T12:01:00.000Z",
      retryAfterSeconds: 42,
    },
    retryAfter: 42,
  },
  "trial-restricted": {
    status: 429,
    code: "trial_compute_limit_reached",
    message: "Trial compute limit reached.",
    retryAfter: 3600,
  },
  "no-machine": {
    status: 503,
    code: "no_ready_machine",
    message: "No machine of this size is ready.",
    fields: { retryAfterSeconds: 5 },
  },
  "snapshot-allowance-full": {
    status: 402,
    code: "credit_required",
    message: "The wallet keeps its included saved snapshots and is empty.",
  },
  refused: { status: 409, code: "account_not_ready", message: "Account is not ready." },
} as const satisfies Record<Exclude<BoatFailureKind, "no-answer">, FakeBoatRefusal>;
