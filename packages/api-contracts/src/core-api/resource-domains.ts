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
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

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

export const resourceDomainSchema = Schema.Struct({
  resourceDomainId: ResourceDomainId,
  key: ResourceDomainKey,
  createdAt: Schema.String,
});
export type ResourceDomainWire = typeof resourceDomainSchema.Type;

export const ensureResourceDomainRequestSchema = Schema.Struct({ key: ResourceDomainKey });
export type EnsureResourceDomainRequest = typeof ensureResourceDomainRequestSchema.Type;

export const ensureResourceDomainResponseSchema = Schema.Struct({
  ...resourceDomainSchema.fields,
  /** True when this call created the domain. */
  created: Schema.Boolean,
});
export type EnsureResourceDomainResponse = typeof ensureResourceDomainResponseSchema.Type;

const versionFrom = (minimum: number, headroom: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum: Number.MAX_SAFE_INTEGER - headroom }));

export const resourceDomainMemberSchema = Schema.Struct({
  userId: PersonId,
  state: Schema.Literals(["member", "revoked"]),
  version: versionFrom(1, 0),
  updatedAt: Schema.String,
});
export type ResourceDomainMemberWire = typeof resourceDomainMemberSchema.Type;

export const resourceDomainMemberDecisionSchema = Schema.Struct({
  /** The member's version this decision replaces: 0 when the person has no decision yet. */
  expectedVersion: versionFrom(0, 1),
});
export type ResourceDomainMemberDecisionRequest = typeof resourceDomainMemberDecisionSchema.Type;

export const listResourceDomainMembersResponseSchema = Schema.Struct({
  items: Schema.Array(resourceDomainMemberSchema),
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

/** The member's version is no longer the one the decision replaces. Never quotes either version. */
export class ResourceDomainMemberVersionConflictError extends Schema.TaggedError<ResourceDomainMemberVersionConflictError>()(
  "ResourceDomainMemberVersionConflictError",
  { message: Schema.String },
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
  ResourceDomainMemberVersionConflictError,
  ResourceDomainInternalServerError,
];

export const ResourceDomainsGroup = HttpApiGroup.make("resourceDomains")
  .add(
    HttpApiEndpoint.post("ensureResourceDomain", "/", {
      payload: ensureResourceDomainRequestSchema,
      success: ensureResourceDomainResponseSchema,
      error: [ResourceDomainForbiddenError, ResourceDomainInternalServerError],
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
    HttpApiEndpoint.get("listResourceDomainMembers", "/:resourceDomainId/members", {
      params: Schema.Struct({ resourceDomainId: ResourceDomainId }),
      success: listResourceDomainMembersResponseSchema,
      error: [
        ResourceDomainForbiddenError,
        ResourceDomainNotFoundError,
        ResourceDomainInternalServerError,
      ],
    }),
  )
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
  .annotate(
    OpenApi.Description,
    "Owners that are projects, not people: they never hold a login or a provider credential.",
  );
