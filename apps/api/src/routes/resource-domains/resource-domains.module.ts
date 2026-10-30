/**
 * Resource domain handlers (see the contract's header). A service key manages a domain: the
 * transport refuses every other bearer with `401` before these run. A deployment served without
 * authentication (`SEALANT_ALLOW_OPEN_API`, development only) serves them as it serves every
 * credential route: refusing only these would protect nothing there and keep a developer's
 * loopback control plane from ensuring a domain.
 */
import {
  RESOURCE_DOMAIN_BUDGET_DIMENSIONS,
  RESOURCE_DOMAIN_BUDGET_WARNINGS,
  ResourceDomainBudgetDiffersError,
  ResourceDomainBudgetRevisionConflictError,
  ResourceDomainForbiddenError,
  ResourceDomainInternalServerError,
  ResourceDomainMemberNotFoundError,
  ResourceDomainMemberVersionConflictError,
  ResourceDomainNotFoundError,
  ResourceDomainPersonNotFoundError,
  RESOURCE_DOMAIN_MEMBERS_PAGE,
  type EnsureResourceDomainRequest,
  type ListResourceDomainMembersQuery,
  type ResourceDomainBudgetWarning,
  type ResourceDomainBudgetWire,
  type ResourceDomainMemberWire,
  type ResourceDomainWire,
  type SetResourceDomainBudgetRequest,
} from "@sealant/api-contracts";
import {
  ResourceDomainRepo,
  type ResourceDomainBudgetRecord,
  type ResourceDomainMemberRecord,
  type ResourceDomainRecord,
} from "@sealant/db";
import { Effect } from "effect";
import * as Rec from "effect/Record";

import { CurrentPrincipal } from "../../services/service-principals.js";

const requireServiceKey = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  if (principal.kind !== "service" && principal.kind !== "open") {
    return yield* new ResourceDomainForbiddenError({
      message: "A service key is required to manage resource domains.",
    });
  }
});

const toWire = (domain: ResourceDomainRecord): ResourceDomainWire => ({
  resourceDomainId: domain.id,
  key: domain.key,
  createdAt: domain.createdAt.toISOString(),
});

const internal = (message: string) => () => new ResourceDomainInternalServerError({ message });

export const ensureResourceDomain = (payload: EnsureResourceDomainRequest) =>
  Effect.gen(function* () {
    yield* requireServiceKey;
    const repo = yield* ResourceDomainRepo;
    const ensured = yield* repo
      .ensure(payload.key, payload.budget)
      .pipe(Effect.mapError(internal("Failed to ensure the resource domain.")));
    if (ensured.kind === "budget-differs") {
      return yield* new ResourceDomainBudgetDiffersError({
        message:
          "This resource domain exists with another budget, and ensuring it never changes one: set its budget at its revision.",
        resourceDomainId: ensured.domain.id,
        revision: ensured.revision,
      });
    }
    return { ...toWire(ensured.domain), created: ensured.created };
  });

const loadDomain = (resourceDomainId: string) =>
  Effect.gen(function* () {
    yield* requireServiceKey;
    const repo = yield* ResourceDomainRepo;
    const domain = yield* repo
      .get(resourceDomainId)
      .pipe(Effect.mapError(internal("Failed to load the resource domain.")));
    if (domain === undefined) {
      return yield* new ResourceDomainNotFoundError({ message: "Resource domain not found." });
    }
    return domain;
  });

export const getResourceDomain = (resourceDomainId: string) =>
  Effect.map(loadDomain(resourceDomainId), toWire);

const warningAt = (charged: number, limit: number): ResourceDomainBudgetWarning => {
  if (charged >= limit) return "full";
  const share = (percent: number) => BigInt(charged) * 100n >= BigInt(limit) * BigInt(percent);
  if (share(RESOURCE_DOMAIN_BUDGET_WARNINGS["95-percent"])) return "95-percent";
  if (share(RESOURCE_DOMAIN_BUDGET_WARNINGS["80-percent"])) return "80-percent";
  return "none";
};

const budgetToWire = ({ budget, revision, charge }: ResourceDomainBudgetRecord) => {
  const dimensions = Rec.map(RESOURCE_DOMAIN_BUDGET_DIMENSIONS, (_, name) => ({
    limit: budget[name],
    used: charge.used[name],
    reserved: charge.reserved[name],
    warning: warningAt(charge.used[name] + charge.reserved[name], budget[name]),
  }));
  return {
    revision,
    ...dimensions,
    storageBytes: {
      ...dimensions.storageBytes,
      archived: charge.archivedBytes,
      protection: charge.protectionBytes,
    },
  } satisfies ResourceDomainBudgetWire;
};

export const getResourceDomainBudget = (resourceDomainId: string) =>
  Effect.gen(function* () {
    yield* requireServiceKey;
    const repo = yield* ResourceDomainRepo;
    const record = yield* repo
      .getBudget(resourceDomainId)
      .pipe(Effect.mapError(internal("Failed to read the resource domain's budget.")));
    if (record === undefined) {
      return yield* new ResourceDomainNotFoundError({ message: "Resource domain not found." });
    }
    return budgetToWire(record);
  });

export const setResourceDomainBudget = (
  resourceDomainId: string,
  { revision, ...budget }: SetResourceDomainBudgetRequest,
) =>
  Effect.gen(function* () {
    yield* requireServiceKey;
    const repo = yield* ResourceDomainRepo;
    const outcome = yield* repo
      .setBudget({ resourceDomainId, revision, budget })
      .pipe(Effect.mapError(internal("Failed to set the resource domain's budget.")));
    switch (outcome.kind) {
      case "no-such-domain":
        return yield* new ResourceDomainNotFoundError({ message: "Resource domain not found." });
      case "stale":
        return yield* new ResourceDomainBudgetRevisionConflictError({
          message:
            "The budget changed since that revision was read, so this change changed nothing.",
          revision: outcome.revision,
        });
      case "set":
        return budgetToWire(outcome.record);
    }
  });

const memberToWire = (member: ResourceDomainMemberRecord): ResourceDomainMemberWire => ({
  userId: member.userId,
  state: member.state,
  version: member.version,
  updatedAt: member.updatedAt.toISOString(),
});

export const decideResourceDomainMember = (
  params: { readonly resourceDomainId: string; readonly userId: string },
  state: ResourceDomainMemberRecord["state"],
  version: number,
) =>
  Effect.gen(function* () {
    yield* loadDomain(params.resourceDomainId);
    const repo = yield* ResourceDomainRepo;
    const outcome = yield* repo
      .decideMember({ ...params, state, version })
      .pipe(Effect.mapError(internal("Failed to record the member decision.")));
    switch (outcome.kind) {
      case "decided":
        return memberToWire(outcome.member);
      case "no-such-person":
        return yield* noPerson();
      case "stale":
        return yield* new ResourceDomainMemberVersionConflictError({
          message:
            "A decision at least as new about this person stands, so this one changed nothing.",
          current: { state: outcome.current.state, version: outcome.current.version },
        });
    }
  });

const noPerson = () => new ResourceDomainPersonNotFoundError({ message: "No person has this id." });

export const getResourceDomainMember = (params: {
  readonly resourceDomainId: string;
  readonly userId: string;
}) =>
  Effect.gen(function* () {
    yield* loadDomain(params.resourceDomainId);
    const repo = yield* ResourceDomainRepo;
    const lookup = yield* repo
      .getMember(params.resourceDomainId, params.userId)
      .pipe(Effect.mapError(internal("Failed to read the member.")));
    switch (lookup.kind) {
      case "found":
        return memberToWire(lookup.member);
      case "no-such-person":
        return yield* noPerson();
      case "no-decision":
        return yield* new ResourceDomainMemberNotFoundError({
          message: "This person has no decision in this resource domain.",
        });
    }
  });

export const listResourceDomainMembers = (
  resourceDomainId: string,
  query: ListResourceDomainMembersQuery,
) =>
  Effect.gen(function* () {
    yield* loadDomain(resourceDomainId);
    const repo = yield* ResourceDomainRepo;
    const page = yield* repo
      .listMembers({
        resourceDomainId,
        limit: query.limit ?? RESOURCE_DOMAIN_MEMBERS_PAGE.default,
        ...(query.cursor === undefined ? {} : { after: query.cursor }),
      })
      .pipe(Effect.mapError(internal("Failed to list the resource domain's members.")));
    return {
      items: page.members.map(memberToWire),
      ...(page.next === undefined ? {} : { nextCursor: page.next }),
    };
  });
