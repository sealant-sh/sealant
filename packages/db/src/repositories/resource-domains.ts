import { randomUUID } from "node:crypto";

import { and, asc, eq, lt, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Schema } from "effect";

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
  /** The application's own version of this decision, rising with each decision it makes. */
  readonly version: number;
}

export type ResourceDomainMemberOutcome =
  | { readonly kind: "decided"; readonly member: ResourceDomainMemberRecord }
  /** A newer decision stands, or one of this version with the other state; it is unchanged. */
  | { readonly kind: "stale"; readonly current: ResourceDomainMemberRecord }
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
   * Record one person's decision, by the rule on `resourceDomainMembers`. The write is one
   * statement that replaces the row only under a lower version, so whatever the order decisions
   * arrive in, and however often each is retried, the highest version stands.
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

/** The decision that wrote `current`, sent again: it answers `current` instead of a conflict. */
const repeats = (current: ResourceDomainMemberRecord, decision: ResourceDomainMemberDecision) =>
  current.version === decision.version && current.state === decision.state;

const PERSON_KEY = "resource_domain_members_user_id_user_id_fkey";

/** Whether the member's foreign key to its person refused a write, anywhere in the chain. */
const namesPersonKey = (error: unknown, depth = 0): boolean => {
  if (depth > 8 || typeof error !== "object" || error === null) return false;
  if ("constraint" in error && error.constraint === PERSON_KEY) return true;
  const nested = Cause.isCause(error)
    ? error.reasons.flatMap((reason) => (Cause.isFailReason(reason) ? [reason.error] : []))
    : [...("cause" in error ? [error.cause] : []), ...("reason" in error ? [error.reason] : [])];
  return nested.some((next) => namesPersonKey(next, depth + 1));
};

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
              const { resourceDomainId, userId, state, version } = decision;
              const written = yield* db
                .insert(resourceDomainMembers)
                .values({ resourceDomainId, userId, state, version })
                .onConflictDoUpdate({
                  target: [resourceDomainMembers.resourceDomainId, resourceDomainMembers.userId],
                  set: { state, version, updatedAt: sql`now()` },
                  setWhere: lt(resourceDomainMembers.version, version),
                })
                .returning(memberColumns)
                .pipe(
                  Effect.map(([row]) => row),
                  // The person was deleted before the write could hold their row.
                  Effect.catchIf(namesPersonKey, () => Effect.succeed(null)),
                );
              if (written === null) return { kind: "no-such-person" } as const;
              if (written !== undefined) return { kind: "decided", member: written } as const;
              const [current] = yield* db
                .select(memberColumns)
                .from(resourceDomainMembers)
                .where(
                  and(
                    eq(resourceDomainMembers.resourceDomainId, resourceDomainId),
                    eq(resourceDomainMembers.userId, userId),
                  ),
                )
                .limit(1);
              if (current === undefined) {
                const [person] = yield* db
                  .select({ id: user.id })
                  .from(user)
                  .where(eq(user.id, userId))
                  .limit(1);
                if (person === undefined) return { kind: "no-such-person" } as const;
                return yield* Effect.fail(new Error("The member's decision was not found."));
              }
              return repeats(current, decision)
                ? ({ kind: "decided", member: current } as const)
                : ({ kind: "stale", current } as const);
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
