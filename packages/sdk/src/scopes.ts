/**
 * `sealant.scopes`: owners that are projects, not people (the control plane's resource domains).
 *
 * An application ensures one scope per project, by a global `<application>:<name>` key, and names
 * the people who may reach it. A scope never holds a login or a provider credential and never runs
 * a harness, so the client that acts as one (`actAs`) has no workspace, run, inference or
 * credential methods at all. These calls need a service key and never use `ownerUserId`.
 */
import type { ResourceDomainMemberWire, ResourceDomainWire } from "@sealant/api-contracts";
import { Effect } from "effect";

import { SealantApiClient } from "./effect/api-client.js";
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
  readonly members: {
    grant(scopeId: string, userId: string, decision: ScopeMemberDecision): Promise<ScopeMember>;
    revoke(scopeId: string, userId: string, decision: ScopeMemberDecision): Promise<ScopeMember>;
    list(scopeId: string): Promise<readonly ScopeMember[]>;
  };
  /** A client for this scope alone. Nothing is checked until its first call. */
  actAs(scopeId: string): ScopeClient;
}

const toScope = (wire: ResourceDomainWire): ScopeInfo => ({
  id: wire.resourceDomainId,
  key: wire.key,
  createdAt: wire.createdAt,
});

const toMember = (wire: ResourceDomainMemberWire): ScopeMember => ({
  userId: wire.userId,
  state: wire.state,
  version: wire.version,
  updatedAt: wire.updatedAt,
});

export const makeScopes = (runtime: SdkRuntime): ScopesNamespace => {
  const call = <A>(request: (client: SealantApiClient["Service"]) => Effect.Effect<A, unknown>) =>
    runtime.run(Effect.flatMap(SealantApiClient, request));
  const decide =
    (endpoint: "grantResourceDomainMember" | "revokeResourceDomainMember") =>
    async (scopeId: string, userId: string, decision: ScopeMemberDecision) =>
      toMember(
        await call((client) =>
          client.resourceDomains[endpoint]({
            params: { resourceDomainId: scopeId, userId },
            payload: { expectedVersion: decision.expectedVersion },
          }),
        ),
      );
  const get = async (scopeId: string) =>
    toScope(
      await call((client) =>
        client.resourceDomains.getResourceDomain({ params: { resourceDomainId: scopeId } }),
      ),
    );
  const members = {
    grant: decide("grantResourceDomainMember"),
    revoke: decide("revokeResourceDomainMember"),
    list: async (scopeId: string) => {
      const wire = await call((client) =>
        client.resourceDomains.listResourceDomainMembers({
          params: { resourceDomainId: scopeId },
        }),
      );
      return wire.items.map(toMember);
    },
  };
  return {
    ensure: async ({ key }) => {
      const wire = await call((client) =>
        client.resourceDomains.ensureResourceDomain({ payload: { key } }),
      );
      return { ...toScope(wire), created: wire.created };
    },
    get,
    members,
    actAs: (scopeId) => ({
      id: scopeId,
      get: () => get(scopeId),
      members: {
        grant: (userId, decision) => members.grant(scopeId, userId, decision),
        revoke: (userId, decision) => members.revoke(scopeId, userId, decision),
        list: () => members.list(scopeId),
      },
    }),
  };
};
