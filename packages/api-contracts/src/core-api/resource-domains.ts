/**
 * Resource domains: an owner that is a project, not a person.
 *
 * An application (Mend) keeps one domain per project for the things the project owns rather than
 * any one person: its services, volumes and network. A domain outlives every person, and it never
 * holds a login or a provider credential and never runs a harness. Its id (`rdm:<uuid>`) can never
 * name a person: every person field of this API is a `PersonId`, which refuses it.
 *
 * `ensureResourceDomain` is idempotent on `key`, `<application>:<name>` (Mend:
 * `mend:<installation>:project:<project>`): the first call creates the domain and every later or
 * concurrent call answers the same one. Keys are global, and every service key may name any of
 * them; the application prefix keeps applications apart by convention, not by authority.
 *
 * Only a service key reaches these routes. Any other bearer is refused by the transport with `401`
 * before a handler runs. A deployment served without authentication (the development exception)
 * serves them as it serves every other route. A request body is decoded strictly: a field the contract does not declare (an
 * owner, a credential) is refused with `400` instead of being dropped.
 *
 * Members are the people the application lets reach the domain. A grant or a revoke carries
 * `version`, the application's own number for its decision about this person, rising with each
 * decision it makes (its record's revision, say). Core writes the decision only over a lower
 * version. The same version with the same state is a repeat, answered with the member unchanged.
 * The same version with the other state, or a lower one, is stale: `409`, carrying the decision
 * that stands. So a delayed grant never undoes a newer revoke, whatever order decisions arrive in
 * and however often each is retried, and the application never reads before it writes. A revoke
 * keeps the member's row, with its version. One member reads at `GET …/members/:userId`, and the
 * list pages by user id: `limit` (100 unless named, at most 500) and the previous page's
 * `nextCursor` as `cursor`.
 *
 * A budget caps CPU (millicores), memory and storage (bytes): ceilings, not measurements, and
 * zero allows nothing. Storage is one allowance for volumes, archived ones included, and the
 * backups and snapshots that protect them. `ensureResourceDomain` may name a new domain's budget
 * and never changes one: naming another gets `409`, carrying the domain and its revision.
 * `setResourceDomainBudget` takes the `revision` it read: a change made since gets `409`, so a
 * delayed update never overwrites a newer one, and it answers the budget it wrote. Changing a
 * budget changes nothing the domain holds. The read is one snapshot. It reports, per dimension,
 * `used` (confirmed to exist), `reserved` (admitted, not yet confirmed), the `limit` and a `warning`
 * once both reach 80%, 95% or all of it; storage also reports its `archived` and `protection` bytes.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import * as Rec from "effect/Record";

import { PersonId, RESOURCE_DOMAIN_ID_PREFIX } from "./person-id.js";

const RESOURCE_DOMAIN_ID_PATTERN = new RegExp(
  `^${RESOURCE_DOMAIN_ID_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
);

const RESOURCE_DOMAIN_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9._:/@+=-]{1,223}$/;

const ResourceDomainId = Schema.String.check(
  Schema.makeFilter((id: string) =>
    RESOURCE_DOMAIN_ID_PATTERN.test(id) ? undefined : "must be a resource domain id (rdm:<uuid>)",
  ),
);

const ResourceDomainKey = Schema.String.check(
  Schema.makeFilter((key: string) =>
    RESOURCE_DOMAIN_KEY_PATTERN.test(key)
      ? undefined
      : "must be <application>:<name>: a lower-case application name (letters, digits, '-'), a colon, then at most 223 letters, digits, '.', '_', ':', '/', '@', '+', '=' or '-'",
  ),
);

const Amount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const BudgetRevision = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

/**
 * The dimensions a budget caps, defined once: the contract's schemas, the database's budget, the
 * admission check and the SDK all take theirs from these keys. `freedBy` is what makes room in a
 * dimension besides raising its limit.
 */
export const RESOURCE_DOMAIN_BUDGET_DIMENSIONS = {
  cpuMillicores: { name: "CPU", freedBy: "stop-objects" },
  memoryBytes: { name: "memory", freedBy: "stop-objects" },
  storageBytes: { name: "storage", freedBy: "purge-objects" },
} as const;
export type ResourceDomainBudgetDimension = keyof typeof RESOURCE_DOMAIN_BUDGET_DIMENSIONS;

export const resourceDomainBudgetLimitsSchema = Schema.Struct(
  Rec.map(RESOURCE_DOMAIN_BUDGET_DIMENSIONS, () => Amount),
);
export type ResourceDomainBudgetLimits = typeof resourceDomainBudgetLimitsSchema.Type;

/** The share of a limit at which the budget read starts to warn. */
export const RESOURCE_DOMAIN_BUDGET_WARNINGS = { "80-percent": 80, "95-percent": 95 } as const;
const BudgetWarning = Schema.Literals(["none", "80-percent", "95-percent", "full"]);
export type ResourceDomainBudgetWarning = typeof BudgetWarning.Type;

const budgetDimensionSchema = Schema.Struct({
  limit: Amount,
  used: Amount,
  reserved: Amount,
  warning: BudgetWarning,
});

export const resourceDomainBudgetSchema = Schema.Struct({
  revision: BudgetRevision,
  ...Rec.map(RESOURCE_DOMAIN_BUDGET_DIMENSIONS, () => budgetDimensionSchema),
  storageBytes: Schema.Struct({
    ...budgetDimensionSchema.fields,
    /** Archived volumes' data bytes, part of `used`: kept until a person purges them. */
    archived: Amount,
    /** Bytes that backups and snapshots hold, not a volume's unused reserve for them. */
    protection: Amount,
  }),
});
export type ResourceDomainBudgetWire = typeof resourceDomainBudgetSchema.Type;

export const setResourceDomainBudgetRequestSchema = Schema.Struct({
  ...resourceDomainBudgetLimitsSchema.fields,
  /** The revision this change replaces: the one the caller last read. */
  revision: BudgetRevision,
});
export type SetResourceDomainBudgetRequest = typeof setResourceDomainBudgetRequestSchema.Type;

export const resourceDomainSchema = Schema.Struct({
  resourceDomainId: ResourceDomainId,
  key: ResourceDomainKey,
  createdAt: Schema.String,
});
export type ResourceDomainWire = typeof resourceDomainSchema.Type;

export const ensureResourceDomainRequestSchema = Schema.Struct({
  key: ResourceDomainKey,
  /** The budget a new domain starts with; none starts it at zero. */
  budget: Schema.optional(resourceDomainBudgetLimitsSchema),
});
export type EnsureResourceDomainRequest = typeof ensureResourceDomainRequestSchema.Type;

export const ensureResourceDomainResponseSchema = Schema.Struct({
  ...resourceDomainSchema.fields,
  /** True when this call created the domain. */
  created: Schema.Boolean,
});
export type EnsureResourceDomainResponse = typeof ensureResourceDomainResponseSchema.Type;

const MemberVersion = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const MemberState = Schema.Literals(["member", "revoked"]);

export const resourceDomainMemberSchema = Schema.Struct({
  userId: PersonId,
  state: MemberState,
  version: MemberVersion,
  updatedAt: Schema.String,
});
export type ResourceDomainMemberWire = typeof resourceDomainMemberSchema.Type;

export const resourceDomainMemberDecisionSchema = Schema.Struct({
  /** The application's own version of this decision, rising with each decision it makes. */
  version: MemberVersion,
});
export type ResourceDomainMemberDecisionRequest = typeof resourceDomainMemberDecisionSchema.Type;

/** At most this many members a page, and this many when the request names no `limit`. */
export const RESOURCE_DOMAIN_MEMBERS_PAGE = { default: 100, max: 500 } as const;

export const listResourceDomainMembersQuerySchema = Schema.Struct({
  limit: Schema.optional(
    Schema.FiniteFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: RESOURCE_DOMAIN_MEMBERS_PAGE.max }),
    ),
  ),
  /** A previous page's `nextCursor`: the page starts after it. */
  cursor: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
});
export type ListResourceDomainMembersQuery = typeof listResourceDomainMembersQuerySchema.Type;

export const listResourceDomainMembersResponseSchema = Schema.Struct({
  items: Schema.Array(resourceDomainMemberSchema),
  /** Present when more members follow: pass it as `cursor` for the next page. */
  nextCursor: Schema.optional(Schema.String),
});
export type ListResourceDomainMembersResponse = typeof listResourceDomainMembersResponseSchema.Type;

export class ResourceDomainForbiddenError extends Schema.TaggedError<ResourceDomainForbiddenError>()(
  "ResourceDomainForbiddenError",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class ResourceDomainNotFoundError extends Schema.TaggedError<ResourceDomainNotFoundError>()(
  "ResourceDomainNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The person a member route names does not exist (the domain does). */
export class ResourceDomainPersonNotFoundError extends Schema.TaggedError<ResourceDomainPersonNotFoundError>()(
  "ResourceDomainPersonNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The person exists, and the application has made no decision about them in the domain. */
export class ResourceDomainMemberNotFoundError extends Schema.TaggedError<ResourceDomainMemberNotFoundError>()(
  "ResourceDomainMemberNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/**
 * A decision at least as new stands, so this one changed nothing. `current` is the decision that
 * stands; the message quotes nothing the request sent.
 */
export class ResourceDomainMemberVersionConflictError extends Schema.TaggedError<ResourceDomainMemberVersionConflictError>()(
  "ResourceDomainMemberVersionConflictError",
  {
    message: Schema.String,
    current: Schema.Struct({ state: MemberState, version: MemberVersion }),
  },
  { httpApiStatus: 409 },
) {}

/** The domain exists with another budget, at `revision`; nothing changed. */
export class ResourceDomainBudgetDiffersError extends Schema.TaggedError<ResourceDomainBudgetDiffersError>()(
  "ResourceDomainBudgetDiffersError",
  { message: Schema.String, resourceDomainId: ResourceDomainId, revision: BudgetRevision },
  { httpApiStatus: 409 },
) {}

/** `revision` is the current one. */
export class ResourceDomainBudgetRevisionConflictError extends Schema.TaggedError<ResourceDomainBudgetRevisionConflictError>()(
  "ResourceDomainBudgetRevisionConflictError",
  { message: Schema.String, revision: BudgetRevision },
  { httpApiStatus: 409 },
) {}

export class ResourceDomainInternalServerError extends Schema.TaggedError<ResourceDomainInternalServerError>()(
  "ResourceDomainInternalServerError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

const memberParams = Schema.Struct({ resourceDomainId: ResourceDomainId, userId: PersonId });
const memberErrors = [
  ResourceDomainForbiddenError,
  ResourceDomainNotFoundError,
  ResourceDomainPersonNotFoundError,
  ResourceDomainMemberVersionConflictError,
  ResourceDomainInternalServerError,
];

export const ResourceDomainsGroup = HttpApiGroup.make("resourceDomains")
  .add(
    HttpApiEndpoint.post("ensureResourceDomain", "/", {
      payload: ensureResourceDomainRequestSchema,
      success: ensureResourceDomainResponseSchema,
      error: [
        ResourceDomainForbiddenError,
        ResourceDomainBudgetDiffersError,
        ResourceDomainInternalServerError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("getResourceDomain", "/:resourceDomainId", {
      params: Schema.Struct({ resourceDomainId: ResourceDomainId }),
      success: resourceDomainSchema,
      error: [
        ResourceDomainForbiddenError,
        ResourceDomainNotFoundError,
        ResourceDomainInternalServerError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("grantResourceDomainMember", "/:resourceDomainId/members/:userId/grant", {
      params: memberParams,
      payload: resourceDomainMemberDecisionSchema,
      success: resourceDomainMemberSchema,
      error: memberErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "revokeResourceDomainMember",
      "/:resourceDomainId/members/:userId/revoke",
      {
        params: memberParams,
        payload: resourceDomainMemberDecisionSchema,
        success: resourceDomainMemberSchema,
        error: memberErrors,
      },
    ),
  )
  .add(
    HttpApiEndpoint.get("getResourceDomainMember", "/:resourceDomainId/members/:userId", {
      params: memberParams,
      success: resourceDomainMemberSchema,
      error: [
        ResourceDomainForbiddenError,
        ResourceDomainNotFoundError,
        ResourceDomainPersonNotFoundError,
        ResourceDomainMemberNotFoundError,
        ResourceDomainInternalServerError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("listResourceDomainMembers", "/:resourceDomainId/members", {
      params: Schema.Struct({ resourceDomainId: ResourceDomainId }),
      query: listResourceDomainMembersQuerySchema,
      success: listResourceDomainMembersResponseSchema,
      error: [
        ResourceDomainForbiddenError,
        ResourceDomainNotFoundError,
        ResourceDomainInternalServerError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("getResourceDomainBudget", "/:resourceDomainId/budget", {
      params: Schema.Struct({ resourceDomainId: ResourceDomainId }),
      success: resourceDomainBudgetSchema,
      error: [
        ResourceDomainForbiddenError,
        ResourceDomainNotFoundError,
        ResourceDomainInternalServerError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.put("setResourceDomainBudget", "/:resourceDomainId/budget", {
      params: Schema.Struct({ resourceDomainId: ResourceDomainId }),
      payload: setResourceDomainBudgetRequestSchema,
      success: resourceDomainBudgetSchema,
      error: [
        ResourceDomainForbiddenError,
        ResourceDomainNotFoundError,
        ResourceDomainBudgetRevisionConflictError,
        ResourceDomainInternalServerError,
      ],
    }),
  )
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
  .annotate(
    OpenApi.Description,
    "Owners that are projects, not people: they never hold a login or a provider credential.",
  );
