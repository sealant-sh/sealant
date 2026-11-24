import type { BrokeredSecret, NetworkPolicy } from "@sealant/api-contracts";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import { workspaces } from "../schema/control-plane.js";
import { workspaceRuntimeInstances } from "../schema/workspace-build-jobs.js";
import {
  workspaceEgressPolicies,
  workspaceEgressProxies,
  workspaceEgressRevocations,
  type WorkspaceEgressPolicy,
  type WorkspaceEgressProxy,
  type WorkspaceEgressProxyNetwork,
  type WorkspaceEgressRevocation,
} from "../schema/workspace-egress.js";

/** Store errors never carry SQL, sealed values or key material. */
export class WorkspaceEgressRepoError extends Schema.TaggedError<WorkspaceEgressRepoError>()(
  "WorkspaceEgressRepoError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

const withRepoError = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new WorkspaceEgressRepoError({
          operation,
          message: cause instanceof Error ? cause.message : `${operation} failed.`,
        }),
    ),
  );

/** The revocations a policy at `revocationWatermark` must carry: everything stored up to it. */
export interface WorkspaceEgressTombstones {
  readonly revocationWatermark: number;
  readonly revokedSecretIds: readonly string[];
  readonly revokedHosts: readonly string[];
  readonly revokedAll: boolean;
}

export const tombstonesOf = (
  revocationWatermark: number,
  revocations: readonly WorkspaceEgressRevocation[],
): WorkspaceEgressTombstones => ({
  revocationWatermark,
  revokedSecretIds: [
    ...new Set(revocations.flatMap((r) => (r.kind === "secret" && r.target ? [r.target] : []))),
  ],
  revokedHosts: [
    ...new Set(revocations.flatMap((r) => (r.kind === "host" && r.target ? [r.target] : []))),
  ],
  revokedAll: revocations.some((r) => r.kind === "all"),
});

/** A run's proxy to keep alive: its row, and the workspace policy and revocations behind it. */
export interface LiveWorkspaceEgressProxy {
  readonly proxy: WorkspaceEgressProxy;
  readonly policy: WorkspaceEgressPolicy | undefined;
}

export interface WorkspaceEgressRepoService {
  readonly getPolicy: (
    workspaceId: string,
  ) => Effect.Effect<WorkspaceEgressPolicy | undefined, WorkspaceEgressRepoError>;
  /**
   * Pin `networkPolicy` and `brokeredSecrets` for the workspace, replacing what it had (its
   * revocations and watermark stay). `brokeredValuesSealed` replaces the sealed values too: null
   * when there are no brokered secrets.
   */
  readonly putPolicy: (input: {
    readonly workspaceId: string;
    readonly networkPolicy: NetworkPolicy | undefined;
    readonly brokeredSecrets: readonly BrokeredSecret[];
    readonly brokeredValuesSealed: string | undefined;
    readonly encryptionKeyId: string | undefined;
  }) => Effect.Effect<WorkspaceEgressPolicy, WorkspaceEgressRepoError>;
  /**
   * Store a revocation durably under the workspace's next watermark, before anything is told:
   * one row per secret id and host (and one for `all`), in one transaction with the bump.
   */
  readonly revoke: (input: {
    readonly workspaceId: string;
    readonly secretIds: readonly string[];
    readonly hosts: readonly string[];
    readonly all: boolean;
  }) => Effect.Effect<WorkspaceEgressTombstones, WorkspaceEgressRepoError>;
  /** Every revocation the workspace holds, oldest first. */
  readonly listRevocations: (
    workspaceId: string,
  ) => Effect.Effect<readonly WorkspaceEgressRevocation[], WorkspaceEgressRepoError>;
  /** The tombstones as of the workspace's current watermark. */
  readonly tombstones: (
    workspaceId: string,
  ) => Effect.Effect<WorkspaceEgressTombstones, WorkspaceEgressRepoError>;
  /**
   * The run's proxy row, created with this CA when the run has none: a launch delivered again
   * finds the row its first delivery wrote and keeps that CA (`created: false`), so a proxy
   * restarted under it presents the same certificate the workspace already trusts.
   */
  readonly ensureProxy: (input: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly proxyContainer: string;
    readonly adminSocketPath: string;
    readonly caCertPem: string;
    readonly caKeySealed: string;
    readonly encryptionKeyId: string;
    readonly caNotAfter: Date;
  }) => Effect.Effect<
    { readonly proxy: WorkspaceEgressProxy; readonly created: boolean },
    WorkspaceEgressRepoError
  >;
  readonly recordProxyNetwork: (
    runId: string,
    network: WorkspaceEgressProxyNetwork,
  ) => Effect.Effect<void, WorkspaceEgressRepoError>;
  readonly getProxy: (
    runId: string,
  ) => Effect.Effect<WorkspaceEgressProxy | undefined, WorkspaceEgressRepoError>;
  /**
   * What the proxy confirmed taking. Never moves the confirmed watermark backwards: a slow
   * confirmation of an older push does not hide a newer revocation still unconfirmed.
   */
  readonly confirmProxy: (input: {
    readonly runId: string;
    readonly policyHash: string | undefined;
    readonly revocationWatermark: number;
  }) => Effect.Effect<void, WorkspaceEgressRepoError>;
  /** The proxy of each workspace's current run whose executor is up. */
  readonly listLiveProxies: () => Effect.Effect<
    readonly LiveWorkspaceEgressProxy[],
    WorkspaceEgressRepoError
  >;
}

export class WorkspaceEgressRepo extends Context.Service<
  WorkspaceEgressRepo,
  WorkspaceEgressRepoService
>()("@sealant/db/WorkspaceEgressRepo") {}

/** The runtime statuses whose executor may be running, so its proxy needs keeping alive. */
const LIVE_STATUSES = ["pending", "running", "ready"] as const;

const make: Effect.Effect<WorkspaceEgressRepoService, never, SealantDB> = Effect.gen(function* () {
  const db = yield* SealantDB;

  const getPolicy = (workspaceId: string) =>
    withRepoError(
      "getPolicy",
      db
        .select()
        .from(workspaceEgressPolicies)
        .where(eq(workspaceEgressPolicies.workspaceId, workspaceId))
        .pipe(Effect.map(([row]) => row)),
    );

  const listRevocations = (workspaceId: string) =>
    withRepoError(
      "listRevocations",
      db
        .select()
        .from(workspaceEgressRevocations)
        .where(eq(workspaceEgressRevocations.workspaceId, workspaceId))
        .orderBy(asc(workspaceEgressRevocations.id)),
    );

  return WorkspaceEgressRepo.of({
    getPolicy,
    listRevocations,
    putPolicy: (input) =>
      withRepoError(
        "putPolicy",
        db
          .insert(workspaceEgressPolicies)
          .values({
            workspaceId: input.workspaceId,
            networkPolicy: input.networkPolicy ?? null,
            brokeredSecrets: input.brokeredSecrets,
            brokeredValuesSealed: input.brokeredValuesSealed ?? null,
            encryptionKeyId: input.encryptionKeyId ?? null,
          })
          .onConflictDoUpdate({
            target: workspaceEgressPolicies.workspaceId,
            set: {
              networkPolicy: input.networkPolicy ?? null,
              brokeredSecrets: input.brokeredSecrets,
              brokeredValuesSealed: input.brokeredValuesSealed ?? null,
              encryptionKeyId: input.encryptionKeyId ?? null,
              updatedAt: new Date(),
            },
          })
          .returning()
          .pipe(
            Effect.flatMap(([row]) =>
              row === undefined ? Effect.fail(new Error("no row written")) : Effect.succeed(row),
            ),
          ),
      ),
    revoke: (input) =>
      withRepoError(
        "revoke",
        db.transaction(() =>
          Effect.gen(function* () {
            // The row is the watermark's lock: two revocations of one workspace take turns.
            yield* db
              .insert(workspaceEgressPolicies)
              .values({ workspaceId: input.workspaceId })
              .onConflictDoNothing();
            const [bumped] = yield* db
              .update(workspaceEgressPolicies)
              .set({
                revocationWatermark: sql`${workspaceEgressPolicies.revocationWatermark} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(workspaceEgressPolicies.workspaceId, input.workspaceId))
              .returning({ revocationWatermark: workspaceEgressPolicies.revocationWatermark });
            if (bumped === undefined) return yield* Effect.fail(new Error("no policy row"));
            const watermark = bumped.revocationWatermark;
            const rows = [...new Set(input.secretIds.map((id) => id.trim()))].map((target) => ({
              kind: "secret" as const,
              target,
            }));
            const hosts = [...new Set(input.hosts.map((host) => host.trim().toLowerCase()))].map(
              (target) => ({ kind: "host" as const, target }),
            );
            const all = input.all ? [{ kind: "all" as const, target: null }] : [];
            yield* db.insert(workspaceEgressRevocations).values(
              [...rows, ...hosts, ...all].map((row) => ({
                workspaceId: input.workspaceId,
                revocationWatermark: watermark,
                kind: row.kind,
                target: row.target,
              })),
            );
            const revocations = yield* db
              .select()
              .from(workspaceEgressRevocations)
              .where(eq(workspaceEgressRevocations.workspaceId, input.workspaceId));
            return tombstonesOf(watermark, revocations);
          }),
        ),
      ),
    tombstones: (workspaceId) =>
      Effect.gen(function* () {
        const policy = yield* getPolicy(workspaceId);
        const revocations = yield* listRevocations(workspaceId);
        return tombstonesOf(policy?.revocationWatermark ?? 0, revocations);
      }),
    ensureProxy: (input) =>
      withRepoError(
        "ensureProxy",
        Effect.gen(function* () {
          const inserted = yield* db
            .insert(workspaceEgressProxies)
            .values(input)
            .onConflictDoNothing()
            .returning();
          const [created] = inserted;
          if (created !== undefined) return { proxy: created, created: true };
          const [existing] = yield* db
            .select()
            .from(workspaceEgressProxies)
            .where(eq(workspaceEgressProxies.runId, input.runId));
          if (existing === undefined) return yield* Effect.fail(new Error("no proxy row"));
          return { proxy: existing, created: false };
        }),
      ),
    recordProxyNetwork: (runId, network) =>
      withRepoError(
        "recordProxyNetwork",
        db
          .update(workspaceEgressProxies)
          .set({ network, updatedAt: new Date() })
          .where(eq(workspaceEgressProxies.runId, runId))
          .pipe(Effect.asVoid),
      ),
    getProxy: (runId) =>
      withRepoError(
        "getProxy",
        db
          .select()
          .from(workspaceEgressProxies)
          .where(eq(workspaceEgressProxies.runId, runId))
          .pipe(Effect.map(([row]) => row)),
      ),
    confirmProxy: (input) =>
      withRepoError(
        "confirmProxy",
        db
          .update(workspaceEgressProxies)
          .set({
            ...(input.policyHash === undefined ? {} : { confirmedPolicyHash: input.policyHash }),
            confirmedRevocationWatermark: input.revocationWatermark,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(workspaceEgressProxies.runId, input.runId),
              or(
                isNull(workspaceEgressProxies.confirmedRevocationWatermark),
                lte(workspaceEgressProxies.confirmedRevocationWatermark, input.revocationWatermark),
              ),
            ),
          )
          .pipe(Effect.asVoid),
      ),
    listLiveProxies: () =>
      withRepoError(
        "listLiveProxies",
        db
          .select({ proxy: workspaceEgressProxies, policy: workspaceEgressPolicies })
          .from(workspaceEgressProxies)
          .innerJoin(workspaces, eq(workspaces.latestRunId, workspaceEgressProxies.runId))
          .innerJoin(
            workspaceRuntimeInstances,
            eq(workspaceRuntimeInstances.runId, workspaceEgressProxies.runId),
          )
          .leftJoin(
            workspaceEgressPolicies,
            eq(workspaceEgressPolicies.workspaceId, workspaceEgressProxies.workspaceId),
          )
          .where(inArray(workspaceRuntimeInstances.status, [...LIVE_STATUSES]))
          .pipe(
            Effect.map((rows) =>
              rows.map((row) => ({ proxy: row.proxy, policy: row.policy ?? undefined })),
            ),
          ),
      ),
  });
});

export const workspaceEgressRepoLayer: Layer.Layer<WorkspaceEgressRepo, never, SealantDB> =
  Layer.effect(WorkspaceEgressRepo, make);
