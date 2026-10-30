import { randomUUID } from "node:crypto";

import {
  RESOURCE_DOMAIN_BUDGET_DIMENSIONS,
  type ResourceDomainBudgetDimension,
} from "@sealant/api-contracts";
import { and, asc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import * as Rec from "effect/Record";

import { SealantDB } from "../client.js";
import {
  resourceDomainAllocations,
  resourceDomainMembers,
  resourceDomains,
  user,
  type ResourceDomainAllocation,
  type ResourceDomainAllocationState,
  type ResourceDomainAllocationUse,
  type ResourceDomainMemberState,
} from "../schema.js";

export class ResourceDomainRepoError extends Schema.TaggedError<ResourceDomainRepoError>()(
  "ResourceDomainRepoError",
  {
    operation: Schema.Literals([
      "ensure",
      "get",
      "decideMember",
      "getMember",
      "listMembers",
      "getBudget",
      "setBudget",
      "admit",
      "record",
    ]),
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

export type ResourceDomainMemberLookup =
  | { readonly kind: "found"; readonly member: ResourceDomainMemberRecord }
  | { readonly kind: "no-decision" }
  | { readonly kind: "no-such-person" };

/** Ceilings, not measurements, one per dimension: zero allows nothing; there is no unlimited. */
export type ResourceDomainBudget = { readonly [D in ResourceDomainBudgetDimension]: number };

/**
 * What the domain's allocations that are not released hold. `used` is what is confirmed to exist
 * (in use or archived), `reserved` what is admitted and not yet confirmed; both count. Storage is
 * each volume's data and unused protection reserve plus every backup (`resourceDomainAllocations`).
 * `archivedBytes` is archived volumes' data, and `protectionBytes` what backups hold.
 */
export interface ResourceDomainCharge {
  readonly used: ResourceDomainBudget;
  readonly reserved: ResourceDomainBudget;
  readonly archivedBytes: number;
  readonly protectionBytes: number;
}

export interface ResourceDomainBudgetRecord {
  readonly budget: ResourceDomainBudget;
  readonly revision: number;
  readonly charge: ResourceDomainCharge;
}

export interface ResourceDomainRepoService {
  /**
   * The domain with this key, created on the first call, with `budget` (none: all zero).
   * Concurrent calls with one key answer one domain: the unique key decides the race, and exactly
   * one call reports `created`. A later call never changes the budget: naming another answers
   * `budget-differs` with the domain and its budget's revision.
   */
  readonly ensure: (
    key: string,
    budget?: ResourceDomainBudget,
  ) => Effect.Effect<
    | { readonly kind: "ensured"; readonly domain: ResourceDomainRecord; readonly created: boolean }
    | {
        readonly kind: "budget-differs";
        readonly domain: ResourceDomainRecord;
        readonly revision: number;
      },
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
  /** One person's decision in the domain, or why there is none. */
  readonly getMember: (
    resourceDomainId: string,
    userId: string,
  ) => Effect.Effect<ResourceDomainMemberLookup, ResourceDomainRepoError>;
  /**
   * A page of the people with a decision in the domain, revoked ones included, by user id after
   * `after`. `next` is the last user id of a page with more after it.
   */
  readonly listMembers: (input: {
    readonly resourceDomainId: string;
    readonly after?: string;
    readonly limit: number;
  }) => Effect.Effect<
    { readonly members: ReadonlyArray<ResourceDomainMemberRecord>; readonly next?: string },
    ResourceDomainRepoError
  >;
  /** The budget and what the domain holds of it, read in one statement: one snapshot. */
  readonly getBudget: (
    resourceDomainId: string,
  ) => Effect.Effect<ResourceDomainBudgetRecord | undefined, ResourceDomainRepoError>;
  /**
   * Replace the budget if its revision is still `revision`, and answer the budget it wrote with
   * the charge read while it holds the row. A retry of a change whose answer was lost (the next
   * revision holds this very budget) answers `set` again; anything newer answers `stale`.
   * Changing a budget changes no allocation.
   */
  readonly setBudget: (input: {
    readonly resourceDomainId: string;
    readonly revision: number;
    readonly budget: ResourceDomainBudget;
  }) => Effect.Effect<
    | { readonly kind: "set"; readonly record: ResourceDomainBudgetRecord }
    | { readonly kind: "stale"; readonly revision: number }
    | { readonly kind: "no-such-domain" },
    ResourceDomainRepoError
  >;
  readonly admit: ResourceDomainAdmissionService["admit"];
  readonly record: ResourceDomainAdmissionService["record"];
}

/** What an admission asks to hold. See `resourceDomainAllocations` for each use. */
export type ResourceDomainAdmissionRequest =
  | {
      readonly use: "compute";
      readonly objectKey: string;
      readonly cpuMillicores: number;
      readonly memoryBytes: number;
    }
  | {
      readonly use: "volume";
      readonly objectKey: string;
      readonly storageBytes: number;
      /** Reserved with the volume for its backups and snapshots, which draw on it first. */
      readonly protectionBytes: number;
    }
  | {
      readonly use: "protection";
      readonly objectKey: string;
      /** The volume this backs up: one the domain holds, archived or not. */
      readonly sourceObjectKey: string;
      readonly protectionBytes: number;
    };

export type ResourceDomainAllocationRecord = ResourceDomainAllocation;

export type ResourceDomainAdmission =
  /** Held from now on. `replayed`: this operation was admitted before, and charged then. */
  | {
      readonly kind: "admitted";
      readonly allocation: ResourceDomainAllocationRecord;
      readonly replayed: boolean;
    }
  /**
   * `used + reserved + requested > limit` in `dimension`, where `requested` is what the admission
   * would add: a backup's bytes beyond its volume's unused reserve.
   */
  | {
      readonly kind: "over-budget";
      readonly dimension: ResourceDomainBudgetDimension;
      readonly used: number;
      readonly reserved: number;
      readonly requested: number;
      readonly limit: number;
    }
  | {
      readonly kind: "refused";
      readonly reason:
        | "invalid-amount"
        | "domain-not-active"
        | "operation-key-reused"
        | "operation-released"
        | "object-held"
        | "no-source-volume";
    }
  | { readonly kind: "no-such-domain" };

/**
 * What the runtime confirmed about an allocation's object. Only these move a row, so nothing is
 * released on a guess: compute on a confirmed stop, storage on a confirmed purge.
 */
export type ResourceDomainAllocationEvent = "created" | "archived" | "stopped" | "purged";

export type ResourceDomainAllocationOutcome =
  /** The allocation is in the event's state now, whether this call or an earlier one moved it. */
  | { readonly kind: "recorded"; readonly allocation: ResourceDomainAllocationRecord }
  /** The event does not apply to this allocation's use or state; nothing changed. */
  | { readonly kind: "refused"; readonly allocation: ResourceDomainAllocationRecord }
  | { readonly kind: "no-such-allocation" };

/** `admit` and `record` hold the domain row; any other isolation would read sums it cannot see. */
export const RESOURCE_DOMAIN_ADMISSION_ISOLATION =
  "Resource domain admission runs only at READ COMMITTED: a snapshot older than the domain's lock would miss allocations committed while it waited.";

/** Admission and allocation events, each under the domain row's lock (`admit`, `record`). */
export interface ResourceDomainAdmissionService {
  /**
   * Admit one operation. It holds the domain row (`FOR NO KEY UPDATE`, so inserts that reference
   * the domain, such as a member grant, do not wait) until its transaction commits: admissions and
   * events on every server queue for it, and each reads the sums the last one left. Inside a
   * caller's `DatabaseTransaction` the allocation commits with the caller's writes, and the hold
   * lasts until then. It runs only at READ COMMITTED and fails otherwise. Only an active domain
   * admits new work; any domain admits a backup of a volume it holds, within its budget. A backup
   * draws first on its volume's unused reserve. An amount that is not a safe integer, or a volume
   * whose data and reserve add up to more than one, is `invalid-amount`.
   */
  readonly admit: (input: {
    readonly resourceDomainId: string;
    readonly operationKey: string;
    readonly request: ResourceDomainAdmissionRequest;
  }) => Effect.Effect<ResourceDomainAdmission, ResourceDomainRepoError>;
  /**
   * Record what the runtime confirmed, under the same lock as `admit`, taken first, so an event
   * and an admission never interleave. Purging a volume releases its data and unused reserve; its
   * backups stay charged until each is purged. READ COMMITTED only, as `admit`.
   */
  readonly record: (input: {
    readonly resourceDomainId: string;
    readonly allocationId: string;
    readonly event: ResourceDomainAllocationEvent;
  }) => Effect.Effect<ResourceDomainAllocationOutcome, ResourceDomainRepoError>;
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

const DIMENSIONS = Rec.keys(RESOURCE_DOMAIN_BUDGET_DIMENSIONS);

/**
 * Each dimension's budget column, and what one live allocation `a` charges in it. A volume
 * charges its data and the part of its reserve its live backups do not hold; a backup, all of it.
 */
const DIMENSION_SQL: {
  readonly [D in ResourceDomainBudgetDimension]: {
    readonly column: string;
    readonly charge: string;
  };
} = {
  cpuMillicores: { column: "cpu_millicores", charge: "a.cpu_millicores" },
  memoryBytes: { column: "memory_bytes", charge: "a.memory_bytes" },
  storageBytes: {
    column: "storage_bytes",
    charge: `case a.use
      when 'volume' then a.storage_bytes + greatest(0, a.protection_bytes - coalesce((
        select sum(p.protection_bytes) from resource_domain_allocations p
        where p.source_allocation_id = a.id and p.state <> 'released'), 0))
      when 'protection' then a.protection_bytes
      else 0 end`,
  },
};

/**
 * The budget row and the sums of its live allocations, in one statement, so they are one
 * snapshot. Every amount is text, exact whatever its size.
 */
const budgetStatement = (resourceDomainId: string) =>
  sql`select d.budget_revision::text as revision, ${sql.raw(
    DIMENSIONS.map((dimension) => {
      const { column } = DIMENSION_SQL[dimension];
      return `d.${column}::text as "limit_${dimension}",
        coalesce(sum(c.${dimension}) filter (where c.state in ('in-use', 'archived')), 0)::text as "used_${dimension}",
        coalesce(sum(c.${dimension}) filter (where c.state = 'reserved'), 0)::text as "reserved_${dimension}"`;
    }).join(",\n"),
  )},
    coalesce(sum(c.archived), 0)::text as archived,
    coalesce(sum(c.protection), 0)::text as protection
  from ${resourceDomains} d
  left join lateral (
    select a.state, ${sql.raw(
      DIMENSIONS.map((dimension) => `${DIMENSION_SQL[dimension].charge} as ${dimension}`).join(
        ", ",
      ),
    )},
      case when a.state = 'archived' then a.storage_bytes else 0 end as archived,
      case when a.use = 'protection' then a.protection_bytes else 0 end as protection
    from ${resourceDomainAllocations} a
    where a.resource_domain_id = d.id and a.state <> 'released'
  ) c on true
  where d.id = ${resourceDomainId}
  group by d.id`;

/** A budget read's amounts, exact. */
interface ResourceDomainBudgetAmounts {
  readonly revision: number;
  readonly limit: { readonly [D in ResourceDomainBudgetDimension]: bigint };
  readonly used: { readonly [D in ResourceDomainBudgetDimension]: bigint };
  readonly reserved: { readonly [D in ResourceDomainBudgetDimension]: bigint };
  readonly archived: bigint;
  readonly protection: bigint;
}

const amounts = (row: Readonly<Record<string, string>>): ResourceDomainBudgetAmounts => {
  const exact = (name: string) => BigInt(row[name] ?? "0");
  const each = (prefix: string) =>
    Rec.map(RESOURCE_DOMAIN_BUDGET_DIMENSIONS, (_, dimension) => exact(`${prefix}_${dimension}`));
  return {
    revision: Number(exact("revision")),
    limit: each("limit"),
    used: each("used"),
    reserved: each("reserved"),
    archived: exact("archived"),
    protection: exact("protection"),
  };
};

/**
 * The budget read as numbers. A charge never exceeds the largest limit it was admitted under, so
 * every amount is a safe integer.
 */
const numbers = (values: { readonly [D in ResourceDomainBudgetDimension]: bigint }) =>
  Rec.map(values, Number);

const toRecord = (read: ResourceDomainBudgetAmounts): ResourceDomainBudgetRecord => {
  return {
    budget: numbers(read.limit),
    revision: read.revision,
    charge: {
      used: numbers(read.used),
      reserved: numbers(read.reserved),
      archivedBytes: Number(read.archived),
      protectionBytes: Number(read.protection),
    },
  };
};

const sameBudget = (a: ResourceDomainBudget, b: ResourceDomainBudget) =>
  DIMENSIONS.every((dimension) => a[dimension] === b[dimension]);

/** Which events move an allocation, of which use, from which states, to which. */
const EVENTS: Record<
  ResourceDomainAllocationEvent,
  {
    readonly to: ResourceDomainAllocationState;
    readonly from: ReadonlyArray<ResourceDomainAllocationState>;
    readonly uses: ReadonlyArray<ResourceDomainAllocationUse>;
  }
> = {
  created: { to: "in-use", from: ["reserved"], uses: ["compute", "volume", "protection"] },
  archived: { to: "archived", from: ["in-use"], uses: ["volume"] },
  stopped: { to: "released", from: ["reserved", "in-use"], uses: ["compute"] },
  purged: {
    to: "released",
    from: ["reserved", "in-use", "archived"],
    uses: ["volume", "protection"],
  },
};

const MAX_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The row an admission writes, every amount zero where its use holds none, or `undefined` when an
 * amount is not a positive safe integer (a reserve may be zero) or a volume's data and reserve
 * together are not one.
 */
const allocationValues = (request: ResourceDomainAdmissionRequest) => {
  const values = {
    use: request.use,
    objectKey: request.objectKey,
    cpuMillicores: request.use === "compute" ? request.cpuMillicores : 0,
    memoryBytes: request.use === "compute" ? request.memoryBytes : 0,
    storageBytes: request.use === "volume" ? request.storageBytes : 0,
    protectionBytes: request.use === "compute" ? 0 : request.protectionBytes,
  };
  const positive =
    request.use === "compute"
      ? [values.cpuMillicores, values.memoryBytes]
      : request.use === "volume"
        ? [values.storageBytes]
        : [values.protectionBytes];
  const all = [
    values.cpuMillicores,
    values.memoryBytes,
    values.storageBytes,
    values.protectionBytes,
  ];
  return all.every((amount) => Number.isSafeInteger(amount) && amount >= 0) &&
    positive.every((amount) => amount > 0) &&
    BigInt(values.storageBytes) + BigInt(values.protectionBytes) <= MAX_AMOUNT
    ? values
    : undefined;
};

const sameAllocation = (
  row: ResourceDomainAllocationRecord,
  values: NonNullable<ReturnType<typeof allocationValues>>,
) =>
  row.use === values.use &&
  row.objectKey === values.objectKey &&
  row.cpuMillicores === values.cpuMillicores &&
  row.memoryBytes === values.memoryBytes &&
  row.storageBytes === values.storageBytes &&
  row.protectionBytes === values.protectionBytes;

const refused = (reason: Extract<ResourceDomainAdmission, { kind: "refused" }>["reason"]) =>
  ({ kind: "refused", reason }) as const;

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
      const personExists = (userId: string) =>
        Effect.map(
          db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1),
          (rows) => rows.length > 0,
        );
      const budgetOf = (resourceDomainId: string) =>
        Effect.map(
          db.execute<Readonly<Record<string, string>>>(
            budgetStatement(resourceDomainId),
            "objects",
          ),
          ([row]) => (row === undefined ? undefined : amounts(row)),
        );
      /**
       * Hold the domain row until the transaction ends, and answer its state. The first thing
       * `admit` and `record` do, so every holder takes the same locks in the same order.
       */
      const lockDomain = (resourceDomainId: string) =>
        Effect.gen(function* () {
          const [row] = yield* db
            .select({
              state: resourceDomains.state,
              isolation: sql<string>`current_setting('transaction_isolation')`,
            })
            .from(resourceDomains)
            .where(eq(resourceDomains.id, resourceDomainId))
            .for("no key update");
          if (row !== undefined && row.isolation !== "read committed") {
            return yield* Effect.fail(new Error(RESOURCE_DOMAIN_ADMISSION_ISOLATION));
          }
          return row?.state;
        });
      return {
        ensure: (key, budget) =>
          withError(
            "ensure",
            Effect.gen(function* () {
              const [inserted] = yield* db
                .insert(resourceDomains)
                .values({ id: `rdm:${randomUUID()}`, key, ...budget })
                .onConflictDoNothing({ target: resourceDomains.key })
                .returning(columns);
              if (inserted !== undefined) {
                return { kind: "ensured", domain: inserted, created: true } as const;
              }
              // Another call holds the key: answer its domain.
              const [existing] = yield* db
                .select({
                  ...columns,
                  revision: resourceDomains.budgetRevision,
                  ...Rec.map(
                    RESOURCE_DOMAIN_BUDGET_DIMENSIONS,
                    (_, dimension) => resourceDomains[dimension],
                  ),
                })
                .from(resourceDomains)
                .where(eq(resourceDomains.key, key))
                .limit(1);
              if (existing === undefined) {
                return yield* Effect.fail(new Error("The resource domain's key was not found."));
              }
              const domain = { id: existing.id, key: existing.key, createdAt: existing.createdAt };
              return budget === undefined || sameBudget(existing, budget)
                ? ({ kind: "ensured", domain, created: false } as const)
                : ({ kind: "budget-differs", domain, revision: existing.revision } as const);
            }),
          ),
        getBudget: (resourceDomainId) =>
          withError(
            "getBudget",
            Effect.map(budgetOf(resourceDomainId), (read) =>
              read === undefined ? undefined : toRecord(read),
            ),
          ),
        setBudget: ({ resourceDomainId, revision, budget }) =>
          withError(
            "setBudget",
            db.transaction(() =>
              Effect.gen(function* () {
                const [written] = yield* db
                  .update(resourceDomains)
                  .set({ ...budget, budgetRevision: sql`${resourceDomains.budgetRevision} + 1` })
                  .where(
                    and(
                      eq(resourceDomains.id, resourceDomainId),
                      eq(resourceDomains.budgetRevision, revision),
                    ),
                  )
                  .returning({ id: resourceDomains.id });
                // Written, the row stays this transaction's until it commits: the read is ours.
                const read = yield* budgetOf(resourceDomainId);
                if (read === undefined) return { kind: "no-such-domain" } as const;
                const record = toRecord(read);
                return written !== undefined ||
                  (record.revision === revision + 1 && sameBudget(record.budget, budget))
                  ? ({ kind: "set", record } as const)
                  : ({ kind: "stale", revision: record.revision } as const);
              }),
            ),
          ),
        admit: ({ resourceDomainId, operationKey, request }) =>
          withError(
            "admit",
            db.transaction(() =>
              Effect.gen(function* () {
                const values = allocationValues(request);
                if (values === undefined) return refused("invalid-amount");
                const state = yield* lockDomain(resourceDomainId);
                if (state === undefined) return { kind: "no-such-domain" } as const;
                const [prior] = yield* db
                  .select()
                  .from(resourceDomainAllocations)
                  .where(
                    and(
                      eq(resourceDomainAllocations.resourceDomainId, resourceDomainId),
                      eq(resourceDomainAllocations.operationKey, operationKey),
                    ),
                  );
                if (prior !== undefined) {
                  if (!sameAllocation(prior, values)) return refused("operation-key-reused");
                  return prior.state === "released"
                    ? refused("operation-released")
                    : ({ kind: "admitted", allocation: prior, replayed: true } as const);
                }
                if (state !== "active" && request.use !== "protection") {
                  return refused("domain-not-active");
                }
                const [held] = yield* db
                  .select({ id: resourceDomainAllocations.id })
                  .from(resourceDomainAllocations)
                  .where(
                    and(
                      eq(resourceDomainAllocations.resourceDomainId, resourceDomainId),
                      eq(resourceDomainAllocations.use, request.use),
                      eq(resourceDomainAllocations.objectKey, request.objectKey),
                      ne(resourceDomainAllocations.state, "released"),
                    ),
                  );
                if (held !== undefined) return refused("object-held");
                // A backup takes its volume's unused reserve first, and only the rest is new.
                let source: { readonly id: string; readonly unused: bigint } | undefined;
                if (request.use === "protection") {
                  const [volume] = yield* db.execute<{
                    readonly id: string;
                    readonly unused: string;
                  }>(
                    sql`select v.id, greatest(0, v.protection_bytes - coalesce(sum(p.protection_bytes), 0))::text as unused
                      from ${resourceDomainAllocations} v
                      left join ${resourceDomainAllocations} p
                        on p.source_allocation_id = v.id and p.state <> 'released'
                      where v.resource_domain_id = ${resourceDomainId} and v.use = 'volume'
                        and v.object_key = ${request.sourceObjectKey} and v.state <> 'released'
                      group by v.id`,
                    "objects",
                  );
                  if (volume === undefined) return refused("no-source-volume");
                  source = { id: volume.id, unused: BigInt(volume.unused) };
                }
                const read = yield* budgetOf(resourceDomainId);
                if (read === undefined) return { kind: "no-such-domain" } as const;
                const requested: { readonly [D in ResourceDomainBudgetDimension]: bigint } = {
                  cpuMillicores: BigInt(values.cpuMillicores),
                  memoryBytes: BigInt(values.memoryBytes),
                  storageBytes:
                    source === undefined
                      ? BigInt(values.storageBytes) + BigInt(values.protectionBytes)
                      : BigInt(values.protectionBytes) > source.unused
                        ? BigInt(values.protectionBytes) - source.unused
                        : 0n,
                };
                for (const dimension of DIMENSIONS) {
                  const [used, reserved, ask, limit] = [
                    read.used[dimension],
                    read.reserved[dimension],
                    requested[dimension],
                    read.limit[dimension],
                  ];
                  if (ask > 0n && used + reserved + ask > limit) {
                    return {
                      kind: "over-budget",
                      dimension,
                      used: Number(used),
                      reserved: Number(reserved),
                      requested: Number(ask),
                      limit: Number(limit),
                    } as const;
                  }
                }
                const [allocation] = yield* db
                  .insert(resourceDomainAllocations)
                  .values({
                    id: randomUUID(),
                    resourceDomainId,
                    operationKey,
                    sourceAllocationId: source?.id ?? null,
                    ...values,
                  })
                  .returning();
                if (allocation === undefined) {
                  return yield* Effect.fail(new Error("The allocation was not written."));
                }
                return { kind: "admitted", allocation, replayed: false } as const;
              }),
            ),
          ),
        record: ({ resourceDomainId, allocationId, event }) =>
          withError(
            "record",
            db.transaction(() =>
              Effect.gen(function* () {
                if ((yield* lockDomain(resourceDomainId)) === undefined) {
                  return { kind: "no-such-allocation" } as const;
                }
                const rule = EVENTS[event];
                const at = and(
                  eq(resourceDomainAllocations.id, allocationId),
                  eq(resourceDomainAllocations.resourceDomainId, resourceDomainId),
                );
                const [moved] = yield* db
                  .update(resourceDomainAllocations)
                  .set({ state: rule.to, updatedAt: sql`now()` })
                  .where(
                    and(
                      at,
                      inArray(resourceDomainAllocations.state, [...rule.from]),
                      inArray(resourceDomainAllocations.use, [...rule.uses]),
                    ),
                  )
                  .returning();
                if (moved !== undefined) return { kind: "recorded", allocation: moved } as const;
                const [current] = yield* db.select().from(resourceDomainAllocations).where(at);
                if (current === undefined) return { kind: "no-such-allocation" } as const;
                return current.state === rule.to && rule.uses.includes(current.use)
                  ? ({ kind: "recorded", allocation: current } as const)
                  : ({ kind: "refused", allocation: current } as const);
              }),
            ),
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
                if (!(yield* personExists(userId))) return { kind: "no-such-person" } as const;
                return yield* Effect.fail(new Error("The member's decision was not found."));
              }
              return repeats(current, decision)
                ? ({ kind: "decided", member: current } as const)
                : ({ kind: "stale", current } as const);
            }),
          ),
        getMember: (resourceDomainId, userId) =>
          withError(
            "getMember",
            Effect.gen(function* () {
              const [member] = yield* db
                .select(memberColumns)
                .from(resourceDomainMembers)
                .where(
                  and(
                    eq(resourceDomainMembers.resourceDomainId, resourceDomainId),
                    eq(resourceDomainMembers.userId, userId),
                  ),
                )
                .limit(1);
              if (member !== undefined) return { kind: "found", member } as const;
              const exists = yield* personExists(userId);
              return exists
                ? ({ kind: "no-decision" } as const)
                : ({ kind: "no-such-person" } as const);
            }),
          ),
        listMembers: ({ resourceDomainId, after, limit }) =>
          withError(
            "listMembers",
            Effect.map(
              db
                .select(memberColumns)
                .from(resourceDomainMembers)
                .where(
                  and(
                    eq(resourceDomainMembers.resourceDomainId, resourceDomainId),
                    after === undefined ? undefined : gt(resourceDomainMembers.userId, after),
                  ),
                )
                .orderBy(asc(resourceDomainMembers.userId))
                .limit(limit + 1),
              (rows) => {
                const members = rows.slice(0, limit);
                const last = members.at(-1);
                return rows.length > limit && last !== undefined
                  ? { members, next: last.userId }
                  : { members };
              },
            ),
          ),
      } satisfies ResourceDomainRepoService;
    }),
  );
