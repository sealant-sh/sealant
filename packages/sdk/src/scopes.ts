/**
 * `sealant.scopes`: owners that are projects, not people (the control plane's resource domains).
 *
 * An application ensures one scope per project, by a global `<application>:<name>` key, and names
 * the people who may reach it. A scope never holds a login or a provider credential and never runs
 * a harness, so the client that acts as one (`actAs`) has no workspace, run, inference or
 * credential methods at all. These calls need a service key and never use `ownerUserId`.
 */
import type { ResourceDomainWire } from "@sealant/api-contracts";

import {
  ensureResourceDomainOp,
  getResourceDomainMemberOp,
  getResourceDomainOp,
  grantResourceDomainMemberOp,
  listResourceDomainMembersOp,
  revokeResourceDomainMemberOp,
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

/** A client acting as one scope. It has no method that could reach a credential or a harness. */
export interface ScopeClient {
  readonly id: string;
  get(): Promise<ScopeInfo>;
  readonly members: ScopeMembers;
}

export interface ScopesNamespace {
  /** The scope with this key, created on the first call; later and concurrent calls answer it. */
  ensure(options: { readonly key: string }): Promise<EnsuredScope>;
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
    ensure: async ({ key }) => {
      const wire = await runtime.run(ensureResourceDomainOp(key));
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
    }),
  };
};
