import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  boatExecutionRecordSchema,
  boatExecutionTargetSchema,
  type BoatExecutionTarget,
  workspacePublicationSchema,
} from "@sealant/validators";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import { Effect, Schema } from "effect";

import type { DB } from "../client.js";
import { boatExecutions } from "../schema/boat-executions.js";
import {
  boatSnapshotAllowanceObservations as allowances,
  captureExecutorIncarnations as incarnations,
  captureParkingCloses as closes,
  captureCapsulePreparations as capsules,
  captureSnapshotSaves as saves,
  captureRecoveryCreates as creates,
  capturePreservationConsumers as consumers,
  captureRecoveryAdmissions as admissions,
  captureSnapshotRetirements as retirements,
  capturePreservationOperations as operations,
  capturePreservationReceipts as receipts,
  capturePreservationEvidence as evidence,
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
const evidenceSchema = createSelectSchema(evidence);
const closedCapsule = Schema.Struct({
  operationId: uuid,
  capsuleHash: digest,
  archiveHash: digest,
  contentBytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 17179869184 }),
  ),
  storedBytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 17246978064 }),
  ),
  entries: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 200000 })),
});
const personalScope = Schema.Struct({
  org: Schema.Null,
  included: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(10)),
  used: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  extra: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  extraDailyDollars: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Each packet is read from its permanent typed operation; only `issue` can authorize its first send. */
export type CaptureParkingWork = {
  readonly operationId: string;
  readonly state: "prepared" | "issued" | "unknown" | "settled";
  readonly incarnationId: string;
  readonly runtimeInstanceId: string;
  readonly sandboxId: string;
} & (
  | { readonly kind: "close-writer" }
  | {
      readonly kind: "save-snapshot";
      readonly artifactId: string;
      readonly name: string;
      readonly capsule: typeof closedCapsule.Type;
    }
  | {
      readonly kind: "remove-sandbox";
      readonly artifactId: string;
      readonly providerOperationId: string | null;
    }
  | { readonly kind: "revoke-resources"; readonly artifactId: string }
);

export interface CaptureRecoveryWork {
  readonly operationId: string;
  readonly state: "prepared" | "issued" | "unknown" | "settled";
  readonly createKey: string;
  readonly destinationRuntimeInstanceId: string;
  readonly destinationIncarnationId: string;
  readonly source: {
    readonly runtimeInstanceId: string;
    readonly sandboxId: string;
    readonly deploymentId: string;
    readonly publicationId: string;
    readonly captureLaunchId: string;
    readonly guestManifestHash: string;
  };
  readonly artifactId: string;
  readonly artifact: {
    readonly name: string;
    readonly snapshotId: string;
    readonly sourceSandboxId: string;
    readonly createdAt: string;
  };
  readonly capsule: typeof closedCapsule.Type;
  readonly target?: BoatExecutionTarget;
  readonly rebindHash?: string;
  readonly closedAt: Date;
}

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

/** Public custody facts share the API contract; provider responses never flow through unchecked. */
export type CapturePreservationFacts = import("@sealant/api-contracts").WorkspacePreservation;

type Decision =
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "claim-lost" }
  | { readonly kind: "stale-evidence" }
  | { readonly kind: "observe-only" };

export interface CapturePreservationStore {
  readonly tunnelRemovalAuthorized: (
    target: BoatExecutionTarget,
    providerOperationId: string,
    completed: boolean,
  ) => Effect.Effect<boolean, CapturePreservationError>;
  readonly prepareRetirements: (
    claim: CapturePreservationClaim,
  ) => Effect.Effect<
    readonly {
      readonly operationId: string;
      readonly name: string;
      readonly snapshotId: string;
      readonly sourceSandboxId: string;
      readonly state: "prepared" | "issued" | "unknown" | "settled";
    }[],
    CapturePreservationError
  >;
  readonly completeRetirement: (
    claim: CapturePreservationClaim,
    operationId: string,
  ) => Effect.Effect<void, CapturePreservationError>;
  readonly finishLineage: (
    claim: CapturePreservationClaim,
  ) => Effect.Effect<boolean, CapturePreservationError>;
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
  ) => Effect.Effect<Decision | { readonly kind: "issued" }, CapturePreservationError>;
  readonly parkingWork: (
    claim: CapturePreservationClaim,
  ) => Effect.Effect<CaptureParkingWork | undefined, CapturePreservationError>;
  readonly prepareRecovery: (
    claim: CapturePreservationClaim,
  ) => Effect.Effect<CaptureRecoveryWork, CapturePreservationError>;
  readonly recoveryWork: (
    claim: CapturePreservationClaim,
  ) => Effect.Effect<CaptureRecoveryWork, CapturePreservationError>;
  readonly recordRecoveryChild: (
    claim: CapturePreservationClaim,
    operationId: string,
    target: BoatExecutionTarget,
  ) => Effect.Effect<void, CapturePreservationError>;
  readonly prepareRecoveryAdmission: (
    claim: CapturePreservationClaim,
    createId: string,
    rebindHash: string,
  ) => Effect.Effect<string, CapturePreservationError>;
  readonly promoteRecovery: (
    claim: CapturePreservationClaim,
    operationId: string,
    readiness: {
      readonly runtimeId: string;
      readonly bootId: string;
      readonly isolationReceipt: string;
    },
  ) => Effect.Effect<void, CapturePreservationError>;
  readonly resolveExecution: (
    runId: string,
    allowRecovery?: boolean,
  ) => Effect.Effect<BoatExecutionTarget | undefined, CapturePreservationError>;
  readonly recordWriterClosed: (
    claim: CapturePreservationClaim,
    input: unknown,
  ) => Effect.Effect<void, CapturePreservationError>;
  readonly prepareParkingSave: (
    claim: CapturePreservationClaim,
  ) => Effect.Effect<void, CapturePreservationError>;
  readonly recordParkingScope: (
    claim: CapturePreservationClaim,
    operationId: string,
    input: unknown,
  ) => Effect.Effect<void, CapturePreservationError>;
  readonly recordParkingSnapshot: (
    claim: CapturePreservationClaim,
    operationId: string,
    input: unknown,
  ) => Effect.Effect<void, CapturePreservationError>;
  readonly verifyParkingSnapshot: (
    claim: CapturePreservationClaim,
    operationId: string,
    input: unknown,
  ) => Effect.Effect<void, CapturePreservationError>;
  readonly prepareParkingRemoval: (
    claim: CapturePreservationClaim,
    resourceReceipt: string,
  ) => Effect.Effect<void, CapturePreservationError>;
  readonly recordParkingDeletion: (
    claim: CapturePreservationClaim,
    operationId: string,
    providerOperationId: string,
  ) => Effect.Effect<void, CapturePreservationError>;
  readonly observe: (
    input: unknown,
  ) => Effect.Effect<
    "recorded" | "duplicate" | "superseded" | "conflict" | "unknown-effect",
    CapturePreservationError
  >;
  readonly recordCompute: (input: unknown) => Effect.Effect<boolean, CapturePreservationError>;
}

const evidenceHash = (input: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(input, (_key, value: unknown) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : value,
      ),
    )
    .digest("hex");
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
  const invalid = (operation: string) =>
    Effect.fail(new CapturePreservationError({ operation, reason: "invalid-input" }));
  const owned = (claim: CapturePreservationClaim, operationId: string) =>
    Effect.gen(function* () {
      yield* markWriter(db);
      const [raw] = yield* claimed(claim);
      const root = yield* parse(rootSchema, raw, "parking-claim", "invalid-input");
      const [packet] = yield* db
        .select()
        .from(operations)
        .where(and(eq(operations.runId, claim.runId), eq(operations.id, operationId)))
        .for("update");
      const operation = yield* parse(
        operationSchema,
        packet,
        "parking-operation",
        "record-invalid",
      );
      const [subject] = yield* db
        .select()
        .from(incarnations)
        .where(
          and(eq(incarnations.runId, claim.runId), eq(incarnations.id, operation.incarnationId)),
        );
      const source = yield* parse(incarnationSchema, subject, "parking-source", "record-invalid");
      if (
        root.custodyContract !== 3 ||
        root.currentIncarnationId !== source.id ||
        root.retentionEpisodeId !== operation.episodeId ||
        root.preservationQuarantine !== null
      )
        return yield* invalid("parking-current-binding");
      return { root, operation, source };
    });
  const positive = <A>(
    runId: string,
    operationId: string,
    kind: typeof evidence.$inferSelect.kind,
    schema: Schema.Codec<A>,
  ) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select()
        .from(evidence)
        .where(
          and(
            eq(evidence.runId, runId),
            eq(evidence.operationId, operationId),
            eq(evidence.kind, kind),
          ),
        );
      const record = yield* parse(evidenceSchema, row, "parking-evidence", "record-invalid");
      const value = yield* parse(schema, record.value, "parking-evidence-value", "record-invalid");
      if (evidenceHash(value) !== record.digest) return yield* invalid("parking-evidence-digest");
      return { id: record.id, value };
    });
  const recordPositive = (
    runId: string,
    operationId: string,
    kind: typeof evidence.$inferSelect.kind,
    value: unknown,
    id: string = randomUUID(),
  ) =>
    Effect.gen(function* () {
      yield* db
        .insert(evidence)
        .values({ runId, operationId, kind, value, digest: evidenceHash(value), id })
        .onConflictDoNothing();
      const [row] = yield* db
        .select()
        .from(evidence)
        .where(
          and(
            eq(evidence.runId, runId),
            eq(evidence.operationId, operationId),
            eq(evidence.kind, kind),
          ),
        );
      const stored = yield* parse(evidenceSchema, row, "parking-evidence-write", "record-invalid");
      if (stored.digest !== evidenceHash(value)) return yield* invalid("parking-evidence-conflict");
      return stored.id;
    });
  const settle = (runId: string, operationId: string) =>
    db
      .update(operations)
      .set({ state: "settled", settledAt: sql`now()`, nextObservationAt: null })
      .where(
        and(
          eq(operations.runId, runId),
          eq(operations.id, operationId),
          sql`${operations.state} <> 'settled'`,
        ),
      );
  const snapshotIdentity = Schema.Struct({
    name: nonempty,
    snapshotId: nonempty,
    sourceSandboxId: nonempty,
    createdAt: nonempty,
  });
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
                effects.some(
                  (prior) =>
                    prior.id === detail.createOperationId &&
                    prior.kind === "create-recovery" &&
                    prior.incarnationId === operation.incarnationId &&
                    prior.state === "settled",
                ) &&
                instances.some(
                  (child) =>
                    child.parentIncarnationId === operation.incarnationId &&
                    child.allocationOperationId === detail.createOperationId &&
                    child.guestEpoch === detail.guestEpoch,
                );
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
        const closed =
          allRemoved &&
          saved.length > 0 &&
          saved.every((artifact) => artifact.state === "removed") &&
          effects.every((op) => op.state === "settled");
        const state = closed
          ? "closed"
          : root.preservationQuarantine !== null || lost
            ? "unknown"
            : recovering
              ? "recovering"
              : parked
                ? "parked"
                : current.removedAt === null && root.retainedReason === null
                  ? "active"
                  : effects.some((op) => op.incarnationId === current.id)
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
            runtimeInstanceId: instance.runtimeInstanceId,
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
            privacy: "unknown" as const,
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
            ...(lost && !closed ? ["source-loss"] : []),
            ...unresolved.map((op) => `${op.kind}-unresolved`),
          ],
        } satisfies CapturePreservationFacts;
      }),
    );
  const parseTarget = (input: unknown) =>
    Effect.try({
      try: () => boatExecutionTargetSchema.parse(input),
      catch: () =>
        new CapturePreservationError({ operation: "recovery-target", reason: "record-invalid" }),
    });
  const recoveryWork = (claim: CapturePreservationClaim) =>
    Effect.gen(function* () {
      yield* markWriter(db);
      const [raw] = yield* claimed(claim);
      const root = yield* parse(rootSchema, raw, "recovery-claim", "invalid-input");
      const [createRaw] = yield* db
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.runId, claim.runId),
            eq(
              operations.incarnationId,
              root.currentIncarnationId ?? "00000000-0000-0000-0000-000000000000",
            ),
            eq(
              operations.episodeId,
              root.retentionEpisodeId ?? "00000000-0000-0000-0000-000000000000",
            ),
            eq(operations.kind, "create-recovery"),
          ),
        );
      const create = yield* parse(operationSchema, createRaw, "recovery-create", "record-invalid");
      const { source } = yield* owned(claim, create.id);
      const [detailRaw] = yield* db
        .select()
        .from(creates)
        .where(and(eq(creates.runId, claim.runId), eq(creates.operationId, create.id)));
      const detail = yield* parse(
        createSchema,
        detailRaw,
        "recovery-create-detail",
        "record-invalid",
      );
      const [artifactRaw] = yield* db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.runId, claim.runId), eq(artifacts.id, detail.artifactId)));
      const artifact = yield* parse(
        artifactSchema,
        artifactRaw,
        "recovery-artifact",
        "record-invalid",
      );
      if (
        artifact.state !== "verified" ||
        artifact.snapshotId === null ||
        source.removedAt === null ||
        root.preservationDesired !== "recover"
      )
        return yield* invalid("recovery-not-ready");
      const [saveRaw] = yield* db
        .select()
        .from(saves)
        .where(and(eq(saves.runId, claim.runId), eq(saves.artifactId, artifact.id)));
      const save = yield* parse(saveSchema, saveRaw, "recovery-save", "record-invalid");
      const ready = yield* positive(
        claim.runId,
        save.operationId,
        "snapshot-ready",
        snapshotIdentity,
      );
      const [capsuleRaw] = yield* db
        .select()
        .from(capsules)
        .where(
          and(eq(capsules.runId, claim.runId), eq(capsules.operationId, save.capsuleOperationId)),
        );
      const kept = yield* parse(capsuleSchema, capsuleRaw, "recovery-capsule", "record-invalid");
      const closed = yield* positive(
        claim.runId,
        kept.closeOperationId,
        "writer-closed",
        closedCapsule,
      );
      const [closedRecord] = yield* db
        .select()
        .from(evidence)
        .where(and(eq(evidence.runId, claim.runId), eq(evidence.id, closed.id)));
      if (closedRecord === undefined) return yield* invalid("recovery-closure-missing");
      const [hydrated] = yield* db
        .select()
        .from(evidence)
        .where(
          and(
            eq(evidence.runId, claim.runId),
            eq(evidence.operationId, create.id),
            eq(evidence.kind, "recovery-hydrated"),
          ),
        );
      const target = hydrated === undefined ? undefined : yield* parseTarget(hydrated.value);
      const [rebound] = yield* db
        .select()
        .from(evidence)
        .where(
          and(
            eq(evidence.runId, claim.runId),
            eq(evidence.operationId, create.id),
            eq(evidence.kind, "recovery-rebound"),
          ),
        );
      const rebindHash =
        rebound === undefined
          ? undefined
          : (yield* positive(
              claim.runId,
              create.id,
              "recovery-rebound",
              Schema.Struct({ sha256: digest }),
            )).value.sha256;
      return {
        operationId: create.id,
        state: create.state,
        createKey: detail.createKey,
        destinationRuntimeInstanceId: detail.destinationRuntimeInstanceId,
        destinationIncarnationId: detail.destinationIncarnationId,
        source,
        artifactId: artifact.id,
        artifact: ready.value,
        capsule: closed.value,
        ...(target === undefined ? {} : { target }),
        ...(rebindHash === undefined ? {} : { rebindHash }),
        closedAt: closedRecord.recordedAt,
      } satisfies CaptureRecoveryWork;
    });
  const store: CapturePreservationStore = {
    tunnelRemovalAuthorized: (target, providerOperationId, completed) =>
      boundary(
        "tunnel-removal",
        Effect.gen(function* () {
          const [row] = yield* db
            .select({
              source: incarnations,
              removal: removals,
              operation: operations,
              execution: boatExecutions.record,
            })
            .from(incarnations)
            .innerJoin(
              removals,
              and(
                eq(removals.runId, incarnations.runId),
                eq(removals.sandboxId, incarnations.sandboxId),
              ),
            )
            .innerJoin(
              operations,
              and(
                eq(operations.runId, removals.runId),
                eq(operations.id, removals.operationId),
                eq(operations.incarnationId, incarnations.id),
              ),
            )
            .innerJoin(
              boatExecutions,
              eq(boatExecutions.runtimeInstanceId, incarnations.runtimeInstanceId),
            )
            .where(
              and(
                eq(incarnations.runId, target.runId),
                eq(incarnations.runtimeInstanceId, target.runtimeInstanceId),
                eq(incarnations.sandboxId, target.sandboxId),
                eq(removals.providerOperationId, providerOperationId),
                eq(operations.kind, "remove-sandbox"),
                sql`${operations.state} in ('issued','unknown','settled')`,
              ),
            );
          if (row === undefined) return false;
          const execution = yield* Effect.try({
            try: () => boatExecutionRecordSchema.parse(row.execution),
            catch: () =>
              new CapturePreservationError({
                operation: "tunnel-removal-binding",
                reason: "record-invalid",
              }),
          });
          return (
            isDeepStrictEqual(execution.target, target) &&
            (!completed ||
              (row.source.removedAt !== null &&
                row.source.removalOperationId === row.removal.operationId &&
                row.operation.state === "settled"))
          );
        }),
      ),
    prepareRetirements: (claim) =>
      boundary(
        "prepare-retirements",
        db.transaction(() =>
          Effect.gen(function* () {
            yield* markWriter(db);
            const [raw] = yield* claimed(claim);
            if (raw === undefined) return yield* invalid("retirement-root");
            const root = raw;
            if (
              root.preservationQuarantine !== null ||
              Object.keys(root.observationFences).length !== 0 ||
              root.preservationDesired === "recover" ||
              (root.preservationDesired !== "discard" &&
                (root.lastStatus?.complete !== true || root.unsavedStatuses.length !== 0))
            )
              return [];
            const instances = yield* db
              .select()
              .from(incarnations)
              .where(eq(incarnations.runId, claim.runId));
            const effects = yield* db
              .select()
              .from(operations)
              .where(eq(operations.runId, claim.runId));
            const terminal = effects.find(
              (op) =>
                op.kind === "remove-sandbox" &&
                op.incarnationId === root.currentIncarnationId &&
                op.state === "settled",
            );
            if (
              instances.length === 0 ||
              instances.some((vm) => vm.removedAt === null) ||
              effects.some((op) => op.kind !== "retire-snapshot" && op.state !== "settled") ||
              terminal === undefined
            )
              return [];
            const dischargeId = yield* recordPositive(
              claim.runId,
              terminal.id,
              "lineage-discharged",
              {
                currentIncarnationId: root.currentIncarnationId,
                evidenceVersion: root.evidenceVersion,
                basis: root.preservationDesired === "discard" ? "owner-discard" : "complete-final",
              },
            );
            yield* db
              .update(consumers)
              .set({ releasedAt: sql`now()` })
              .where(and(eq(consumers.runId, claim.runId), sql`${consumers.releasedAt} is null`));
            const saved = yield* db
              .select()
              .from(artifacts)
              .where(eq(artifacts.runId, claim.runId));
            const result = [];
            for (const artifact of saved) {
              if (artifact.state === "removed") continue;
              if (
                artifact.snapshotId === null ||
                artifact.namespaceReceiptId === null ||
                (artifact.state !== "verified" && artifact.state !== "retiring")
              )
                return yield* invalid("retirement-custody-unverified");
              let [packet] = yield* db
                .select({ operation: operations })
                .from(operations)
                .innerJoin(
                  retirements,
                  and(
                    eq(retirements.runId, operations.runId),
                    eq(retirements.operationId, operations.id),
                  ),
                )
                .where(
                  and(eq(retirements.runId, claim.runId), eq(retirements.artifactId, artifact.id)),
                );
              if (packet === undefined) {
                const id = randomUUID();
                const [operation] = yield* db
                  .insert(operations)
                  .values({
                    runId: claim.runId,
                    id,
                    kind: "retire-snapshot",
                    incarnationId: artifact.sourceIncarnationId,
                    episodeId: artifact.episodeId,
                    evidenceVersion: root.evidenceVersion,
                    requestDigest: hash({
                      name: artifact.name,
                      snapshotId: artifact.snapshotId,
                      dischargeId,
                    }),
                  })
                  .returning();
                if (operation === undefined) return yield* invalid("retirement-reservation-failed");
                yield* db
                  .insert(retirements)
                  .values({
                    runId: claim.runId,
                    operationId: id,
                    artifactId: artifact.id,
                    dischargeReceiptId: dischargeId,
                    namespaceReceiptId: artifact.namespaceReceiptId,
                  });
                yield* db
                  .update(artifacts)
                  .set({ state: "retiring" })
                  .where(and(eq(artifacts.runId, claim.runId), eq(artifacts.id, artifact.id)));
                packet = { operation };
              }
              const source = instances.find((vm) => vm.id === artifact.sourceIncarnationId);
              if (source === undefined) return yield* invalid("retirement-source-missing");
              result.push({
                operationId: packet.operation.id,
                state: packet.operation.state,
                name: artifact.name,
                snapshotId: artifact.snapshotId,
                sourceSandboxId: source.sandboxId,
              });
            }
            return result;
          }),
        ),
      ),
    completeRetirement: (claim, operationId) =>
      boundary(
        "complete-retirement",
        db.transaction(() =>
          Effect.gen(function* () {
            yield* markWriter(db);
            const [root] = yield* claimed(claim);
            if (root === undefined) return yield* invalid("retirement-claim-lost");
            const [packet] = yield* db
              .select({ operation: operations, detail: retirements })
              .from(operations)
              .innerJoin(
                retirements,
                and(
                  eq(retirements.runId, operations.runId),
                  eq(retirements.operationId, operations.id),
                ),
              )
              .where(and(eq(operations.runId, claim.runId), eq(operations.id, operationId)));
            if (packet === undefined || packet.operation.state === "prepared")
              return yield* invalid("retirement-not-issued");
            yield* recordPositive(claim.runId, operationId, "snapshot-deleted", {
              acknowledged: true,
            });
            yield* settle(claim.runId, operationId);
            yield* db
              .update(artifacts)
              .set({ state: "removed", retiredAt: sql`now()` })
              .where(
                and(
                  eq(artifacts.runId, claim.runId),
                  eq(artifacts.id, packet.detail.artifactId),
                  sql`${artifacts.state} <> 'removed'`,
                ),
              );
          }),
        ),
      ),
    finishLineage: (claim) =>
      boundary(
        "finish-lineage",
        db.transaction(() =>
          Effect.gen(function* () {
            yield* markWriter(db);
            const [root] = yield* claimed(claim);
            if (root === undefined) return false;
            const [proof] = yield* db
              .select({
                closed: sql<boolean>`capture_lineage_discharged(${claim.runId}) and not exists(select 1 from capture_recovery_artifacts where run_id = ${claim.runId} and state <> 'removed') and not exists(select 1 from capture_preservation_operations where run_id = ${claim.runId} and state <> 'settled')`,
              })
              .from(roots)
              .where(eq(roots.runId, claim.runId));
            if (proof?.closed !== true) return false;
            yield* db
              .update(nativePublicationConsumers)
              .set({ state: "released", releasedAt: sql`now()` })
              .where(
                and(
                  eq(nativePublicationConsumers.runId, claim.runId),
                  sql`${nativePublicationConsumers.state} <> 'released'`,
                ),
              );
            yield* db
              .update(boatExecutions)
              .set({ record: sql`${boatExecutions.record} #- '{admission,sealedResumeEnvelope}'` })
              .where(eq(boatExecutions.runId, claim.runId));
            yield* db
              .update(roots)
              .set({ nextPreservationActionAt: null })
              .where(claimFence(claim));
            return true;
          }),
        ),
      ),
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
            if (root.custodyContract !== 3) return;
            if (root.retentionEpisodeId !== null) {
              yield* db
                .update(roots)
                .set({
                  nextPreservationActionAt: sql`coalesce(${roots.nextPreservationActionAt}, now() + (select delay_seconds from capture_retention_episodes where run_id = ${input.runId} and id = ${root.retentionEpisodeId}) * interval '1 second')`,
                })
                .where(eq(roots.runId, input.runId));
              return;
            }
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
              .set({
                preservationClaimToken: null,
                preservationClaimUntil: null,
                nextPreservationActionAt: sql`case when ${roots.nextPreservationActionAt} is null then null else least(
                  now() + interval '300 seconds',
                  case when ${roots.nextPreservationActionAt} > now() then ${roots.nextPreservationActionAt} end,
                  (select min(${operations.nextObservationAt}) from ${operations}
                   where ${operations.runId} = ${roots.runId} and ${operations.state} in ('issued', 'unknown'))
                ) end`,
              })
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
            if (root.nextPreservationActionAt === null || root.retainedReason === null)
              return { kind: "blocked", reason: "session-active" } as const;

            if (Object.keys(root.observationFences).length !== 0)
              return { kind: "blocked", reason: "final-unresolved" } as const;
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
                  sql`${root.nextPreservationActionAt.toISOString()}::timestamptz <= now()`,
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
            if (
              root.preservationQuarantine !== null ||
              (operation.kind === "create-recovery" || operation.kind === "admit-recovery"
                ? root.preservationDesired !== "recover"
                : false)
            )
              return { kind: "blocked", reason: "custody-held" } as const;
            if (Object.keys(root.observationFences).length !== 0)
              return { kind: "blocked", reason: "final-unresolved" } as const;
            if (operation.kind === "close-writer") {
              if (
                root.lastStatus === null ||
                root.lastStatusAt === null ||
                root.unreachableSince !== null ||
                typeof root.lastStatus.complete !== "boolean" ||
                (root.lastStatus.complete !== true &&
                  (typeof root.lastStatus.incompleteReason !== "string" ||
                    root.lastStatus.incompleteReason === "not-final" ||
                    root.lastStatus.incompleteReason === "in-progress"))
              )
                return { kind: "blocked", reason: "final-boundary-unavailable" } as const;
            } else if (operation.kind === "save-snapshot") {
              const [raw] = yield* db
                .select()
                .from(saves)
                .where(and(eq(saves.runId, claim.runId), eq(saves.operationId, operationId)));
              yield* parse(saveSchema, raw, "issue-save", "record-invalid");
              yield* positive(
                claim.runId,
                operationId,
                "personal-scope",
                Schema.Struct({
                  org: Schema.Null,
                  name: nonempty,
                  sourceSandboxId: nonempty,
                  absent: Schema.Literal(true),
                }),
              );
              const { source } = yield* owned(claim, operationId);
              const [scope] = yield* db
                .select()
                .from(allowances)
                .where(
                  and(
                    eq(allowances.accountScope, source.accountScope),
                    sql`${allowances.observedAt} > now() - interval '300 seconds'`,
                  ),
                );
              if (scope === undefined) return { kind: "blocked", reason: "scope-stale" } as const;
            } else if (operation.kind === "remove-sandbox") {
              const [raw] = yield* db
                .select()
                .from(removals)
                .where(and(eq(removals.runId, claim.runId), eq(removals.operationId, operationId)));
              const removal = yield* parse(removalSchema, raw, "issue-removal", "record-invalid");
              const [artifact] = yield* db
                .select()
                .from(artifacts)
                .where(
                  and(
                    eq(artifacts.runId, claim.runId),
                    eq(artifacts.id, removal.artifactId ?? "00000000-0000-0000-0000-000000000000"),
                  ),
                );
              if (artifact?.state !== "verified")
                return { kind: "blocked", reason: "custody-unverified" } as const;
            } else if (
              operation.kind === "create-recovery" ||
              operation.kind === "admit-recovery"
            ) {
              const { source } = yield* owned(claim, operationId);
              if (source.removedAt === null)
                return { kind: "blocked", reason: "source-removal-unconfirmed" } as const;
            } else if (operation.kind === "retire-snapshot") {
              const [proof] = yield* db
                .select({ closed: sql<boolean>`capture_lineage_discharged(${claim.runId})` })
                .from(roots)
                .where(eq(roots.runId, claim.runId));
              if (proof?.closed !== true)
                return { kind: "blocked", reason: "lineage-not-discharged" } as const;
            } else return { kind: "blocked", reason: "executor-unavailable" } as const;
            yield* db
              .update(operations)
              .set({
                state: "issued",
                issuedAt: sql`now()`,
                issuedFence: claim.fence,
                nextObservationAt: sql`now() + interval '5 seconds'`,
              })
              .where(and(eq(operations.runId, claim.runId), eq(operations.id, operationId)));
            return { kind: "issued" } as const;
          }),
        ),
      ),
    parkingWork: (claim) =>
      boundary(
        "parking-work",
        db.transaction(() =>
          Effect.gen(function* () {
            yield* markWriter(db);
            const [raw] = yield* claimed(claim);
            if (raw === undefined) return undefined;
            const root = yield* parse(rootSchema, raw, "parking-root", "record-invalid");
            const packets = yield* db
              .select()
              .from(operations)
              .where(
                and(
                  eq(operations.runId, claim.runId),
                  eq(
                    operations.incarnationId,
                    root.currentIncarnationId ?? "00000000-0000-0000-0000-000000000000",
                  ),
                  eq(
                    operations.episodeId,
                    root.retentionEpisodeId ?? "00000000-0000-0000-0000-000000000000",
                  ),
                ),
              )
              .orderBy(asc(operations.createdAt), asc(operations.id));
            for (const kind of ["close-writer", "save-snapshot", "remove-sandbox"] as const) {
              const rawPacket = packets.find(
                (packet) => packet.kind === kind && packet.state !== "settled",
              );
              if (rawPacket === undefined) continue;
              const { operation, source } = yield* owned(claim, rawPacket.id);
              const common = {
                operationId: operation.id,
                state: operation.state,
                incarnationId: source.id,
                runtimeInstanceId: source.runtimeInstanceId,
                sandboxId: source.sandboxId,
              };
              if (kind === "close-writer") return { ...common, kind };
              if (kind === "remove-sandbox") {
                const [rawDetail] = yield* db
                  .select()
                  .from(removals)
                  .where(
                    and(eq(removals.runId, claim.runId), eq(removals.operationId, operation.id)),
                  );
                const detail = yield* parse(
                  removalSchema,
                  rawDetail,
                  "parking-removal",
                  "record-invalid",
                );
                if (detail.artifactId === null) return yield* invalid("parking-removal-basis");
                return {
                  ...common,
                  kind,
                  artifactId: detail.artifactId,
                  providerOperationId: detail.providerOperationId,
                };
              }
              const [rawDetail] = yield* db
                .select()
                .from(saves)
                .where(and(eq(saves.runId, claim.runId), eq(saves.operationId, operation.id)));
              const detail = yield* parse(saveSchema, rawDetail, "parking-save", "record-invalid");
              const [rawArtifact] = yield* db
                .select()
                .from(artifacts)
                .where(and(eq(artifacts.runId, claim.runId), eq(artifacts.id, detail.artifactId)));
              const artifact = yield* parse(
                artifactSchema,
                rawArtifact,
                "parking-artifact",
                "record-invalid",
              );
              const close = packets.find(
                (packet) => packet.kind === "close-writer" && packet.state === "settled",
              );
              if (close === undefined) return yield* invalid("parking-close-unsettled");
              const capsule = yield* positive(
                claim.runId,
                close.id,
                "writer-closed",
                closedCapsule,
              );
              return {
                ...common,
                kind,
                artifactId: artifact.id,
                name: artifact.name,
                capsule: capsule.value,
              };
            }
            const save = packets.find(
              (packet) => packet.kind === "save-snapshot" && packet.state === "settled",
            );
            if (save !== undefined && !packets.some((packet) => packet.kind === "remove-sandbox")) {
              const { operation, source } = yield* owned(claim, save.id);
              const [rawDetail] = yield* db
                .select()
                .from(saves)
                .where(and(eq(saves.runId, claim.runId), eq(saves.operationId, operation.id)));
              const detail = yield* parse(saveSchema, rawDetail, "parking-save", "record-invalid");
              return {
                kind: "revoke-resources",
                operationId: operation.id,
                state: operation.state,
                incarnationId: source.id,
                runtimeInstanceId: source.runtimeInstanceId,
                sandboxId: source.sandboxId,
                artifactId: detail.artifactId,
              };
            }
            return undefined;
          }),
        ),
      ),
    prepareRecovery: (claim) =>
      boundary(
        "prepare-recovery",
        db.transaction(() =>
          Effect.gen(function* () {
            yield* markWriter(db);
            const [raw] = yield* claimed(claim);
            const root = yield* parse(rootSchema, raw, "recovery-root", "invalid-input");
            if (
              root.preservationDesired !== "recover" ||
              root.preservationQuarantine !== null ||
              root.observationFences === null ||
              typeof root.observationFences !== "object" ||
              Object.keys(root.observationFences).length !== 0
            )
              return yield* invalid("recovery-held");
            const [prior] = yield* db
              .select()
              .from(operations)
              .where(
                and(
                  eq(operations.runId, claim.runId),
                  eq(
                    operations.incarnationId,
                    root.currentIncarnationId ?? "00000000-0000-0000-0000-000000000000",
                  ),
                  eq(
                    operations.episodeId,
                    root.retentionEpisodeId ?? "00000000-0000-0000-0000-000000000000",
                  ),
                  eq(operations.kind, "create-recovery"),
                ),
              );
            if (prior === undefined) {
              const [sourceRaw] = yield* db
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
              const source = yield* parse(
                incarnationSchema,
                sourceRaw,
                "recovery-source",
                "record-invalid",
              );
              const [artifactRaw] = yield* db
                .select()
                .from(artifacts)
                .where(
                  and(
                    eq(artifacts.runId, claim.runId),
                    eq(artifacts.sourceIncarnationId, source.id),
                    eq(
                      artifacts.episodeId,
                      root.retentionEpisodeId ?? "00000000-0000-0000-0000-000000000000",
                    ),
                  ),
                );
              const artifact = yield* parse(
                artifactSchema,
                artifactRaw,
                "recovery-artifact",
                "record-invalid",
              );
              if (
                source.removedAt === null ||
                source.removalOperationId === null ||
                artifact.state !== "verified"
              )
                return yield* invalid("recovery-source-not-removed");
              const id = randomUUID(),
                destination = randomUUID(),
                createKey = randomUUID();
              yield* db
                .insert(operations)
                .values({
                  runId: claim.runId,
                  id,
                  kind: "create-recovery",
                  incarnationId: source.id,
                  episodeId: artifact.episodeId,
                  evidenceVersion: root.evidenceVersion,
                  requestDigest: hash({
                    source: source.id,
                    artifactId: artifact.id,
                    destination,
                    createKey,
                  }),
                });
              yield* db
                .insert(creates)
                .values({
                  runId: claim.runId,
                  operationId: id,
                  artifactId: artifact.id,
                  sourceRemovalOperationId: source.removalOperationId,
                  destinationIncarnationId: destination,
                  destinationRuntimeInstanceId: destination,
                  createKey,
                });
              yield* db
                .insert(consumers)
                .values({ runId: claim.runId, operationId: id, artifactId: artifact.id });
            }
            return yield* recoveryWork(claim);
          }),
        ),
      ),
    recoveryWork: (claim) =>
      boundary(
        "recovery-work",
        db.transaction(() => recoveryWork(claim)),
      ),
    recordRecoveryChild: (claim, operationId, input) =>
      boundary(
        "recovery-child",
        db.transaction(() =>
          Effect.gen(function* () {
            const target = yield* parseTarget(input);
            const work = yield* recoveryWork(claim);
            const { operation, source } = yield* owned(claim, operationId);
            if (
              work.operationId !== operationId ||
              operation.state === "prepared" ||
              target.runtimeInstanceId !== work.destinationRuntimeInstanceId ||
              target.launchAttemptId !== operationId ||
              target.diskLineage !== work.createKey ||
              target.deploymentId !== source.deploymentId ||
              target.runId !== source.runId ||
              target.sourceId !== source.publicationId ||
              target.manifestDigest !== source.guestManifestHash ||
              target.sandboxId === source.sandboxId
            )
              return yield* invalid("recovery-child-binding");
            yield* recordPositive(claim.runId, operationId, "recovery-hydrated", target);
            yield* db
              .insert(incarnations)
              .values({
                runId: claim.runId,
                id: work.destinationIncarnationId,
                runtimeInstanceId: target.runtimeInstanceId,
                deploymentId: target.deploymentId,
                accountScope: source.accountScope,
                sandboxId: target.sandboxId,
                diskBindingId: work.createKey,
                allocationOperationId: operationId,
                publicationId: source.publicationId,
                captureLaunchId: source.captureLaunchId,
                guestEpoch: operationId,
                guestManifestHash: target.manifestDigest,
                parentIncarnationId: source.id,
                sourceArtifactId: work.artifactId,
              })
              .onConflictDoNothing();
            yield* settle(claim.runId, operationId);
          }),
        ),
      ),
    prepareRecoveryAdmission: (claim, createId, rebindHash) =>
      boundary(
        "recovery-admission",
        db.transaction(() =>
          Effect.gen(function* () {
            yield* parse(digest, rebindHash, "recovery-rebind", "invalid-input");
            const work = yield* recoveryWork(claim);
            const { operation, root } = yield* owned(claim, createId);
            if (
              work.operationId !== createId ||
              operation.state !== "settled" ||
              work.target === undefined
            )
              return yield* invalid("recovery-not-hydrated");
            const rebindId = yield* recordPositive(claim.runId, createId, "recovery-rebound", {
              sha256: rebindHash,
            });
            const [prior] = yield* db
              .select()
              .from(operations)
              .where(
                and(
                  eq(operations.runId, claim.runId),
                  eq(operations.incarnationId, operation.incarnationId),
                  eq(operations.episodeId, operation.episodeId),
                  eq(operations.kind, "admit-recovery"),
                ),
              );
            if (prior !== undefined) return prior.id;
            const id = randomUUID();
            yield* db
              .insert(operations)
              .values({
                runId: claim.runId,
                id,
                kind: "admit-recovery",
                incarnationId: operation.incarnationId,
                episodeId: operation.episodeId,
                evidenceVersion: root.evidenceVersion,
                requestDigest: hash({ target: work.target, rebindHash }),
              });
            const hydrated = yield* positive(
              claim.runId,
              createId,
              "recovery-hydrated",
              Schema.Unknown,
            );
            yield* db
              .insert(admissions)
              .values({
                runId: claim.runId,
                operationId: id,
                createOperationId: createId,
                hydratedReceiptId: hydrated.id,
                rebindReceiptId: rebindId,
                guestEpoch: createId,
              });
            return id;
          }),
        ),
      ),
    promoteRecovery: (claim, operationId, readiness) =>
      boundary(
        "promote-recovery",
        db.transaction(() =>
          Effect.gen(function* () {
            const ready = yield* parse(
              Schema.Struct({ runtimeId: nonempty, bootId: uuid, isolationReceipt: digest }),
              readiness,
              "recovery-ready",
              "invalid-input",
            );
            const { operation, root } = yield* owned(claim, operationId);
            const work = yield* recoveryWork(claim);
            if (
              operation.kind !== "admit-recovery" ||
              operation.state === "prepared" ||
              work.target === undefined ||
              root.preservationDesired !== "recover"
            )
              return yield* invalid("recovery-promotion-held");
            yield* recordPositive(claim.runId, operationId, "recovery-rebound", {
              target: work.target,
              readiness: ready,
            });
            yield* settle(claim.runId, operationId);
            yield* db
              .update(roots)
              .set({
                currentIncarnationId: work.destinationIncarnationId,
                preservationDesired: "preserve",
                retainedReason: null,
                lastStatus: null,
                lastStatusAt: null,
                lastStatusRecordedAt: null,
                unsavedStatuses: [],
                evidenceVersion: sql`${roots.evidenceVersion} + 1`,
                custodyRevision: sql`${roots.custodyRevision} + 1`,
                nextPreservationActionAt: null,
              })
              .where(claimFence(claim));
          }),
        ),
      ),
    resolveExecution: (runId, allowRecovery = false) =>
      boundary(
        "resolve-execution",
        Effect.gen(function* () {
          const [root] = yield* db
            .select()
            .from(roots)
            .where(and(eq(roots.runId, runId), eq(roots.custodyContract, 3)));
          if (root === undefined || root.preservationQuarantine !== null) return undefined;
          const [current] = yield* db
            .select()
            .from(incarnations)
            .where(
              and(
                eq(incarnations.runId, runId),
                eq(
                  incarnations.id,
                  root.currentIncarnationId ?? "00000000-0000-0000-0000-000000000000",
                ),
              ),
            );
          if (current === undefined) return yield* invalid("current-incarnation-missing");
          let runtimeInstanceId = current.runtimeInstanceId;
          let subject = current;
          if (current.removedAt !== null) {
            if (!allowRecovery || root.preservationDesired !== "recover") return undefined;
            const [child] = yield* db
              .select({ instance: creates.destinationRuntimeInstanceId })
              .from(creates)
              .innerJoin(
                operations,
                and(eq(creates.runId, operations.runId), eq(creates.operationId, operations.id)),
              )
              .where(
                and(
                  eq(creates.runId, runId),
                  eq(operations.incarnationId, current.id),
                  eq(operations.state, "settled"),
                  eq(
                    operations.episodeId,
                    root.retentionEpisodeId ?? "00000000-0000-0000-0000-000000000000",
                  ),
                ),
              );
            if (child === undefined) return undefined;
            runtimeInstanceId = child.instance;
            const [destination] = yield* db
              .select()
              .from(incarnations)
              .where(
                and(
                  eq(incarnations.runId, runId),
                  eq(incarnations.runtimeInstanceId, runtimeInstanceId),
                ),
              );
            if (
              destination === undefined ||
              destination.parentIncarnationId !== current.id ||
              destination.removedAt !== null
            )
              return yield* invalid("recovery-current-binding");
            subject = destination;
          }
          const [execution] = yield* db
            .select()
            .from(boatExecutions)
            .where(eq(boatExecutions.runtimeInstanceId, runtimeInstanceId));
          if (execution === undefined) return undefined;
          const record = yield* Effect.try({
            try: () => boatExecutionRecordSchema.parse(execution.record),
            catch: () =>
              new CapturePreservationError({
                operation: "resolve-current-execution",
                reason: "record-invalid",
              }),
          });
          if (
            record.target.runId !== runId ||
            record.target.runtimeInstanceId !== runtimeInstanceId ||
            record.target.sandboxId !== subject.sandboxId ||
            record.target.diskLineage !== subject.diskBindingId ||
            record.target.launchAttemptId !== subject.allocationOperationId ||
            record.target.deploymentId !== subject.deploymentId ||
            record.target.sourceId !== subject.publicationId ||
            record.target.manifestDigest !== subject.guestManifestHash
          )
            return yield* invalid("current-execution-binding");
          return record.target;
        }),
      ),
    recordWriterClosed: (claim, input) =>
      boundary(
        "parking-close",
        db.transaction(() =>
          Effect.gen(function* () {
            const value = yield* parse(closedCapsule, input, "parking-close", "invalid-input");
            const { operation, root } = yield* owned(claim, value.operationId);
            if (
              operation.kind !== "close-writer" ||
              operation.state === "prepared" ||
              operation.evidenceVersion !== root.evidenceVersion ||
              root.observationFences === null ||
              typeof root.observationFences !== "object" ||
              Object.keys(root.observationFences).length !== 0
            )
              return yield* invalid("parking-close-fence");
            yield* recordPositive(claim.runId, operation.id, "writer-closed", value);
            yield* settle(claim.runId, operation.id);
          }),
        ),
      ),
    prepareParkingSave: (claim) =>
      boundary(
        "parking-prepare-save",
        db.transaction(() =>
          Effect.gen(function* () {
            yield* markWriter(db);
            const [rootRaw] = yield* claimed(claim);
            const root = yield* parse(rootSchema, rootRaw, "parking-claim", "invalid-input");
            const [closeRaw] = yield* db
              .select()
              .from(operations)
              .where(
                and(
                  eq(operations.runId, claim.runId),
                  eq(
                    operations.incarnationId,
                    root.currentIncarnationId ?? "00000000-0000-0000-0000-000000000000",
                  ),
                  eq(
                    operations.episodeId,
                    root.retentionEpisodeId ?? "00000000-0000-0000-0000-000000000000",
                  ),
                  eq(operations.kind, "close-writer"),
                ),
              );
            const close = yield* parse(
              operationSchema,
              closeRaw,
              "parking-close-operation",
              "record-invalid",
            );
            const { source } = yield* owned(claim, close.id);
            if (close.state !== "settled") return yield* invalid("parking-close-unsettled");
            const [existing] = yield* db
              .select()
              .from(saves)
              .innerJoin(
                operations,
                and(eq(operations.runId, saves.runId), eq(operations.id, saves.operationId)),
              )
              .where(
                and(
                  eq(saves.runId, claim.runId),
                  eq(operations.incarnationId, source.id),
                  eq(operations.episodeId, close.episodeId),
                ),
              );
            if (existing !== undefined) return;
            const closed = yield* positive(claim.runId, close.id, "writer-closed", closedCapsule);
            const capsuleId = randomUUID(),
              artifactId = randomUUID(),
              saveId = randomUUID(),
              scopeId = randomUUID();
            // The park receipt the agent wrote on the closed disk (`boat-host.mjs`): the one file the
            // saved snapshot must carry byte for byte before the source VM is removed.
            const capsulePath = `/var/lib/sealant/agent/park-${close.id}.json`;
            yield* db
              .insert(operations)
              .values({
                runId: claim.runId,
                id: capsuleId,
                kind: "prepare-capsule",
                episodeId: close.episodeId,
                incarnationId: source.id,
                state: "settled",
                requestDigest: hash({ closeId: close.id, capsulePath, closed: closed.value }),
                evidenceVersion: root.evidenceVersion,
                issuedFence: claim.fence,
                issuedAt: sql`now()`,
                settledAt: sql`now()`,
              });
            yield* db
              .insert(capsules)
              .values({
                runId: claim.runId,
                operationId: capsuleId,
                closeOperationId: close.id,
                durableWorkReceiptId: closed.id,
                path: capsulePath,
                manifestHash: closed.value.capsuleHash,
              });
            yield* db
              .insert(artifacts)
              .values({
                runId: claim.runId,
                id: artifactId,
                episodeId: close.episodeId,
                sourceIncarnationId: source.id,
                accountScope: source.accountScope,
                name: `slnt-rp-${artifactId}`,
                closeReceiptId: closed.id,
              });
            yield* db
              .insert(operations)
              .values({
                runId: claim.runId,
                id: saveId,
                kind: "save-snapshot",
                episodeId: close.episodeId,
                incarnationId: source.id,
                requestDigest: hash({
                  sandboxId: source.sandboxId,
                  name: `slnt-rp-${artifactId}`,
                  scope: "personal",
                }),
                evidenceVersion: root.evidenceVersion,
              });
            yield* db
              .insert(saves)
              .values({
                runId: claim.runId,
                operationId: saveId,
                artifactId,
                capsuleOperationId: capsuleId,
                privateScopeReceiptId: scopeId,
                namespaceReceiptId: scopeId,
              });
          }),
        ),
      ),
    recordParkingScope: (claim, operationId, input) =>
      boundary(
        "parking-scope",
        db.transaction(() =>
          Effect.gen(function* () {
            const value = yield* parse(
              Schema.Struct({
                ...personalScope.fields,
                name: nonempty,
                sourceSandboxId: nonempty,
                absent: Schema.Literal(true),
              }),
              input,
              "parking-scope",
              "invalid-input",
            );
            const { operation, source } = yield* owned(claim, operationId);
            if (
              operation.kind !== "save-snapshot" ||
              operation.state !== "prepared" ||
              value.extra !== Math.max(0, value.used - value.included)
            )
              return yield* invalid("parking-scope-binding");
            const [raw] = yield* db
              .select()
              .from(saves)
              .where(and(eq(saves.runId, claim.runId), eq(saves.operationId, operationId)));
            const detail = yield* parse(saveSchema, raw, "parking-save", "record-invalid");
            const [artifact] = yield* db
              .select()
              .from(artifacts)
              .where(and(eq(artifacts.runId, claim.runId), eq(artifacts.id, detail.artifactId)));
            if (artifact?.name !== value.name || value.sourceSandboxId !== source.sandboxId)
              return yield* invalid("parking-scope-target");
            yield* recordPositive(
              claim.runId,
              operationId,
              "personal-scope",
              {
                org: value.org,
                name: value.name,
                sourceSandboxId: value.sourceSandboxId,
                absent: value.absent,
              },
              detail.privateScopeReceiptId,
            );
            yield* db
              .insert(allowances)
              .values({
                accountScope: source.accountScope,
                included: value.included,
                used: value.used,
                extra: value.extra,
                extraDailyDollars: value.extraDailyDollars,
                observedAt: sql`now()`,
              })
              .onConflictDoUpdate({
                target: allowances.accountScope,
                set: {
                  included: value.included,
                  used: value.used,
                  extra: value.extra,
                  extraDailyDollars: value.extraDailyDollars,
                  observedAt: sql`now()`,
                },
              });
          }),
        ),
      ),
    recordParkingSnapshot: (claim, operationId, input) =>
      boundary(
        "parking-snapshot",
        db.transaction(() =>
          Effect.gen(function* () {
            const value = yield* parse(
              snapshotIdentity,
              input,
              "parking-snapshot",
              "invalid-input",
            );
            const { operation, source } = yield* owned(claim, operationId);
            if (
              operation.kind !== "save-snapshot" ||
              operation.state === "prepared" ||
              value.sourceSandboxId !== source.sandboxId
            )
              return yield* invalid("parking-snapshot-binding");
            const [raw] = yield* db
              .select()
              .from(saves)
              .where(and(eq(saves.runId, claim.runId), eq(saves.operationId, operationId)));
            const detail = yield* parse(saveSchema, raw, "parking-save", "record-invalid");
            const [artifactRaw] = yield* db
              .select()
              .from(artifacts)
              .where(and(eq(artifacts.runId, claim.runId), eq(artifacts.id, detail.artifactId)));
            const artifact = yield* parse(
              artifactSchema,
              artifactRaw,
              "parking-artifact",
              "record-invalid",
            );
            if (
              value.name !== artifact.name ||
              (artifact.snapshotId !== null && artifact.snapshotId !== value.snapshotId)
            )
              return yield* invalid("parking-artifact-conflict");
            yield* recordPositive(claim.runId, operationId, "snapshot-ready", value);
            yield* db
              .update(artifacts)
              .set({ state: "saving", snapshotId: value.snapshotId })
              .where(
                and(
                  eq(artifacts.runId, claim.runId),
                  eq(artifacts.id, artifact.id),
                  sql`${artifacts.state} <> 'verified'`,
                ),
              );
          }),
        ),
      ),
    verifyParkingSnapshot: (claim, operationId, input) =>
      boundary(
        "parking-verify",
        db.transaction(() =>
          Effect.gen(function* () {
            const value = yield* parse(
              Schema.Struct({
                snapshotId: nonempty,
                path: nonempty,
                sha256: digest,
                bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
              }),
              input,
              "parking-verify",
              "invalid-input",
            );
            const { operation } = yield* owned(claim, operationId);
            if (operation.kind !== "save-snapshot" || operation.state === "prepared")
              return yield* invalid("parking-verify-operation");
            const [saveRaw] = yield* db
              .select()
              .from(saves)
              .where(and(eq(saves.runId, claim.runId), eq(saves.operationId, operationId)));
            const save = yield* parse(saveSchema, saveRaw, "parking-save", "record-invalid");
            const [capsuleRaw] = yield* db
              .select()
              .from(capsules)
              .where(
                and(
                  eq(capsules.runId, claim.runId),
                  eq(capsules.operationId, save.capsuleOperationId),
                ),
              );
            const capsule = yield* parse(
              capsuleSchema,
              capsuleRaw,
              "parking-capsule",
              "record-invalid",
            );
            const closed = yield* positive(
              claim.runId,
              capsule.closeOperationId,
              "writer-closed",
              closedCapsule,
            );
            const ready = yield* positive(
              claim.runId,
              operationId,
              "snapshot-ready",
              snapshotIdentity,
            );
            if (
              value.snapshotId !== ready.value.snapshotId ||
              value.path !== capsule.path ||
              value.sha256 !== closed.value.archiveHash ||
              value.bytes !== closed.value.storedBytes
            )
              return yield* invalid("parking-verify-binding");
            const id = yield* recordPositive(claim.runId, operationId, "capsule-verified", value);
            yield* db
              .update(artifacts)
              .set({
                state: "verified",
                privateScopeReceiptId: save.privateScopeReceiptId,
                namespaceReceiptId: save.namespaceReceiptId,
                capsuleVerificationReceiptId: id,
                archiveHash: value.sha256,
                archiveBytes: value.bytes,
                verifiedAt: sql`now()`,
              })
              .where(
                and(
                  eq(artifacts.runId, claim.runId),
                  eq(artifacts.id, save.artifactId),
                  sql`${artifacts.state} <> 'verified'`,
                ),
              );
            yield* settle(claim.runId, operationId);
          }),
        ),
      ),
    prepareParkingRemoval: (claim, resourceReceipt) =>
      boundary(
        "parking-removal",
        db.transaction(() =>
          Effect.gen(function* () {
            yield* parse(digest, resourceReceipt, "parking-revocation", "invalid-input");
            yield* markWriter(db);
            const [raw] = yield* claimed(claim);
            const root = yield* parse(rootSchema, raw, "parking-claim", "invalid-input");
            const [artifactRaw] = yield* db
              .select()
              .from(artifacts)
              .where(
                and(
                  eq(artifacts.runId, claim.runId),
                  eq(
                    artifacts.sourceIncarnationId,
                    root.currentIncarnationId ?? "00000000-0000-0000-0000-000000000000",
                  ),
                  eq(
                    artifacts.episodeId,
                    root.retentionEpisodeId ?? "00000000-0000-0000-0000-000000000000",
                  ),
                  eq(artifacts.state, "verified"),
                ),
              );
            const artifact = yield* parse(
              artifactSchema,
              artifactRaw,
              "parking-verified-artifact",
              "record-invalid",
            );
            const [closeRaw] = yield* db
              .select()
              .from(operations)
              .where(
                and(
                  eq(operations.runId, claim.runId),
                  eq(operations.incarnationId, artifact.sourceIncarnationId),
                  eq(operations.episodeId, artifact.episodeId),
                  eq(operations.kind, "close-writer"),
                ),
              );
            const close = yield* parse(
              operationSchema,
              closeRaw,
              "parking-close",
              "record-invalid",
            );
            const { source } = yield* owned(claim, close.id);
            const [existing] = yield* db
              .select()
              .from(operations)
              .where(
                and(
                  eq(operations.runId, claim.runId),
                  eq(operations.incarnationId, source.id),
                  eq(operations.episodeId, artifact.episodeId),
                  eq(operations.kind, "remove-sandbox"),
                ),
              );
            if (existing !== undefined) return;
            const operationId = randomUUID();
            yield* db
              .insert(operations)
              .values({
                runId: claim.runId,
                id: operationId,
                kind: "remove-sandbox",
                episodeId: artifact.episodeId,
                incarnationId: source.id,
                requestDigest: hash({ sandboxId: source.sandboxId, artifactId: artifact.id }),
                evidenceVersion: root.evidenceVersion,
              });
            const id = yield* recordPositive(claim.runId, operationId, "resources-revoked", {
              sha256: resourceReceipt,
            });
            yield* db
              .insert(removals)
              .values({
                runId: claim.runId,
                operationId,
                sandboxId: source.sandboxId,
                basis: "verified-recovery-custody",
                artifactId: artifact.id,
                closeOperationId: close.id,
                resourceRevocationReceiptId: id,
              });
          }),
        ),
      ),
    recordParkingDeletion: (claim, operationId, providerOperationId) =>
      boundary(
        "parking-deletion",
        db.transaction(() =>
          Effect.gen(function* () {
            yield* parse(nonempty, providerOperationId, "parking-deletion-id", "invalid-input");
            const { operation } = yield* owned(claim, operationId);
            if (operation.kind !== "remove-sandbox" || operation.state === "prepared")
              return yield* invalid("parking-deletion-not-issued");
            const [raw] = yield* db
              .select()
              .from(removals)
              .where(and(eq(removals.runId, claim.runId), eq(removals.operationId, operationId)));
            const removal = yield* parse(removalSchema, raw, "parking-removal", "record-invalid");
            if (
              removal.providerOperationId !== null &&
              removal.providerOperationId !== providerOperationId
            )
              return yield* invalid("parking-deletion-conflict");
            if (removal.providerOperationId === null)
              yield* db
                .update(removals)
                .set({ providerOperationId })
                .where(and(eq(removals.runId, claim.runId), eq(removals.operationId, operationId)));
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
            const [clock] = yield* db
              .select({ now: sql<string>`clock_timestamp()::text` })
              .from(roots)
              .where(eq(roots.runId, value.runId));
            const now = new Date(clock?.now ?? "invalid").getTime();
            if (operation.issuedAt === null || !Number.isFinite(now))
              return yield* Effect.fail(
                new CapturePreservationError({
                  operation: "observe-time",
                  reason: "record-invalid",
                }),
              );
            if (
              value.observedAt.getTime() < operation.issuedAt.getTime() ||
              value.observedAt.getTime() > now
            )
              return yield* Effect.fail(
                new CapturePreservationError({
                  operation: "observe-time",
                  reason: "invalid-input",
                }),
              );
            if (value.kind === "removal-completed" || operation.state === "settled") {
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
              if (
                operation.state === "settled" &&
                value.kind !== "removal-completed" &&
                (source.removalOperationId !== operation.id ||
                  source.removedAt === null ||
                  value.observedAt.getTime() > source.removedAt.getTime())
              )
                return yield* conflict();
            }
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
            if (operation.state === "settled")
              return value.kind === "removal-completed"
                ? ("duplicate" as const)
                : ("superseded" as const);
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
