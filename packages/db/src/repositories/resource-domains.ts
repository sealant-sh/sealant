import { randomUUID } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  resourceDomainMembers,
  resourceDomains,
  user,
  type ResourceDomainMemberState,
} from "../schema.js";

export class ResourceDomainRepoError extends Schema.TaggedError<ResourceDomainRepoError>()(
  "ResourceDomainRepoError",
  {
    operation: Schema.Literals(["ensure", "get", "decideMember", "listMembers"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface ResourceDomainRecord {
  readonly id: string;
  readonly key: string;
  readonly createdAt: Date;
}

export interface ResourceDomainMemberRecord {
  readonly userId: string;
  readonly state: ResourceDomainMemberState;
  readonly version: number;
  readonly updatedAt: Date;
}

/** A grant (`member`) or a revoke (`revoked`) of one person in one domain. */
export interface ResourceDomainMemberDecision {
  readonly resourceDomainId: string;
  readonly userId: string;
  readonly state: ResourceDomainMemberState;
  /** The version this decision replaces: 0 when the person has no decision in the domain yet. */
  readonly expectedVersion: number;
}

export type ResourceDomainMemberOutcome =
  | { readonly kind: "decided"; readonly member: ResourceDomainMemberRecord }
  | { readonly kind: "version-moved" }
  | { readonly kind: "no-such-person" };

export interface ResourceDomainRepoService {
  /**
   * The domain with this key, created on the first call. Concurrent calls with one key answer one
   * domain: the unique key decides the race, and exactly one call reports `created`.
   */
  readonly ensure: (
    key: string,
  ) => Effect.Effect<
    { readonly domain: ResourceDomainRecord; readonly created: boolean },
    ResourceDomainRepoError
  >;
  readonly get: (
    id: string,
  ) => Effect.Effect<ResourceDomainRecord | undefined, ResourceDomainRepoError>;
  /**
   * Compare-and-set one person's decision, by the rule on `resourceDomainMembers`. Each write is a
   * single statement conditioned on the expected version, so of two concurrent decisions from one
   * version exactly one is written.
   */
  readonly decideMember: (
    decision: ResourceDomainMemberDecision,
  ) => Effect.Effect<ResourceDomainMemberOutcome, ResourceDomainRepoError>;
  /** Every person with a decision in the domain, revoked ones included, by user id. */
  readonly listMembers: (
    resourceDomainId: string,
  ) => Effect.Effect<ReadonlyArray<ResourceDomainMemberRecord>, ResourceDomainRepoError>;
}

export class ResourceDomainRepo extends Context.Service<
  ResourceDomainRepo,
  ResourceDomainRepoService
>()("ResourceDomainRepo") {}

const withError = <A>(
  operation: ResourceDomainRepoError["operation"],
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, ResourceDomainRepoError> =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new ResourceDomainRepoError({
          operation,
          message: cause instanceof Error ? cause.message : `${operation} failed.`,
          cause,
        }),
    ),
  );

const columns = {
  id: resourceDomains.id,
  key: resourceDomains.key,
  createdAt: resourceDomains.createdAt,
};

const memberColumns = {
  userId: resourceDomainMembers.userId,
  state: resourceDomainMembers.state,
  version: resourceDomainMembers.version,
  updatedAt: resourceDomainMembers.updatedAt,
};

/** The decision that wrote `current`, asked again: it answers `current` instead of a conflict. */
const repeats = (current: ResourceDomainMemberRecord, decision: ResourceDomainMemberDecision) =>
  current.version === decision.expectedVersion + 1 && current.state === decision.state;

export const ResourceDomainRepoLive: Layer.Layer<ResourceDomainRepo, never, SealantDB> =
  Layer.effect(
    ResourceDomainRepo,
    Effect.gen(function* () {
      const db = yield* SealantDB;
      return {
        ensure: (key) =>
          withError(
            "ensure",
            Effect.gen(function* () {
              const [inserted] = yield* db
                .insert(resourceDomains)
                .values({ id: `rdm:${randomUUID()}`, key })
                .onConflictDoNothing({ target: resourceDomains.key })
                .returning(columns);
              if (inserted !== undefined) return { domain: inserted, created: true };
              // Another call holds the key: answer its domain.
              const [existing] = yield* db
                .select(columns)
                .from(resourceDomains)
                .where(eq(resourceDomains.key, key))
                .limit(1);
              if (existing === undefined) {
                return yield* Effect.fail(new Error("The resource domain's key was not found."));
              }
              return { domain: existing, created: false };
            }),
          ),
        get: (id) =>
          withError(
            "get",
            Effect.map(
              db.select(columns).from(resourceDomains).where(eq(resourceDomains.id, id)).limit(1),
              ([row]) => row,
            ),
          ),
        decideMember: (decision) =>
          withError(
            "decideMember",
            Effect.gen(function* () {
              const row = and(
                eq(resourceDomainMembers.resourceDomainId, decision.resourceDomainId),
                eq(resourceDomainMembers.userId, decision.userId),
              );
              const next = { state: decision.state, version: decision.expectedVersion + 1 };
              if (decision.expectedVersion === 0) {
                const [person] = yield* db
                  .select({ id: user.id })
                  .from(user)
                  .where(eq(user.id, decision.userId))
                  .limit(1);
                if (person === undefined) return { kind: "no-such-person" } as const;
              }
              const [written] =
                decision.expectedVersion === 0
                  ? yield* db
                      .insert(resourceDomainMembers)
                      .values({
                        resourceDomainId: decision.resourceDomainId,
                        userId: decision.userId,
                        ...next,
                      })
                      .onConflictDoNothing()
                      .returning(memberColumns)
                  : yield* db
                      .update(resourceDomainMembers)
                      .set({ ...next, updatedAt: sql`now()` })
                      .where(and(row, eq(resourceDomainMembers.version, decision.expectedVersion)))
                      .returning(memberColumns);
              if (written !== undefined) return { kind: "decided", member: written } as const;
              const [current] = yield* db
                .select(memberColumns)
                .from(resourceDomainMembers)
                .where(row)
                .limit(1);
              return current !== undefined && repeats(current, decision)
                ? ({ kind: "decided", member: current } as const)
                : ({ kind: "version-moved" } as const);
            }),
          ),
        listMembers: (resourceDomainId) =>
          withError(
            "listMembers",
            db
              .select(memberColumns)
              .from(resourceDomainMembers)
              .where(eq(resourceDomainMembers.resourceDomainId, resourceDomainId))
              .orderBy(asc(resourceDomainMembers.userId)),
          ),
      } satisfies ResourceDomainRepoService;
    }),
  );
