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
 * A grant or revoke names the member's version it replaces: 0 for a person with no decision yet,
 * else the `version` last read. Another version rejects (409,
 * `ResourceDomainMemberVersionConflictError`) and changes nothing, so a delayed grant never undoes
 * a newer revoke. Repeating the decision that wrote the current version answers it unchanged.
 */
export interface ScopeMemberDecision {
  readonly expectedVersion: number;
}

export interface ScopeMembers {
  grant(userId: string, decision: ScopeMemberDecision): Promise<ScopeMember>;
  revoke(userId: string, decision: ScopeMemberDecision): Promise<ScopeMember>;
  /** Every person with a decision in the scope, revoked ones included, by user id. */
  list(): Promise<readonly ScopeMember[]>;
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
          runtime.run(
            grantResourceDomainMemberOp(scopeId, userId, {
              expectedVersion: decision.expectedVersion,
            }),
          ),
        revoke: (userId, decision) =>
          runtime.run(
            revokeResourceDomainMemberOp(scopeId, userId, {
              expectedVersion: decision.expectedVersion,
            }),
          ),
        list: async () => (await runtime.run(listResourceDomainMembersOp(scopeId))).items,
      },
    }),
  };
};
