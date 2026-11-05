import { createHash, randomUUID } from "node:crypto";

import { workspacePublicationSchema } from "@sealant/validators";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import { Effect, Schema } from "effect";

import type { DB } from "../client.js";
import {
  boatSnapshotAllowanceObservations as allowances,
  captureExecutorIncarnations as incarnations,
  captureParkingCloses as closes,
  captureCapsulePreparations as capsules,
  captureSnapshotSaves as saves,
  captureRecoveryCreates as creates,
  captureRecoveryAdmissions as admissions,
  captureSnapshotRetirements as retirements,
  capturePreservationOperations as operations,
  capturePreservationReceipts as receipts,
  captureRecoveryArtifacts as artifacts,
  captureRetentionEpisodes as episodes,
  captureSandboxRemovals as removals,
} from "../schema/capture-preservation.js";
import { nativePublicationConsumers } from "../schema/native-publications.js";
import {
  workspaceCaptureDrains as roots,
  workspaceRuntimeInstances,
} from "../schema/workspace-build-jobs.js";

const nonempty = Schema.String.check(Schema.isMinLength(1));
const uuid = Schema.String.check(Schema.isUUID());
const digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const policyInput = Schema.Struct({
  retainedParkingDelaySeconds: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 300, maximum: 604800 })),
  ),
  automaticParkingEnabled: Schema.optionalKey(Schema.Boolean),
});
const sourceInput = Schema.Struct({
  runId: nonempty,
  deploymentId: nonempty,
  accountScope: nonempty,
  sandboxId: nonempty,
  diskBindingId: uuid,
  allocationOperationId: uuid,
  publicationId: uuid,
  captureLaunchId: nonempty,
  guestEpoch: uuid,
  guestManifestHash: digest,
});
const observationInput = Schema.Struct({
  runId: nonempty,
  receiptId: uuid,
  operationId: uuid,
  sandboxId: nonempty,
  kind: Schema.Literals(["unknown", "pending", "removal-completed"]),
  providerOperationId: Schema.optionalKey(nonempty),
  observedAt: Schema.Date,
});
const computeInput = Schema.Struct({
  runId: nonempty,
  incarnationId: uuid,
  sandboxId: nonempty,
  state: Schema.Literals(["running", "not-running"]),
  observedAt: Schema.Date,
});
const rootSchema = createSelectSchema(roots);
const incarnationSchema = createSelectSchema(incarnations);
const episodeSchema = createSelectSchema(episodes);
const artifactSchema = createSelectSchema(artifacts);
const operationSchema = createSelectSchema(operations);
const removalSchema = createSelectSchema(removals);
const receiptSchema = createSelectSchema(receipts);
const allowanceSchema = createSelectSchema(allowances);
const closeSchema = createSelectSchema(closes);
const capsuleSchema = createSelectSchema(capsules);
const saveSchema = createSelectSchema(saves);
const createSchema = createSelectSchema(creates);
const admissionSchema = createSelectSchema(admissions);
const retirementSchema = createSelectSchema(retirements);

/** Store failures and rejected serialized inputs never imply a successful custody transition. */
export class CapturePreservationError extends Schema.TaggedError<CapturePreservationError>()(
  "CapturePreservationError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["store-unavailable", "invalid-input", "record-invalid"]),
  },
) {
  override get message(): string {
    return `Capture preservation ${this.operation}: ${this.reason}`;
  }
}

/** A claim authorizes database decisions only. It is never a provider dispatch permit. */
export interface CapturePreservationClaim {
  readonly runId: string;
  readonly token: string;
  readonly fence: number;
  readonly revision: number;
}

export interface CapturePreservationFacts {
  readonly version: 1;
  readonly runId: string;
  readonly revision: number;
  readonly desired: "preserve" | "recover" | "discard";
  readonly state: "retained" | "parking" | "parked" | "recovering" | "unknown";
  readonly snapshotOnly: boolean;
  readonly retainedSince: string;
  readonly parkingEligibleAt: string;
  readonly parkingDelaySeconds: number;
  readonly policyRevision: string;
  readonly currentIncarnationId: string;
  readonly vms: readonly {
    readonly id: string;
    readonly incarnationId: string;
    readonly role: "source" | "recovery";
    readonly compute:
      | {
          readonly state: "running" | "not-running";
          readonly observedAt: string;
          readonly basis: "provider-running" | "provider-stopped" | "completed-removal";
        }
      | {
          readonly state: "unknown";
          readonly reason: "not-observed" | "stale" | "removal-unresolved";
          readonly lastObserved?: {
            readonly state: "running" | "not-running";
            readonly observedAt: string;
            readonly basis: "provider-running" | "provider-stopped";
          };
        };
    readonly removal: "not-issued" | "unresolved" | "completed";
  }[];
  readonly snapshots: readonly {
    readonly name: string;
    readonly snapshotId?: string;
    readonly sourceVmId: string;
    readonly state: "reserved" | "saving" | "verified" | "retiring" | "removed" | "unknown";
    readonly privacy: "verified-private" | "unknown";
  }[];
  readonly operations: readonly {
    readonly id: string;
    readonly kind: string;
    readonly state: "prepared" | "issued" | "unknown" | "settled";
  }[];
  readonly allowance: {
    readonly state: "observed" | "unknown";
    readonly reason?: "not-observed" | "stale";
    readonly lastObserved?: {
      readonly scope: string;
      readonly included: number;
      readonly used: number;
      readonly extra: number;
      readonly extraDailyDollars: number;
      readonly observedAt: string;
    };
  };
  readonly blockers: readonly string[];
}

type Decision =
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "claim-lost" }
  | { readonly kind: "stale-evidence" }
  | { readonly kind: "observe-only" };

export interface CapturePreservationStore {
  readonly enrollSource: (
    input: unknown,
    policy?: unknown,
  ) => Effect.Effect<string, CapturePreservationError>;
  readonly markRetained: (input: {
    readonly runId: string;
    readonly reason: string;
    readonly policy?: unknown;
  }) => Effect.Effect<void, CapturePreservationError>;
  readonly read: (
    runId: string,
  ) => Effect.Effect<CapturePreservationFacts | undefined, CapturePreservationError>;
  readonly claim: (
    runId: string,
  ) => Effect.Effect<CapturePreservationClaim | undefined, CapturePreservationError>;
  readonly claimDue: (
    limit: number,
  ) => Effect.Effect<readonly CapturePreservationClaim[], CapturePreservationError>;
  readonly release: (
    claim: CapturePreservationClaim,
  ) => Effect.Effect<void, CapturePreservationError>;
  readonly renew: (
    claim: CapturePreservationClaim,
  ) => Effect.Effect<boolean, CapturePreservationError>;
  readonly reserveClose: (
    claim: CapturePreservationClaim,
    policy?: unknown,
  ) => Effect.Effect<
    Decision | { readonly kind: "reserved"; readonly operationId: string },
    CapturePreservationError
  >;
  readonly issue: (
    claim: CapturePreservationClaim,
    operationId: string,
  ) => Effect.Effect<Decision, CapturePreservationError>;
  readonly observe: (
    input: unknown,
  ) => Effect.Effect<
    "recorded" | "duplicate" | "conflict" | "unknown-effect",
    CapturePreservationError
  >;
  readonly recordCompute: (input: unknown) => Effect.Effect<boolean, CapturePreservationError>;
}

const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const parse = <A>(
  schema: Schema.Codec<A>,
  input: unknown,
  operation: string,
  reason: "invalid-input" | "record-invalid",
) =>
  Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new CapturePreservationError({ operation, reason })),
  );
const boundary = <A>(
  operation: string,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, CapturePreservationError> =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof CapturePreservationError
        ? error
        : new CapturePreservationError({ operation, reason: "store-unavailable" }),
    ),
  );
const policy = (input: unknown) =>
  parse(policyInput, input === undefined ? {} : input, "policy", "invalid-input").pipe(
    Effect.map((value) => ({
      delay: value.retainedParkingDelaySeconds ?? 3600,
      enabled: value.automaticParkingEnabled ?? true,
    })),
  );
const claimFence = (claim: CapturePreservationClaim) =>
  and(
    eq(roots.runId, claim.runId),
    eq(roots.preservationClaimToken, claim.token),
    eq(roots.preservationClaimFence, claim.fence),
    sql`${roots.preservationClaimUntil} > now()`,
  );
const leaseUntil = sql`now() + interval '120 seconds'`;
const available = sql`${roots.custodyContract} = 3 and ${roots.retentionEpisodeId} is not null and (${roots.preservationClaimUntil} is null or ${roots.preservationClaimUntil} <= now()) and ${roots.leaseOwner} is null and ${roots.recoveryLeaseToken} is null and ${roots.deletionState} is null`;

/** Adds child transactions to the canonical owner. No returned value can dispatch an effect. */
export const makeCapturePreservationStore = (
  db: DB,
  markWriter: (tx: Pick<DB, "execute">) => Effect.Effect<unknown, unknown>,
): CapturePreservationStore => {
  const lock = (runId: string) =>
    db.select().from(roots).where(eq(roots.runId, runId)).for("update");
  const claimed = (claim: CapturePreservationClaim) =>
    db.select().from(roots).where(claimFence(claim)).for("update");
  const takeClaim = (runId: string) =>
    Effect.gen(function* () {
      const token = randomUUID();
      const [row] = yield* db
        .update(roots)
        .set({
          preservationClaimToken: token,
          preservationClaimUntil: leaseUntil,
          preservationClaimFence: sql`${roots.preservationClaimFence} + 1`,
        })
        .where(and(eq(roots.runId, runId), available))
        .returning();
      return row === undefined
        ? undefined
        : { runId, token, fence: row.preservationClaimFence, revision: row.custodyRevision };
    });
  const read = (runId: string) =>
    db.transaction(() =>
      Effect.gen(function* () {
        const [raw] = yield* lock(runId);
        if (raw === undefined || raw.custodyContract === null || raw.retentionEpisodeId === null)
          return undefined;
        const root = yield* parse(rootSchema, raw, "read-root", "record-invalid");
        const [episodeRaw] = yield* db
          .select()
          .from(episodes)
          .where(and(eq(episodes.runId, runId), eq(episodes.id, raw.retentionEpisodeId)));
        const episode = yield* parse(episodeSchema, episodeRaw, "read-episode", "record-invalid");
        const instances = yield* Effect.forEach(
          yield* db.select().from(incarnations).where(eq(incarnations.runId, runId)),
          (row) => parse(incarnationSchema, row, "read-incarnations", "record-invalid"),
        );
        const saved = yield* Effect.forEach(
          yield* db.select().from(artifacts).where(eq(artifacts.runId, runId)),
          (row) => parse(artifactSchema, row, "read-artifacts", "record-invalid"),
        );
        const effects = yield* Effect.forEach(
          yield* db.select().from(operations).where(eq(operations.runId, runId)),
          (row) => parse(operationSchema, row, "read-operations", "record-invalid"),
        );
        const [clock] = yield* db
          .select({ now: sql<string>`now()::text` })
          .from(roots)
          .where(eq(roots.runId, runId));
        const now = new Date(clock?.now ?? "invalid").getTime();
        const current = instances.find((instance) => instance.id === root.currentIncarnationId);
        if (
          current === undefined ||
          !Number.isFinite(now) ||
          episode.dischargedAt !== null ||
          root.custodyContract !== 3 ||
          root.retainedAt?.getTime() !== episode.retainedAt.getTime()
        )
          return yield* Effect.fail(
            new CapturePreservationError({ operation: "read-bindings", reason: "record-invalid" }),
          );
        for (const artifact of saved) {
          const source = instances.find((instance) => instance.id === artifact.sourceIncarnationId);
          if (
            source === undefined ||
            source.accountScope !== artifact.accountScope ||
            artifact.episodeId !== episode.id
          )
            return yield* Effect.fail(
              new CapturePreservationError({
                operation: "read-artifact-binding",
                reason: "record-invalid",
              }),
            );
        }
        for (const operation of effects) {
          const subject = instances.find((instance) => instance.id === operation.incarnationId);
          let bound = subject !== undefined && operation.episodeId === episode.id;
          switch (operation.kind) {
            case "close-writer": {
              const [row] = yield* db
                .select()
                .from(closes)
                .where(and(eq(closes.runId, runId), eq(closes.operationId, operation.id)));
              const detail = yield* parse(closeSchema, row, "read-close", "record-invalid");
              bound =
                bound &&
                detail.diskBindingId === subject?.diskBindingId &&
                detail.guestEpoch === subject?.guestEpoch &&
                detail.guestManifestHash === subject?.guestManifestHash &&
                detail.policyRevision === episode.policyRevision;
              break;
            }
            case "prepare-capsule": {
              const [row] = yield* db
                .select()
                .from(capsules)
                .where(and(eq(capsules.runId, runId), eq(capsules.operationId, operation.id)));
              const detail = yield* parse(capsuleSchema, row, "read-capsule", "record-invalid");
              bound =
                bound &&
                effects.some(
                  (prior) =>
                    prior.id === detail.closeOperationId &&
                    prior.kind === "close-writer" &&
                    prior.incarnationId === operation.incarnationId &&
                    prior.episodeId === episode.id,
                );
              break;
            }
            case "save-snapshot": {
              const [row] = yield* db
                .select()
                .from(saves)
                .where(and(eq(saves.runId, runId), eq(saves.operationId, operation.id)));
              const detail = yield* parse(saveSchema, row, "read-save", "record-invalid");
              bound =
                bound &&
                saved.some(
                  (artifact) =>
                    artifact.id === detail.artifactId &&
                    artifact.sourceIncarnationId === operation.incarnationId,
                ) &&
                effects.some(
                  (prior) =>
                    prior.id === detail.capsuleOperationId &&
                    prior.kind === "prepare-capsule" &&
                    prior.incarnationId === operation.incarnationId,
                );
              break;
            }
            case "remove-sandbox": {
              const [row] = yield* db
                .select()
                .from(removals)
                .where(and(eq(removals.runId, runId), eq(removals.operationId, operation.id)));
              const detail = yield* parse(removalSchema, row, "read-removal", "record-invalid");
              bound =
                bound &&
                detail.sandboxId === subject?.sandboxId &&
                (detail.basis !== "verified-recovery-custody" ||
                  (saved.some(
                    (artifact) =>
                      artifact.id === detail.artifactId &&
                      artifact.sourceIncarnationId === operation.incarnationId,
                  ) &&
                    effects.some(
                      (prior) =>
                        prior.id === detail.closeOperationId &&
                        prior.kind === "close-writer" &&
                        prior.incarnationId === operation.incarnationId,
                    )));
              break;
            }
            case "create-recovery": {
              const [row] = yield* db
                .select()
                .from(creates)
                .where(and(eq(creates.runId, runId), eq(creates.operationId, operation.id)));
              const detail = yield* parse(createSchema, row, "read-create", "record-invalid");
              const child = instances.find(
                (instance) => instance.id === detail.destinationIncarnationId,
              );
              bound =
                bound &&
                saved.some(
                  (artifact) =>
                    artifact.id === detail.artifactId &&
                    artifact.sourceIncarnationId === operation.incarnationId,
                ) &&
                effects.some(
                  (prior) =>
                    prior.id === detail.sourceRemovalOperationId &&
                    prior.kind === "remove-sandbox" &&
                    prior.incarnationId === operation.incarnationId &&
                    prior.state === "settled",
                ) &&
                (child === undefined ||
                  (child.parentIncarnationId === operation.incarnationId &&
                    child.sourceArtifactId === detail.artifactId &&
                    child.runtimeInstanceId === detail.destinationRuntimeInstanceId &&
                    child.allocationOperationId === operation.id));
              break;
            }
            case "admit-recovery": {
              const [row] = yield* db
                .select()
                .from(admissions)
                .where(and(eq(admissions.runId, runId), eq(admissions.operationId, operation.id)));
              const detail = yield* parse(admissionSchema, row, "read-admission", "record-invalid");
              bound =
                bound &&
                subject?.allocationOperationId === detail.createOperationId &&
                subject.guestEpoch === detail.guestEpoch;
              break;
            }
            case "retire-snapshot": {
              const [row] = yield* db
                .select()
                .from(retirements)
                .where(
                  and(eq(retirements.runId, runId), eq(retirements.operationId, operation.id)),
                );
              const detail = yield* parse(
                retirementSchema,
                row,
                "read-retirement",
                "record-invalid",
              );
              bound =
                bound &&
                saved.some(
                  (artifact) =>
                    artifact.id === detail.artifactId &&
                    artifact.sourceIncarnationId === operation.incarnationId,
                );
              break;
            }
          }
          if (!bound)
            return yield* Effect.fail(
              new CapturePreservationError({
                operation: "read-operation-binding",
                reason: "record-invalid",
              }),
            );
        }
        const unresolved = effects.filter((op) => op.state === "issued" || op.state === "unknown");
        const recovering = effects.some(
          (op) =>
            (op.kind === "create-recovery" || op.kind === "admit-recovery") &&
            op.state !== "settled",
        );
        const verified = saved.some((artifact) => artifact.state === "verified");
        const allRemoved =
          instances.length > 0 && instances.every((instance) => instance.removedAt !== null);
        const parked =
          verified && allRemoved && effects.every((op) => op.state === "settled") && !recovering;
        const lost = allRemoved && !verified && !recovering;
        const state =
          root.preservationQuarantine !== null || lost
            ? "unknown"
            : recovering
              ? "recovering"
              : parked
                ? "parked"
                : effects.length > 0
                  ? "parking"
                  : "retained";
        const vms: CapturePreservationFacts["vms"] = instances.map((instance) => {
          const removal = unresolved.some(
            (op) => op.kind === "remove-sandbox" && op.incarnationId === instance.id,
          );
          const at = instance.computeObservedAt;
          const lastObserved =
            at === null || instance.computeState === "unknown"
              ? undefined
              : {
                  state: instance.computeState,
                  observedAt: at.toISOString(),
                  basis:
                    instance.computeState === "running"
                      ? ("provider-running" as const)
                      : ("provider-stopped" as const),
                };
          const compute: CapturePreservationFacts["vms"][number]["compute"] =
            instance.removedAt !== null
              ? {
                  state: "not-running",
                  observedAt: instance.removedAt.toISOString(),
                  basis: "completed-removal",
                }
              : removal
                ? {
                    state: "unknown",
                    reason: "removal-unresolved",
                    ...(lastObserved === undefined ? {} : { lastObserved }),
                  }
                : lastObserved === undefined
                  ? { state: "unknown", reason: "not-observed" }
                  : now - new Date(lastObserved.observedAt).getTime() > 120000
                    ? { state: "unknown", reason: "stale", lastObserved }
                    : lastObserved;
          return {
            id: instance.sandboxId,
            incarnationId: instance.id,
            role: instance.parentIncarnationId === null ? "source" : "recovery",
            compute,
            removal:
              instance.removedAt !== null ? "completed" : removal ? "unresolved" : "not-issued",
          };
        });
        const [allowanceRaw] = yield* db
          .select()
          .from(allowances)
          .where(eq(allowances.accountScope, current.accountScope));
        const allowance =
          allowanceRaw === undefined
            ? undefined
            : yield* parse(allowanceSchema, allowanceRaw, "read-allowance", "record-invalid");
        return {
          version: 1,
          runId,
          revision: root.custodyRevision,
          desired: root.preservationDesired,
          state,
          snapshotOnly: state === "parked",
          retainedSince: episode.retainedAt.toISOString(),
          parkingEligibleAt: episode.eligibleAt.toISOString(),
          parkingDelaySeconds: episode.delaySeconds,
          policyRevision: episode.policyRevision,
          currentIncarnationId: current.id,
          vms,
          snapshots: saved.map((artifact) => ({
            name: artifact.name,
            ...(artifact.snapshotId === null ? {} : { snapshotId: artifact.snapshotId }),
            sourceVmId:
              instances.find((instance) => instance.id === artifact.sourceIncarnationId)
                ?.sandboxId ?? "unknown",
            state: artifact.state,
            privacy:
              artifact.state === "verified" ? ("verified-private" as const) : ("unknown" as const),
          })),
          operations: effects.map((op) => ({ id: op.id, kind: op.kind, state: op.state })),
          allowance:
            allowance === undefined
              ? { state: "unknown", reason: "not-observed" }
              : {
                  state: now - allowance.observedAt.getTime() <= 300000 ? "observed" : "unknown",
                  ...(now - allowance.observedAt.getTime() > 300000
                    ? { reason: "stale" as const }
                    : {}),
                  lastObserved: {
                    scope: allowance.accountScope,
                    included: allowance.included,
                    used: allowance.used,
                    extra: allowance.extra,
                    extraDailyDollars: allowance.extraDailyDollars,
                    observedAt: allowance.observedAt.toISOString(),
                  },
                },
          blockers: [
            ...(root.preservationQuarantine === null ? [] : [root.preservationQuarantine]),
            ...(lost ? ["source-loss"] : []),
            "executor-unavailable",
            "guest-custody-unavailable",
            ...unresolved.map((op) => `${op.kind}-unresolved`),
          ],
        } satisfies CapturePreservationFacts;
      }),
    );
  const store: CapturePreservationStore = {
    enrollSource: (input, configuredPolicy) =>
      boundary(
        "enroll-source",
        db.transaction(() =>
          Effect.gen(function* () {
            const source = yield* parse(sourceInput, input, "enroll-source", "invalid-input");
            yield* markWriter(db);
            yield* db.insert(roots).values({ runId: source.runId }).onConflictDoNothing();
            const [root] = yield* lock(source.runId);
            const [runtime] = yield* db
              .select()
              .from(workspaceRuntimeInstances)
              .where(eq(workspaceRuntimeInstances.runId, source.runId))
              .for("update");
            const [pin] = yield* db
              .select()
              .from(nativePublicationConsumers)
              .where(
                and(
                  eq(nativePublicationConsumers.runId, source.runId),
                  eq(nativePublicationConsumers.runtimeInstanceId, source.runId),
                ),
              )
              .for("update");
            const publication = workspacePublicationSchema.safeParse(runtime?.publication);
            if (
              root === undefined ||
              runtime?.adapter !== "boat" ||
              runtime.resourceId !== source.sandboxId ||
              runtime.removedAt !== null ||
              !publication.success ||
              publication.data.kind !== "boat-native" ||
              publication.data.publicationId !== source.publicationId ||
              pin?.publicationId !== source.publicationId ||
              pin.state === "released"
            )
              return yield* Effect.fail(
                new CapturePreservationError({
                  operation: "enroll-source-binding",
                  reason: "invalid-input",
                }),
              );
            if (root.currentIncarnationId !== null) {
              const [existing] = yield* db
                .select()
                .from(incarnations)
                .where(
                  and(
                    eq(incarnations.runId, source.runId),
                    eq(incarnations.id, root.currentIncarnationId),
                  ),
                );
              const parsed = yield* parse(
                incarnationSchema,
                existing,
                "enroll-existing",
                "record-invalid",
              );
              if (
                Object.entries(source).some(
                  ([key, value]) => !(key in parsed) || Reflect.get(parsed, key) !== value,
                )
              )
                return yield* Effect.fail(
                  new CapturePreservationError({
                    operation: "enroll-source-conflict",
                    reason: "invalid-input",
                  }),
                );
              if (root.retainedAt !== null && root.retentionEpisodeId === null)
                yield* store.markRetained({
                  runId: source.runId,
                  reason: root.retainedReason ?? "existing retained source",
                  policy: configuredPolicy,
                });
              return parsed.id;
            }
            const id = randomUUID();
            yield* db
              .insert(incarnations)
              .values({ ...source, id, runtimeInstanceId: source.runId });
            yield* db
              .update(roots)
              .set({
                custodyContract: 3,
                preservationDesired: root.discardRequestedAt === null ? "preserve" : "discard",
                currentIncarnationId: id,
                custodyRevision: sql`${roots.custodyRevision} + 1`,
              })
              .where(eq(roots.runId, source.runId));
            if (root.retainedAt !== null)
              yield* store.markRetained({
                runId: source.runId,
                reason: root.retainedReason ?? "existing retained source",
                policy: configuredPolicy,
              });
            return id;
          }),
        ),
      ),
    markRetained: (input) =>
      boundary(
        "mark-retained",
        db.transaction(() =>
          Effect.gen(function* () {
            const chosen = yield* policy(input.policy);
            yield* markWriter(db);
            const detail = `not saved · retained · ${input.reason}`;
            const [root] = yield* db
              .insert(roots)
              .values({
                runId: input.runId,
                retainedAt: sql`now()`,
                retainedReason: input.reason,
                nextRecoveryAt: sql`now()`,
                state: "kept",
                detail,
                observedAt: sql`now()`,
              })
              .onConflictDoUpdate({
                target: roots.runId,
                set: {
                  retainedAt: sql`coalesce(${roots.retainedAt}, now())`,
                  retainedReason: input.reason,
                  nextRecoveryAt: sql`coalesce(${roots.nextRecoveryAt}, now())`,
                  state: "kept",
                  detail,
                  observedAt: sql`now()`,
                },
              })
              .returning();
            if (root === undefined)
              return yield* Effect.fail(
                new CapturePreservationError({
                  operation: "retain-root",
                  reason: "record-invalid",
                }),
              );
            if (root.custodyContract !== 3 || root.retentionEpisodeId !== null) return;
            const id = randomUUID();
            const revision = hash({ version: 1, retainedParkingDelaySeconds: chosen.delay });
            const [episode] = yield* db
              .insert(episodes)
              .values({
                runId: input.runId,
                id,
                retainedAt: sql`(select retained_at from workspace_capture_drains where run_id = ${input.runId})`,
                timeBasis: sql`case when (select retained_at from workspace_capture_drains where run_id = ${input.runId}) = now() then 'recorded' else 'existing-retention' end`,
                delaySeconds: chosen.delay,
                policyRevision: revision,
                eligibleAt: sql`(select retained_at from workspace_capture_drains where run_id = ${input.runId}) + ${chosen.delay} * interval '1 second'`,
              })
              .returning();
            if (episode === undefined)
              return yield* Effect.fail(
                new CapturePreservationError({
                  operation: "retain-episode",
                  reason: "record-invalid",
                }),
              );
            yield* db
              .update(roots)
              .set({
                retentionEpisodeId: id,
                custodyRevision: sql`${roots.custodyRevision} + 1`,
                nextPreservationActionAt: episode.eligibleAt,
              })
              .where(eq(roots.runId, input.runId));
          }),
        ),
      ),
    read: (runId) => boundary("read", read(runId)),
    claim: (runId) =>
      boundary(
        "claim",
        db.transaction(() =>
          Effect.gen(function* () {
            yield* markWriter(db);
            return yield* takeClaim(runId);
          }),
        ),
      ),
    claimDue: (limit) =>
      boundary(
        "claim-due",
        db.transaction(() =>
          Effect.gen(function* () {
            if (!Number.isInteger(limit) || limit < 1 || limit > 10)
              return yield* Effect.fail(
                new CapturePreservationError({ operation: "claim-due", reason: "invalid-input" }),
              );
            yield* markWriter(db);
            const due = yield* db
              .select({ runId: roots.runId })
              .from(roots)
              .where(
                and(
                  available,
                  isNotNull(roots.nextPreservationActionAt),
                  lte(roots.nextPreservationActionAt, sql`now()`),
                ),
              )
              .orderBy(asc(roots.nextPreservationActionAt), asc(roots.runId))
              .limit(limit)
              .for("update", { skipLocked: true });
            const claims = yield* Effect.forEach(due, (row) => takeClaim(row.runId));
            return claims.filter((claim) => claim !== undefined);
          }),
        ),
      ),
    release: (claim) =>
      boundary(
        "release",
        db.transaction(() =>
          Effect.gen(function* () {
            yield* markWriter(db);
            yield* db
              .update(roots)
              .set({ preservationClaimToken: null, preservationClaimUntil: null })
              .where(claimFence(claim));
          }),
        ),
      ),
    renew: (claim) =>
      boundary(
        "renew",
        db.transaction(() =>
          Effect.gen(function* () {
            yield* markWriter(db);
            return (
              (yield* db
                .update(roots)
                .set({ preservationClaimUntil: leaseUntil })
                .where(claimFence(claim))
                .returning()).length === 1
            );
          }),
        ),
      ),
    reserveClose: (claim, input) =>
      boundary(
        "reserve-close",
        db.transaction(() =>
          Effect.gen(function* () {
            const chosen = yield* policy(input);
            yield* markWriter(db);
            const [root] = yield* claimed(claim);
            if (root === undefined) return { kind: "claim-lost" } as const;
            if (root.custodyRevision !== claim.revision) return { kind: "stale-evidence" } as const;
            const [existing] = yield* db
              .select()
              .from(operations)
              .where(
                and(
                  eq(operations.runId, claim.runId),
                  eq(
                    operations.incarnationId,
                    root.currentIncarnationId ?? "00000000-0000-0000-0000-000000000000",
                  ),
                  eq(operations.kind, "close-writer"),
                ),
              );
            if (existing !== undefined)
              return existing.state === "prepared"
                ? ({ kind: "reserved", operationId: existing.id } as const)
                : ({ kind: "observe-only" } as const);
            if (!chosen.enabled)
              return { kind: "blocked", reason: "automatic-parking-disabled" } as const;
            if (root.preservationQuarantine !== null)
              return { kind: "blocked", reason: root.preservationQuarantine } as const;
            if (root.preservationDesired !== "preserve")
              return { kind: "blocked", reason: `${root.preservationDesired}-requested` } as const;
            if (Object.keys(root.observationFences).length !== 0)
              return { kind: "blocked", reason: "final-unresolved" } as const;
            if (root.lastStatus?.["complete"] === true && root.unsavedStatuses.length === 0)
              return { kind: "blocked", reason: "final-complete" } as const;
            const [episode] = yield* db
              .select()
              .from(episodes)
              .where(
                and(
                  eq(episodes.runId, claim.runId),
                  eq(
                    episodes.id,
                    root.retentionEpisodeId ?? "00000000-0000-0000-0000-000000000000",
                  ),
                  lte(episodes.eligibleAt, sql`now()`),
                ),
              );
            if (episode === undefined) return { kind: "blocked", reason: "not-eligible" } as const;
            const [source] = yield* db
              .select()
              .from(incarnations)
              .where(
                and(
                  eq(incarnations.runId, claim.runId),
                  eq(
                    incarnations.id,
                    root.currentIncarnationId ?? "00000000-0000-0000-0000-000000000000",
                  ),
                ),
              );
            if (source === undefined || source.removedAt !== null)
              return { kind: "blocked", reason: "source-unavailable" } as const;
            const id = randomUUID();
            const request = {
              runId: claim.runId,
              operationId: id,
              sourceIncarnationId: source.id,
              sandboxId: source.sandboxId,
              diskBindingId: source.diskBindingId,
              guestEpoch: source.guestEpoch,
              guestManifestHash: source.guestManifestHash,
              policyRevision: episode.policyRevision,
              evidenceVersion: root.evidenceVersion,
            };
            yield* db.insert(operations).values({
              runId: claim.runId,
              id,
              kind: "close-writer",
              episodeId: episode.id,
              incarnationId: source.id,
              requestDigest: hash(request),
              evidenceVersion: root.evidenceVersion,
            });
            yield* db.insert(closes).values({
              runId: claim.runId,
              operationId: id,
              diskBindingId: source.diskBindingId,
              guestEpoch: source.guestEpoch,
              guestManifestHash: source.guestManifestHash,
              policyRevision: episode.policyRevision,
            });
            yield* db
              .update(roots)
              .set({
                custodyRevision: sql`${roots.custodyRevision} + 1`,
                nextPreservationActionAt: sql`now() + interval '300 seconds'`,
              })
              .where(eq(roots.runId, claim.runId));
            return { kind: "reserved", operationId: id } as const;
          }),
        ),
      ),
    issue: (claim, operationId) =>
      boundary(
        "issue",
        db.transaction(() =>
          Effect.gen(function* () {
            yield* markWriter(db);
            const [root] = yield* claimed(claim);
            if (root === undefined) return { kind: "claim-lost" } as const;
            const [operation] = yield* db
              .select()
              .from(operations)
              .where(and(eq(operations.runId, claim.runId), eq(operations.id, operationId)));
            if (operation === undefined || operation.evidenceVersion !== root.evidenceVersion)
              return { kind: "stale-evidence" } as const;
            if (operation.state !== "prepared") return { kind: "observe-only" } as const;
            return { kind: "blocked", reason: "executor-unavailable" } as const;
          }),
        ),
      ),
    observe: (input) =>
      boundary(
        "observe",
        db.transaction(() =>
          Effect.gen(function* () {
            const value = yield* parse(observationInput, input, "observe", "invalid-input");
            yield* markWriter(db);
            const [root] = yield* lock(value.runId);
            if (root?.custodyContract !== 3) return "unknown-effect" as const;
            const [raw] = yield* db
              .select()
              .from(operations)
              .where(and(eq(operations.runId, value.runId), eq(operations.id, value.operationId)))
              .for("update");
            if (raw === undefined || raw.state === "prepared") return "unknown-effect" as const;
            const operation = yield* parse(
              operationSchema,
              raw,
              "observe-operation",
              "record-invalid",
            );
            const [sourceRaw] = yield* db
              .select()
              .from(incarnations)
              .where(
                and(
                  eq(incarnations.runId, value.runId),
                  eq(incarnations.id, operation.incarnationId),
                ),
              );
            const source = yield* parse(
              incarnationSchema,
              sourceRaw,
              "observe-source",
              "record-invalid",
            );
            const receiptDigest = hash({ ...value, observedAt: value.observedAt.toISOString() });
            const [duplicate] = yield* db
              .select()
              .from(receipts)
              .where(and(eq(receipts.runId, value.runId), eq(receipts.id, value.receiptId)));
            if (duplicate !== undefined) {
              const prior = yield* parse(
                receiptSchema,
                duplicate,
                "observe-receipt",
                "record-invalid",
              );
              if (prior.digest === receiptDigest) return "duplicate" as const;
            }
            const conflict = () =>
              db
                .update(roots)
                .set({
                  preservationQuarantine: "receipt-conflict",
                  custodyRevision: sql`${roots.custodyRevision} + 1`,
                })
                .where(eq(roots.runId, value.runId))
                .pipe(Effect.as("conflict" as const));
            if (duplicate !== undefined || source.sandboxId !== value.sandboxId)
              return yield* conflict();
            if (value.kind === "removal-completed") {
              const [removalRaw] = yield* db
                .select()
                .from(removals)
                .where(
                  and(eq(removals.runId, value.runId), eq(removals.operationId, value.operationId)),
                );
              const removal = yield* parse(
                removalSchema,
                removalRaw,
                "observe-removal",
                "record-invalid",
              );
              if (
                operation.kind !== "remove-sandbox" ||
                removal.sandboxId !== value.sandboxId ||
                removal.providerOperationId === null ||
                removal.providerOperationId !== value.providerOperationId
              )
                return yield* conflict();
              if (operation.state === "settled") return "duplicate" as const;
            } else if (operation.state === "settled") return yield* conflict();
            yield* db.insert(receipts).values({
              runId: value.runId,
              id: value.receiptId,
              operationId: value.operationId,
              digest: receiptDigest,
              kind: value.kind,
              sandboxId: value.sandboxId,
              providerOperationId: value.providerOperationId ?? null,
              observedAt: value.observedAt,
            });
            yield* db
              .update(operations)
              .set(
                value.kind === "removal-completed"
                  ? { state: "settled", settledAt: sql`now()`, nextObservationAt: null }
                  : {
                      state: value.kind === "unknown" ? "unknown" : "issued",
                      nextObservationAt: sql`now() + interval '5 seconds'`,
                    },
              )
              .where(and(eq(operations.runId, value.runId), eq(operations.id, value.operationId)));
            if (value.kind === "removal-completed")
              yield* db
                .update(incarnations)
                .set({
                  removedAt: value.observedAt,
                  removalOperationId: value.operationId,
                  computeState: "not-running",
                  computeObservedAt: value.observedAt,
                })
                .where(and(eq(incarnations.runId, value.runId), eq(incarnations.id, source.id)));
            yield* db
              .update(roots)
              .set({
                custodyRevision: sql`${roots.custodyRevision} + 1`,
                nextPreservationActionAt: sql`now() + interval '5 seconds'`,
              })
              .where(eq(roots.runId, value.runId));
            return "recorded" as const;
          }),
        ),
      ),
    recordCompute: (input) =>
      boundary(
        "record-compute",
        db.transaction(() =>
          Effect.gen(function* () {
            const value = yield* parse(computeInput, input, "record-compute", "invalid-input");
            yield* markWriter(db);
            const [root] = yield* lock(value.runId);
            if (root?.custodyContract !== 3) return false;
            const changed = yield* db
              .update(incarnations)
              .set({ computeState: value.state, computeObservedAt: value.observedAt })
              .where(
                and(
                  eq(incarnations.runId, value.runId),
                  eq(incarnations.id, value.incarnationId),
                  eq(incarnations.sandboxId, value.sandboxId),
                  sql`${incarnations.removedAt} is null and (${incarnations.computeObservedAt} is null or ${incarnations.computeObservedAt} < ${value.observedAt}) and ${value.observedAt} <= now()`,
                ),
              )
              .returning();
            if (changed.length === 1)
              yield* db
                .update(roots)
                .set({ custodyRevision: sql`${roots.custodyRevision} + 1` })
                .where(eq(roots.runId, value.runId));
            return changed.length === 1;
          }),
        ),
      ),
  };
  return store;
};
