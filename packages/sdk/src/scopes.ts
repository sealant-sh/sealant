/**
 * `sealant.scopes`: owners that are projects, not people (the control plane's resource domains).
 *
 * An application ensures one scope per project, by a global `<application>:<name>` key, and names
 * the people who may reach it. A scope never holds a login or a provider credential and never runs
 * a harness, so the client that acts as one (`actAs`) has no workspace, run, inference or
 * credential methods at all. These calls need a service key and never use `ownerUserId`.
 */
import {
  RESOURCE_DOMAIN_BUDGET_DIMENSIONS,
  type ResourceDomainBudgetDimension,
  type ResourceDomainWire,
} from "@sealant/api-contracts";
import * as Rec from "effect/Record";

import {
  ensureResourceDomainOp,
  getResourceDomainBudgetOp,
  getResourceDomainMemberOp,
  getResourceDomainOp,
  grantResourceDomainMemberOp,
  listResourceDomainMembersOp,
  revokeResourceDomainMemberOp,
  setResourceDomainBudgetOp,
} from "./effect/operations.js";
import type { SdkRuntime } from "./effect/runtime.js";

export interface ScopeInfo {
  /** `rdm:<uuid>`. No person field of the API accepts it. */
  readonly id: string;
  /** `<application>:<name>`, unique across every application. */
  readonly key: string;
  readonly createdAt: string;
}

export interface EnsuredScope extends ScopeInfo {
  /** True when this call created the scope. */
  readonly created: boolean;
}

/**
 * The application's latest decision about one person in a scope. A revoked member keeps its row,
 * so its version stays readable.
 */
export interface ScopeMember {
  readonly userId: string;
  readonly state: "member" | "revoked";
  readonly version: number;
  readonly updatedAt: string;
}

/**
 * `version` is the application's own number for its decision about this person, rising with each
 * decision it makes (its record's revision, say). The scope keeps the highest. The same version
 * with the same state is a repeat and answers the member unchanged. The same version with the
 * other state, or a lower one, rejects (409, `ResourceDomainMemberVersionConflictError`, whose
 * `current` is the decision that stands) and changes nothing. So a delayed grant never undoes a
 * newer revoke, and nothing needs reading first.
 */
export interface ScopeMemberDecision {
  readonly version: number;
}

/** A page of a scope's members. `nextCursor` is present when more follow. */
export interface ScopeMemberPage {
  readonly items: readonly ScopeMember[];
  readonly nextCursor?: string;
}

export interface ScopeMembers {
  grant(userId: string, decision: ScopeMemberDecision): Promise<ScopeMember>;
  revoke(userId: string, decision: ScopeMemberDecision): Promise<ScopeMember>;
  /**
   * One person's decision. Rejects with 404 `ResourceDomainMemberNotFoundError` when there is none,
   * `ResourceDomainPersonNotFoundError` when the person does not exist.
   */
  get(userId: string): Promise<ScopeMember>;
  /**
   * A page of the people with a decision in the scope, revoked ones included, by user id: `limit`
   * of them (100 unless named, at most 500), after the previous page's `nextCursor` as `cursor`.
   */
  list(options?: { readonly limit?: number; readonly cursor?: string }): Promise<ScopeMemberPage>;
}

/** Ceilings on what a scope's objects may hold (CPU millicores, memory and storage bytes). */
export type ScopeBudgetLimits = { readonly [D in ResourceDomainBudgetDimension]: number };

/**
 * `used` (confirmed to exist) and `reserved` (admitted, not yet confirmed) both count against
 * `limit`; `warning` is the highest share of it they reach.
 */
export interface ScopeBudgetDimension {
  readonly limit: number;
  readonly used: number;
  readonly reserved: number;
  readonly warning: "none" | "80-percent" | "95-percent" | "full";
}

/** Storage is one allowance, archived volumes and protection included; nothing is deleted to free it. */
export type ScopeBudget = {
  /** Name it to change the budget: a change made since refuses yours. */
  readonly revision: number;
} & { readonly [D in ResourceDomainBudgetDimension]: ScopeBudgetDimension } & {
  readonly storageBytes: { readonly archived: number; readonly protection: number };
};

export interface ScopeBudgets {
  get(): Promise<ScopeBudget>;
  /**
   * Replace the budget at the `revision` you read. A change since rejects (409,
   * `ResourceDomainBudgetRevisionConflictError`). It answers the budget it wrote, and changes
   * nothing the scope holds.
   */
  set(change: ScopeBudgetLimits & { readonly revision: number }): Promise<ScopeBudget>;
}

/** A client acting as one scope. It has no method that could reach a credential or a harness. */
export interface ScopeClient {
  readonly id: string;
  get(): Promise<ScopeInfo>;
  readonly members: ScopeMembers;
  readonly budget: ScopeBudgets;
}

export interface ScopesNamespace {
  /**
   * The scope with this key, created on the first call (with `budget`, or zero); later and
   * concurrent calls answer it. Naming another budget rejects (409,
   * `ResourceDomainBudgetDiffersError`, carrying the scope's id and its budget's revision).
   */
  ensure(options: {
    readonly key: string;
    readonly budget?: ScopeBudgetLimits;
  }): Promise<EnsuredScope>;
  get(scopeId: string): Promise<ScopeInfo>;
  /** A client for this scope alone, and the only way to its members. Nothing is checked until its first call. */
  actAs(scopeId: string): ScopeClient;
}

const toScope = (wire: ResourceDomainWire): ScopeInfo => ({
  id: wire.resourceDomainId,
  key: wire.key,
  createdAt: wire.createdAt,
});

export const makeScopes = (runtime: SdkRuntime): ScopesNamespace => {
  const get = async (scopeId: string) => toScope(await runtime.run(getResourceDomainOp(scopeId)));
  return {
    ensure: async ({ key, budget }) => {
      const wire = await runtime.run(ensureResourceDomainOp(key, budget));
      return { ...toScope(wire), created: wire.created };
    },
    get,
    actAs: (scopeId) => ({
      id: scopeId,
      get: () => get(scopeId),
      members: {
        grant: (userId, decision) =>
          runtime.run(grantResourceDomainMemberOp(scopeId, userId, { version: decision.version })),
        revoke: (userId, decision) =>
          runtime.run(revokeResourceDomainMemberOp(scopeId, userId, { version: decision.version })),
        get: (userId) => runtime.run(getResourceDomainMemberOp(scopeId, userId)),
        list: async (options) => {
          const page = await runtime.run(listResourceDomainMembersOp(scopeId, { ...options }));
          return page.nextCursor === undefined
            ? { items: page.items }
            : { items: page.items, nextCursor: page.nextCursor };
        },
      },
      budget: {
        get: () => runtime.run(getResourceDomainBudgetOp(scopeId)),
        set: (change) =>
          runtime.run(
            setResourceDomainBudgetOp(scopeId, {
              ...Rec.map(RESOURCE_DOMAIN_BUDGET_DIMENSIONS, (_, dimension) => change[dimension]),
              revision: change.revision,
            }),
          ),
      },
    }),
  };
};
