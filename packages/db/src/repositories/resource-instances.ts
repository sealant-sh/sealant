import { createHash, randomUUID } from "node:crypto";

import {
  RESOURCE_INSTANCE_ID_PREFIX,
  ResourceInstanceId,
  ResourceInstanceKey,
  ResourceWorktreeKey,
  type ResourceInstanceSpec,
  type ResourceInstanceState,
  type ResourceInstanceStopReason,
  type ResourceInstanceVolume,
} from "@sealant/api-contracts";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  resourceDomains,
  resourceInstances,
  resourceNetworks,
  resourceWorkspaceLinks,
  workspaceRunLinks,
  workspaceRuntimeInstances,
  workspaces,
  type ResourceDomainState,
  type ResourceInstanceDesired,
  type ResourceInstanceRow,
  type ResourceNetworkKind,
} from "../schema.js";

export class ResourceInstanceRepoError extends Schema.TaggedError<ResourceInstanceRepoError>()(
  "ResourceInstanceRepoError",
  {
    operation: Schema.Literals([
      "up",
      "get",
      "list",
      "setDesired",
      "recordObserved",
      "touchReached",
      "link",
      "unlink",
      "links",
      "linkedExecutors",
      "allocateNetwork",
      "releaseNetwork",
      "networks",
      "setDomainState",
    ]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface ResourceInstanceRecord {
  readonly id: ResourceInstanceId;
  readonly resourceDomainId: string;
  readonly key: ResourceInstanceKey;
  readonly spec: ResourceInstanceSpec;
  readonly specDigest: string;
  readonly desired: ResourceInstanceDesired;
  /** Set exactly while `desired` is `stopped`. */
  readonly stopReason: ResourceInstanceStopReason | null;
  readonly observed: ResourceInstanceState;
  readonly observedAt: Date;
  readonly volumes: ReadonlyArray<ResourceInstanceVolume>;
  readonly startedAt: Date | null;
  readonly lastReachedAt: Date | null;
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
}

/** Why `up` was asked: a launch or a wake (`use`), or a person's Start (`person`). */
export type ResourceInstanceUpCause = "use" | "person";

export type ResourceInstanceUpOutcome =
  /** Written. `desired` is `stopped` when a person stopped it and the cause was `use`. */
  | { readonly kind: "upserted"; readonly instance: ResourceInstanceRecord }
  | { readonly kind: "archived"; readonly instance: ResourceInstanceRecord }
  /** Another instance that is not archived holds this alias for the same worktree key. */
  | { readonly kind: "alias-taken" }
  | { readonly kind: "domain-not-active"; readonly state: Exclude<ResourceDomainState, "active"> }
  | { readonly kind: "no-such-domain" };

/** What is asked of an instance from now on. */
export type ResourceInstanceDesire =
  | { readonly kind: "run" }
  | { readonly kind: "stop"; readonly reason: ResourceInstanceStopReason }
  | { readonly kind: "archive" };

export interface ResourceWorkspaceLink {
  readonly workspaceId: string;
  readonly resourceDomainId: string;
  readonly worktreeKey: ResourceWorktreeKey;
}

/** A live executor of a linked workspace: the Docker container its reach network is named by. */
export interface LinkedExecutor extends ResourceWorkspaceLink {
  readonly executor: string;
}

export type ResourceWorkspaceLinkOutcome =
  | { readonly kind: "linked"; readonly link: ResourceWorkspaceLink }
  /** The workspace is linked to another domain; nothing changed. */
  | { readonly kind: "other-domain"; readonly resourceDomainId: string }
  | { readonly kind: "no-such-workspace" }
  | { readonly kind: "domain-not-active"; readonly state: Exclude<ResourceDomainState, "active"> }
  | { readonly kind: "no-such-domain" };

/** An IPv4 range Core carves into equal subnets for its networks. */
export interface SubnetPool {
  readonly base: number;
  readonly bits: number;
  readonly prefix: number;
}

export type NetworkAllocation =
  | { readonly kind: "allocated"; readonly subnet: string }
  | { readonly kind: "pool-exhausted" };

export interface ResourceInstanceRepoService {
  /**
   * Create the instance by key, or update its spec. `person` asks it to run and clears a stop;
   * `use` asks it to run unless a person stopped it. An archived key stays archived.
   */
  readonly up: (input: {
    readonly resourceDomainId: string;
    readonly key: ResourceInstanceKey;
    readonly spec: ResourceInstanceSpec;
    readonly cause: ResourceInstanceUpCause;
  }) => Effect.Effect<ResourceInstanceUpOutcome, ResourceInstanceRepoError>;
  readonly get: (
    resourceDomainId: string,
    key: ResourceInstanceKey,
  ) => Effect.Effect<ResourceInstanceRecord | undefined, ResourceInstanceRepoError>;
  /** The domain's instances, by key: the archived ones, or the ones that are not. */
  readonly list: (
    resourceDomainId: string,
    options: { readonly archived: boolean },
  ) => Effect.Effect<ReadonlyArray<ResourceInstanceRecord>, ResourceInstanceRepoError>;
  /** Every instance that is not archived, of every domain: the reconciler's input. */
  readonly listLive: () => Effect.Effect<
    ReadonlyArray<ResourceInstanceRecord>,
    ResourceInstanceRepoError
  >;
  /** Never moves an archived instance; answers the row as it is after, if it exists. */
  readonly setDesired: (
    id: ResourceInstanceId,
    desire: ResourceInstanceDesire,
  ) => Effect.Effect<ResourceInstanceRecord | undefined, ResourceInstanceRepoError>;
  /** What the runtime saw. A start that answered its ready check names `startedAt`. */
  readonly recordObserved: (
    id: ResourceInstanceId,
    observed: ResourceInstanceState,
    extra?: {
      readonly startedAt?: Date;
      readonly volumes?: ReadonlyArray<ResourceInstanceVolume>;
    },
  ) => Effect.Effect<void, ResourceInstanceRepoError>;
  readonly touchReached: (
    ids: ReadonlyArray<ResourceInstanceId>,
    at: Date,
  ) => Effect.Effect<void, ResourceInstanceRepoError>;
  /**
   * Link a workspace to a domain under a worktree key. Linking again, with this key or another,
   * answers the link as it is after; a workspace linked to another domain is refused.
   */
  readonly link: (
    link: ResourceWorkspaceLink,
  ) => Effect.Effect<ResourceWorkspaceLinkOutcome, ResourceInstanceRepoError>;
  readonly unlink: (workspaceId: string) => Effect.Effect<void, ResourceInstanceRepoError>;
  readonly links: (
    resourceDomainId: string,
  ) => Effect.Effect<ReadonlyArray<ResourceWorkspaceLink>, ResourceInstanceRepoError>;
  /** The link of the workspace a run belongs to, if it has one. */
  readonly linkOfRun: (
    runId: string,
  ) => Effect.Effect<ResourceWorkspaceLink | undefined, ResourceInstanceRepoError>;
  /**
   * The Docker executors of linked workspaces that are live (launching or ready, not finished),
   * of one domain or, without one, of every domain.
   */
  readonly linkedExecutors: (
    resourceDomainId?: string,
  ) => Effect.Effect<ReadonlyArray<LinkedExecutor>, ResourceInstanceRepoError>;
  /**
   * The network's subnet: the one it holds, or the lowest free one of the pool. Concurrent
   * allocations get distinct subnets (the unique subnet decides the race).
   */
  readonly allocateNetwork: (input: {
    readonly name: string;
    readonly kind: ResourceNetworkKind;
    readonly owner: string;
    readonly pool: SubnetPool;
  }) => Effect.Effect<NetworkAllocation, ResourceInstanceRepoError>;
  readonly releaseNetwork: (name: string) => Effect.Effect<void, ResourceInstanceRepoError>;
  readonly networks: (
    kind: ResourceNetworkKind,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly name: string; readonly owner: string; readonly subnet: string }>,
    ResourceInstanceRepoError
  >;
  readonly setDomainState: (
    resourceDomainId: string,
    state: ResourceDomainState,
  ) => Effect.Effect<void, ResourceInstanceRepoError>;
}

export class ResourceInstanceRepo extends Context.Service<
  ResourceInstanceRepo,
  ResourceInstanceRepoService
>()("ResourceInstanceRepo") {}

const ipv4 = (address: string): number | undefined => {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return undefined;
  }
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
};

const dotted = (value: number): string =>
  [24, 16, 8, 0].map((shift) => String(Math.floor(value / 2 ** shift) % 256)).join(".");

/** `10.231.0.0/16` carved into `/prefix` subnets. Throws on anything else: it is configuration. */
export const parseSubnetPool = (cidr: string, prefix: number): SubnetPool => {
  const [address, bitsText] = cidr.split("/");
  const base = address === undefined ? undefined : ipv4(address);
  const bits = Number(bitsText);
  if (base === undefined || !Number.isInteger(bits) || bits < 8 || bits > 30) {
    throw new Error(`${JSON.stringify(cidr)} is not an IPv4 range such as 10.231.0.0/16.`);
  }
  if (!Number.isInteger(prefix) || prefix <= bits || prefix > 29) {
    throw new Error(`A /${String(prefix)} subnet does not fit in ${cidr}.`);
  }
  if (base % 2 ** (32 - bits) !== 0) {
    throw new Error(`${cidr} has host bits set: write its network address.`);
  }
  return { base, bits, prefix };
};

const poolSize = (pool: SubnetPool): number => 2 ** (pool.prefix - pool.bits);
const subnetAt = (pool: SubnetPool, index: number): string =>
  `${dotted(pool.base + index * 2 ** (32 - pool.prefix))}/${String(pool.prefix)}`;

/** A JSON value with every object's keys in order, so equal values print equally. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, inner]) => [key, canonical(inner)]),
        )
      : value;

/** The spec's digest: sha256 of its JSON with keys sorted, so equal specs share it. */
export const resourceInstanceSpecDigest = (spec: ResourceInstanceSpec): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(spec)))
    .digest("hex")}`;

const withError = <A>(
  operation: ResourceInstanceRepoError["operation"],
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, ResourceInstanceRepoError> =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new ResourceInstanceRepoError({
          operation,
          message: cause instanceof Error ? cause.message : `${operation} failed.`,
          cause,
        }),
    ),
  );

/** Whether Postgres refused a write by the named constraint, anywhere in the error's chain. */
const namesConstraint = (error: unknown, constraint: string, depth = 0): boolean => {
  if (depth > 8 || typeof error !== "object" || error === null) return false;
  if ("constraint" in error && error.constraint === constraint) return true;
  const nested = Cause.isCause(error)
    ? error.reasons.flatMap((reason) => (Cause.isFailReason(reason) ? [reason.error] : []))
    : [...("cause" in error ? [error.cause] : []), ...("reason" in error ? [error.reason] : [])];
  return nested.some((next) => namesConstraint(next, constraint, depth + 1));
};

const toRecord = (row: ResourceInstanceRow): ResourceInstanceRecord => ({
  id: ResourceInstanceId.make(row.id),
  resourceDomainId: row.resourceDomainId,
  key: ResourceInstanceKey.make(row.key),
  spec: row.spec,
  specDigest: row.specDigest,
  desired: row.desired,
  stopReason: row.stopReason ?? null,
  observed: row.observed,
  observedAt: row.observedAt,
  volumes: row.volumes,
  startedAt: row.startedAt,
  lastReachedAt: row.lastReachedAt,
  createdAt: row.createdAt,
  archivedAt: row.archivedAt,
});

const linkColumns = {
  workspaceId: resourceWorkspaceLinks.workspaceId,
  resourceDomainId: resourceWorkspaceLinks.resourceDomainId,
  worktreeKey: resourceWorkspaceLinks.worktreeKey,
};

const toLink = (row: {
  readonly workspaceId: string;
  readonly resourceDomainId: string;
  readonly worktreeKey: string;
}): ResourceWorkspaceLink => ({
  workspaceId: row.workspaceId,
  resourceDomainId: row.resourceDomainId,
  worktreeKey: ResourceWorktreeKey.make(row.worktreeKey),
});

/** A person's stop holds against `use`: what `up` leaves standing when it is the cause. */
const heldByPerson = sql`${resourceInstances.desired} = 'stopped' and ${resourceInstances.stopReason}->>'kind' = 'person'`;

const ALLOCATION_ATTEMPTS = 32;

export const ResourceInstanceRepoLive: Layer.Layer<ResourceInstanceRepo, never, SealantDB> =
  Layer.effect(
    ResourceInstanceRepo,
    Effect.gen(function* () {
      const db = yield* SealantDB;
      const domainState = (resourceDomainId: string) =>
        Effect.map(
          db
            .select({ state: resourceDomains.state })
            .from(resourceDomains)
            .where(eq(resourceDomains.id, resourceDomainId))
            .limit(1),
          ([row]) => row?.state,
        );
      const selectInstance = (resourceDomainId: string, key: string) =>
        Effect.map(
          db
            .select()
            .from(resourceInstances)
            .where(
              and(
                eq(resourceInstances.resourceDomainId, resourceDomainId),
                eq(resourceInstances.key, key),
              ),
            )
            .limit(1),
          ([row]) => (row === undefined ? undefined : toRecord(row)),
        );

      const up: ResourceInstanceRepoService["up"] = ({ resourceDomainId, key, spec, cause }) =>
        withError(
          "up",
          Effect.gen(function* () {
            const state = yield* domainState(resourceDomainId);
            if (state === undefined) return { kind: "no-such-domain" } as const;
            if (state !== "active") return { kind: "domain-not-active", state } as const;
            const now = new Date();
            const written = {
              alias: spec.alias,
              worktreeKey: spec.worktreeKey,
              spec,
              specDigest: resourceInstanceSpecDigest(spec),
            };
            const desire =
              cause === "person"
                ? { desired: sql`'running'`, stopReason: sql`null` }
                : {
                    desired: sql`case when ${heldByPerson} then 'stopped' else 'running' end`,
                    stopReason: sql`case when ${heldByPerson} then ${resourceInstances.stopReason} else null end`,
                  };
            const [row] = yield* db
              .insert(resourceInstances)
              .values({
                id: `${RESOURCE_INSTANCE_ID_PREFIX}${randomUUID()}`,
                resourceDomainId,
                key,
                ...written,
              })
              .onConflictDoUpdate({
                target: [resourceInstances.resourceDomainId, resourceInstances.key],
                set: { ...written, ...desire, updatedAt: now },
                setWhere: ne(resourceInstances.desired, "archived"),
              })
              .returning()
              .pipe(
                Effect.catchIf(
                  (error) => namesConstraint(error, "resource_instances_alias_idx"),
                  () => Effect.succeed([]),
                ),
              );
            if (row !== undefined) {
              return { kind: "upserted", instance: toRecord(row) } as const;
            }
            const existing = yield* selectInstance(resourceDomainId, key);
            return existing?.desired === "archived"
              ? ({ kind: "archived", instance: existing } as const)
              : ({ kind: "alias-taken" } as const);
          }),
        );

      return {
        up,
        get: (resourceDomainId, key) => withError("get", selectInstance(resourceDomainId, key)),
        list: (resourceDomainId, { archived }) =>
          withError(
            "list",
            Effect.map(
              db
                .select()
                .from(resourceInstances)
                .where(
                  and(
                    eq(resourceInstances.resourceDomainId, resourceDomainId),
                    archived
                      ? eq(resourceInstances.desired, "archived")
                      : ne(resourceInstances.desired, "archived"),
                  ),
                )
                .orderBy(asc(resourceInstances.key)),
              (rows) => rows.map(toRecord),
            ),
          ),
        listLive: () =>
          withError(
            "list",
            Effect.map(
              db
                .select()
                .from(resourceInstances)
                .where(ne(resourceInstances.desired, "archived"))
                .orderBy(asc(resourceInstances.createdAt)),
              (rows) => rows.map(toRecord),
            ),
          ),
        setDesired: (id, desire) =>
          withError(
            "setDesired",
            Effect.gen(function* () {
              const now = new Date();
              const set =
                desire.kind === "run"
                  ? { desired: "running" as const, stopReason: null }
                  : desire.kind === "stop"
                    ? { desired: "stopped" as const, stopReason: desire.reason }
                    : { desired: "archived" as const, stopReason: null, archivedAt: now };
              const [row] = yield* db
                .update(resourceInstances)
                .set({ ...set, updatedAt: now })
                .where(and(eq(resourceInstances.id, id), ne(resourceInstances.desired, "archived")))
                .returning();
              if (row !== undefined) return toRecord(row);
              const [existing] = yield* db
                .select()
                .from(resourceInstances)
                .where(eq(resourceInstances.id, id));
              return existing === undefined ? undefined : toRecord(existing);
            }),
          ),
        recordObserved: (id, observed, extra) =>
          withError(
            "recordObserved",
            Effect.asVoid(
              db
                .update(resourceInstances)
                .set({
                  observed,
                  observedAt: new Date(),
                  ...(extra?.startedAt === undefined ? {} : { startedAt: extra.startedAt }),
                  ...(extra?.volumes === undefined ? {} : { volumes: extra.volumes }),
                })
                .where(
                  // Only the archive itself writes over an archived instance.
                  observed.kind === "archived"
                    ? eq(resourceInstances.id, id)
                    : and(eq(resourceInstances.id, id), ne(resourceInstances.desired, "archived")),
                ),
            ),
          ),
        touchReached: (ids, at) =>
          withError(
            "touchReached",
            ids.length === 0
              ? Effect.void
              : Effect.asVoid(
                  db
                    .update(resourceInstances)
                    .set({ lastReachedAt: at })
                    .where(inArray(resourceInstances.id, [...ids])),
                ),
          ),
        link: ({ workspaceId, resourceDomainId, worktreeKey }) =>
          withError(
            "link",
            Effect.gen(function* () {
              const state = yield* domainState(resourceDomainId);
              if (state === undefined) return { kind: "no-such-domain" } as const;
              if (state !== "active") return { kind: "domain-not-active", state } as const;
              const [workspace] = yield* db
                .select({ id: workspaces.id })
                .from(workspaces)
                .where(eq(workspaces.id, workspaceId))
                .limit(1);
              if (workspace === undefined) return { kind: "no-such-workspace" } as const;
              const [row] = yield* db
                .insert(resourceWorkspaceLinks)
                .values({ workspaceId, resourceDomainId, worktreeKey })
                .onConflictDoUpdate({
                  target: resourceWorkspaceLinks.workspaceId,
                  set: { worktreeKey, updatedAt: new Date() },
                  setWhere: eq(resourceWorkspaceLinks.resourceDomainId, resourceDomainId),
                })
                .returning(linkColumns);
              if (row !== undefined) return { kind: "linked", link: toLink(row) } as const;
              const [other] = yield* db
                .select(linkColumns)
                .from(resourceWorkspaceLinks)
                .where(eq(resourceWorkspaceLinks.workspaceId, workspaceId));
              if (other === undefined) {
                return yield* Effect.fail(new Error("The workspace's link was not found."));
              }
              return { kind: "other-domain", resourceDomainId: other.resourceDomainId } as const;
            }),
          ),
        unlink: (workspaceId) =>
          withError(
            "unlink",
            Effect.asVoid(
              db
                .delete(resourceWorkspaceLinks)
                .where(eq(resourceWorkspaceLinks.workspaceId, workspaceId)),
            ),
          ),
        links: (resourceDomainId) =>
          withError(
            "links",
            Effect.map(
              db
                .select(linkColumns)
                .from(resourceWorkspaceLinks)
                .where(eq(resourceWorkspaceLinks.resourceDomainId, resourceDomainId))
                .orderBy(asc(resourceWorkspaceLinks.workspaceId)),
              (rows) => rows.map(toLink),
            ),
          ),
        linkOfRun: (runId) =>
          withError(
            "links",
            Effect.map(
              db
                .select(linkColumns)
                .from(workspaceRunLinks)
                .innerJoin(
                  resourceWorkspaceLinks,
                  eq(resourceWorkspaceLinks.workspaceId, workspaceRunLinks.workspaceId),
                )
                .where(eq(workspaceRunLinks.runId, runId))
                .limit(1),
              ([row]) => (row === undefined ? undefined : toLink(row)),
            ),
          ),
        linkedExecutors: (resourceDomainId) =>
          withError(
            "linkedExecutors",
            Effect.map(
              db
                .select({ ...linkColumns, executor: workspaceRuntimeInstances.reference })
                .from(resourceWorkspaceLinks)
                .innerJoin(
                  workspaceRunLinks,
                  eq(workspaceRunLinks.workspaceId, resourceWorkspaceLinks.workspaceId),
                )
                .innerJoin(
                  workspaceRuntimeInstances,
                  eq(workspaceRuntimeInstances.runId, workspaceRunLinks.runId),
                )
                .where(
                  and(
                    resourceDomainId === undefined
                      ? undefined
                      : eq(resourceWorkspaceLinks.resourceDomainId, resourceDomainId),
                    eq(workspaceRuntimeInstances.adapter, "docker"),
                    inArray(workspaceRuntimeInstances.status, ["pending", "running", "ready"]),
                    isNull(workspaceRuntimeInstances.finishedAt),
                  ),
                )
                .orderBy(asc(workspaceRuntimeInstances.reference)),
              (rows) =>
                rows.flatMap(({ executor, ...link }) =>
                  executor === null ? [] : [{ ...toLink(link), executor }],
                ),
            ),
          ),
        allocateNetwork: ({ name, kind, owner, pool }) =>
          withError(
            "allocateNetwork",
            Effect.gen(function* () {
              for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt += 1) {
                const [held] = yield* db
                  .select({ subnet: resourceNetworks.subnet })
                  .from(resourceNetworks)
                  .where(eq(resourceNetworks.name, name));
                if (held !== undefined) return { kind: "allocated", subnet: held.subnet } as const;
                const taken = new Set(
                  (yield* db
                    .select({ subnet: resourceNetworks.subnet })
                    .from(resourceNetworks)).map((row) => row.subnet),
                );
                let subnet: string | undefined;
                for (let index = 0; index < poolSize(pool); index += 1) {
                  const candidate = subnetAt(pool, index);
                  if (!taken.has(candidate)) {
                    subnet = candidate;
                    break;
                  }
                }
                if (subnet === undefined) return { kind: "pool-exhausted" } as const;
                const [inserted] = yield* db
                  .insert(resourceNetworks)
                  .values({ name, kind, owner, subnet })
                  .onConflictDoNothing()
                  .returning({ subnet: resourceNetworks.subnet });
                if (inserted !== undefined) {
                  return { kind: "allocated", subnet: inserted.subnet } as const;
                }
              }
              return yield* Effect.fail(
                new Error(`No subnet could be allocated for ${name} after several attempts.`),
              );
            }),
          ),
        releaseNetwork: (name) =>
          withError(
            "releaseNetwork",
            Effect.asVoid(db.delete(resourceNetworks).where(eq(resourceNetworks.name, name))),
          ),
        networks: (kind) =>
          withError(
            "networks",
            db
              .select({
                name: resourceNetworks.name,
                owner: resourceNetworks.owner,
                subnet: resourceNetworks.subnet,
              })
              .from(resourceNetworks)
              .where(eq(resourceNetworks.kind, kind))
              .orderBy(asc(resourceNetworks.name)),
          ),
        setDomainState: (resourceDomainId, state) =>
          withError(
            "setDomainState",
            Effect.asVoid(
              db
                .update(resourceDomains)
                .set({ state })
                .where(eq(resourceDomains.id, resourceDomainId)),
            ),
          ),
      } satisfies ResourceInstanceRepoService;
    }),
  );
