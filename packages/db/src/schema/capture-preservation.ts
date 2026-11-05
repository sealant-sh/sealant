import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  primaryKey,
  snakeCase,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { nativePublications } from "./native-publications.js";
import { workspaceCaptureDrains } from "./workspace-build-jobs.js";

const instant = () => timestamp({ mode: "date", withTimezone: true });

/** Frozen policy for one continuous retained lineage, including recovered descendants. */
export const captureRetentionEpisodes = snakeCase.table(
  "capture_retention_episodes",
  {
    runId: text()
      .notNull()
      .references(() => workspaceCaptureDrains.runId, { onDelete: "restrict" }),
    id: uuid().notNull(),
    retainedAt: instant().notNull(),
    recordedAt: instant().notNull().defaultNow(),
    timeBasis: text({ enum: ["recorded", "existing-retention"] }).notNull(),
    delaySeconds: integer().notNull(),
    policyRevision: text().notNull(),
    eligibleAt: instant().notNull(),
    dischargedAt: instant(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.id] }),
    uniqueIndex("capture_retention_one_open")
      .on(t.runId)
      .where(sql`${t.dischargedAt} is null`),
    check("capture_retention_delay", sql`${t.delaySeconds} between 300 and 604800`),
    check(
      "capture_retention_deadline",
      sql`${t.eligibleAt} = ${t.retainedAt} + ${t.delaySeconds} * interval '1 second'`,
    ),
    check("capture_retention_basis", sql`${t.timeBasis} in ('recorded','existing-retention')`),
  ],
);

/** Immutable provider identity. Lifecycle observations never repoint the original runtime row. */
export const captureExecutorIncarnations = snakeCase.table(
  "capture_executor_incarnations",
  {
    runId: text()
      .notNull()
      .references(() => workspaceCaptureDrains.runId, { onDelete: "restrict" }),
    id: uuid().notNull(),
    runtimeInstanceId: text().notNull().unique(),
    deploymentId: text().notNull(),
    accountScope: text().notNull(),
    sandboxId: text().notNull(),
    diskBindingId: uuid().notNull(),
    allocationOperationId: uuid().notNull(),
    publicationId: uuid()
      .notNull()
      .references(() => nativePublications.id, { onDelete: "restrict" }),
    captureLaunchId: text().notNull(),
    guestEpoch: uuid().notNull(),
    guestManifestHash: text().notNull(),
    parentIncarnationId: uuid(),
    sourceArtifactId: uuid(),
    computeState: text({ enum: ["running", "not-running", "unknown"] })
      .notNull()
      .default("unknown"),
    computeObservedAt: instant(),
    indicativeHourlyDollars: doublePrecision(),
    removedAt: instant(),
    removalOperationId: uuid(),
    createdAt: instant().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.id] }),
    unique("capture_executor_scope_sandbox").on(t.accountScope, t.sandboxId),
    unique("capture_executor_subject").on(t.runId, t.id, t.sandboxId),
    foreignKey({ columns: [t.runId, t.parentIncarnationId], foreignColumns: [t.runId, t.id] }),
    index("capture_executor_descendants").on(t.sourceArtifactId, t.id),
    check(
      "capture_executor_parent",
      sql`(${t.parentIncarnationId} is null) = (${t.sourceArtifactId} is null)`,
    ),
    check(
      "capture_executor_compute",
      sql`${t.computeState} in ('running','not-running','unknown') and (${t.computeState} = 'unknown' or ${t.computeObservedAt} is not null)`,
    ),
    check(
      "capture_executor_removal",
      sql`(${t.removedAt} is null) = (${t.removalOperationId} is null)`,
    ),
  ],
);

/** Reserved recovery names remain tombstones after retirement and never enter the image catalog. */
export const captureRecoveryArtifacts = snakeCase.table(
  "capture_recovery_artifacts",
  {
    runId: text().notNull(),
    id: uuid().notNull(),
    episodeId: uuid().notNull(),
    sourceIncarnationId: uuid().notNull(),
    accountScope: text().notNull(),
    name: text().notNull(),
    snapshotId: text(),
    state: text({ enum: ["reserved", "saving", "verified", "retiring", "removed", "unknown"] })
      .notNull()
      .default("reserved"),
    closeReceiptId: uuid(),
    privateScopeReceiptId: uuid(),
    namespaceReceiptId: uuid(),
    capsuleVerificationReceiptId: uuid(),
    archiveHash: text(),
    archiveBytes: bigint({ mode: "number" }),
    verifiedAt: instant(),
    retiredAt: instant(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.id] }),
    foreignKey({
      columns: [t.runId, t.episodeId],
      foreignColumns: [captureRetentionEpisodes.runId, captureRetentionEpisodes.id],
    }),
    foreignKey({
      columns: [t.runId, t.sourceIncarnationId],
      foreignColumns: [captureExecutorIncarnations.runId, captureExecutorIncarnations.id],
    }),
    unique("capture_artifact_scope_name").on(t.accountScope, t.name),
    unique("capture_artifact_scope_snapshot").on(t.accountScope, t.snapshotId),
    unique("capture_artifact_source_episode").on(t.runId, t.episodeId, t.sourceIncarnationId),
    check("capture_artifact_name", sql`${t.name} ~ '^slnt-rp-[0-9a-f-]{36}$'`),
    check(
      "capture_artifact_state",
      sql`${t.state} in ('reserved','saving','verified','retiring','removed','unknown')`,
    ),
    check(
      "capture_artifact_verified",
      sql`${t.state} not in ('verified','retiring') or (${t.snapshotId} is not null and length(${t.snapshotId}) > 0 and ${t.closeReceiptId} is not null and ${t.privateScopeReceiptId} is not null and ${t.namespaceReceiptId} is not null and ${t.capsuleVerificationReceiptId} is not null and ${t.archiveHash} is not null and ${t.archiveHash} ~ '^[0-9a-f]{64}$' and ${t.archiveBytes} is not null and ${t.archiveBytes} > 0 and ${t.verifiedAt} is not null)`,
    ),
  ],
);

/** An issued packet stays occupied after claim expiry. Only attributable settlement ends it. */
export const capturePreservationOperations = snakeCase.table(
  "capture_preservation_operations",
  {
    runId: text().notNull(),
    id: uuid().notNull(),
    kind: text({
      enum: [
        "close-writer",
        "prepare-capsule",
        "save-snapshot",
        "remove-sandbox",
        "create-recovery",
        "admit-recovery",
        "retire-snapshot",
      ],
    }).notNull(),
    episodeId: uuid().notNull(),
    incarnationId: uuid().notNull(),
    state: text({ enum: ["prepared", "issued", "unknown", "settled"] })
      .notNull()
      .default("prepared"),
    requestVersion: integer().notNull().default(1),
    requestDigest: text().notNull(),
    evidenceVersion: bigint({ mode: "number" }).notNull(),
    issuedFence: bigint({ mode: "number" }),
    issuedAt: instant(),
    settledAt: instant(),
    nextObservationAt: instant(),
    createdAt: instant().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.id] }),
    unique("capture_operation_kind_binding").on(t.runId, t.id, t.kind),
    foreignKey({
      columns: [t.runId, t.episodeId],
      foreignColumns: [captureRetentionEpisodes.runId, captureRetentionEpisodes.id],
    }),
    foreignKey({
      columns: [t.runId, t.incarnationId],
      foreignColumns: [captureExecutorIncarnations.runId, captureExecutorIncarnations.id],
    }),
    uniqueIndex("capture_operation_source_kind")
      .on(t.runId, t.episodeId, t.incarnationId, t.kind)
      .where(sql`${t.kind} <> 'retire-snapshot'`),
    uniqueIndex("capture_operation_writer_slot")
      .on(t.runId)
      .where(
        sql`${t.kind} in ('close-writer','create-recovery','admit-recovery') and ${t.state} <> 'settled'`,
      ),
    index("capture_operation_observation_due")
      .on(t.nextObservationAt, t.id)
      .where(sql`${t.state} in ('issued','unknown')`),
    check(
      "capture_operation_kind",
      sql`${t.kind} in ('close-writer','prepare-capsule','save-snapshot','remove-sandbox','create-recovery','admit-recovery','retire-snapshot')`,
    ),
    check("capture_operation_state", sql`${t.state} in ('prepared','issued','unknown','settled')`),
    check(
      "capture_operation_request",
      sql`${t.requestVersion} = 1 and ${t.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "capture_operation_issuance",
      sql`(${t.state} = 'prepared' and ${t.issuedAt} is null and ${t.issuedFence} is null and ${t.settledAt} is null) or (${t.state} in ('issued','unknown') and ${t.issuedAt} is not null and ${t.issuedFence} is not null and ${t.settledAt} is null) or (${t.state} = 'settled' and ${t.issuedAt} is not null and ${t.issuedFence} is not null and ${t.settledAt} is not null)`,
    ),
  ],
);

const detailColumns = () => ({ runId: text().notNull(), operationId: uuid().notNull() });
/** A close reservation is an intention, never permission to stop a guest. */
export const captureParkingCloses = snakeCase.table(
  "capture_parking_closes",
  {
    ...detailColumns(),
    diskBindingId: uuid().notNull(),
    guestEpoch: uuid().notNull(),
    guestManifestHash: text().notNull(),
    policyRevision: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.operationId] }),
    foreignKey({
      columns: [t.runId, t.operationId],
      foreignColumns: [capturePreservationOperations.runId, capturePreservationOperations.id],
    }),
  ],
);

/** Capsule preparation requires a previously recorded terminal close. */
export const captureCapsulePreparations = snakeCase.table(
  "capture_capsule_preparations",
  {
    ...detailColumns(),
    closeOperationId: uuid().notNull(),
    durableWorkReceiptId: uuid().notNull(),
    path: text().notNull(),
    manifestHash: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.operationId] }),
    foreignKey({
      columns: [t.runId, t.operationId],
      foreignColumns: [capturePreservationOperations.runId, capturePreservationOperations.id],
    }),
    foreignKey({
      columns: [t.runId, t.closeOperationId],
      foreignColumns: [captureParkingCloses.runId, captureParkingCloses.operationId],
    }),
  ],
);

/** Save dispatch is bound to one permanent name and exact prepared source. */
export const captureSnapshotSaves = snakeCase.table(
  "capture_snapshot_saves",
  {
    ...detailColumns(),
    artifactId: uuid().notNull(),
    capsuleOperationId: uuid().notNull(),
    privateScopeReceiptId: uuid().notNull(),
    namespaceReceiptId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.operationId] }),
    foreignKey({
      columns: [t.runId, t.operationId],
      foreignColumns: [capturePreservationOperations.runId, capturePreservationOperations.id],
    }),
    foreignKey({
      columns: [t.runId, t.artifactId],
      foreignColumns: [captureRecoveryArtifacts.runId, captureRecoveryArtifacts.id],
    }),
    foreignKey({
      columns: [t.runId, t.capsuleOperationId],
      foreignColumns: [captureCapsulePreparations.runId, captureCapsulePreparations.operationId],
    }),
  ],
);

/** Removal evidence names the exact sandbox, never inventory absence. */
export const captureSandboxRemovals = snakeCase.table(
  "capture_sandbox_removals",
  {
    ...detailColumns(),
    sandboxId: text().notNull(),
    basis: text({ enum: ["verified-recovery-custody", "final", "discard"] }).notNull(),
    artifactId: uuid(),
    closeOperationId: uuid(),
    resourceRevocationReceiptId: uuid(),
    providerOperationId: text(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.operationId] }),
    foreignKey({
      columns: [t.runId, t.operationId],
      foreignColumns: [capturePreservationOperations.runId, capturePreservationOperations.id],
    }),
    foreignKey({
      columns: [t.runId, t.artifactId],
      foreignColumns: [captureRecoveryArtifacts.runId, captureRecoveryArtifacts.id],
    }),
    foreignKey({
      columns: [t.runId, t.closeOperationId],
      foreignColumns: [captureParkingCloses.runId, captureParkingCloses.operationId],
    }),
    check(
      "capture_removal_basis",
      sql`${t.basis} in ('verified-recovery-custody','final','discard') and (${t.basis} <> 'verified-recovery-custody' or (${t.artifactId} is not null and ${t.closeOperationId} is not null and ${t.resourceRevocationReceiptId} is not null))`,
    ),
  ],
);

/** Unknown creates keep their destination identity and artifact reservation. */
export const captureRecoveryCreates = snakeCase.table(
  "capture_recovery_creates",
  {
    ...detailColumns(),
    artifactId: uuid().notNull(),
    sourceRemovalOperationId: uuid().notNull(),
    destinationIncarnationId: uuid().notNull(),
    destinationRuntimeInstanceId: text().notNull().unique(),
    createKey: uuid().notNull().unique(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.operationId] }),
    foreignKey({
      columns: [t.runId, t.operationId],
      foreignColumns: [capturePreservationOperations.runId, capturePreservationOperations.id],
    }),
    foreignKey({
      columns: [t.runId, t.artifactId],
      foreignColumns: [captureRecoveryArtifacts.runId, captureRecoveryArtifacts.id],
    }),
    foreignKey({
      columns: [t.runId, t.sourceRemovalOperationId],
      foreignColumns: [captureSandboxRemovals.runId, captureSandboxRemovals.operationId],
    }),
  ],
);

/** Recovery admission remains separate from allocation and uses fresh guest identities. */
export const captureRecoveryAdmissions = snakeCase.table(
  "capture_recovery_admissions",
  {
    ...detailColumns(),
    createOperationId: uuid().notNull(),
    hydratedReceiptId: uuid().notNull(),
    rebindReceiptId: uuid().notNull(),
    guestEpoch: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.operationId] }),
    foreignKey({
      columns: [t.runId, t.operationId],
      foreignColumns: [capturePreservationOperations.runId, capturePreservationOperations.id],
    }),
    foreignKey({
      columns: [t.runId, t.createOperationId],
      foreignColumns: [captureRecoveryCreates.runId, captureRecoveryCreates.operationId],
    }),
  ],
);

/** Snapshot retirement keeps the permanent identity and its discharge fence. */
export const captureSnapshotRetirements = snakeCase.table(
  "capture_snapshot_retirements",
  {
    ...detailColumns(),
    artifactId: uuid().notNull(),
    dischargeReceiptId: uuid().notNull(),
    namespaceReceiptId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.operationId] }),
    foreignKey({
      columns: [t.runId, t.operationId],
      foreignColumns: [capturePreservationOperations.runId, capturePreservationOperations.id],
    }),
    foreignKey({
      columns: [t.runId, t.artifactId],
      foreignColumns: [captureRecoveryArtifacts.runId, captureRecoveryArtifacts.id],
    }),
  ],
);

/** Append-only observations do not themselves confer custody or dispatch authority. */
export const capturePreservationReceipts = snakeCase.table(
  "capture_preservation_receipts",
  {
    runId: text().notNull(),
    id: uuid().notNull(),
    operationId: uuid().notNull(),
    digest: text().notNull(),
    kind: text({ enum: ["unknown", "pending", "removal-completed"] }).notNull(),
    sandboxId: text().notNull(),
    providerOperationId: text(),
    observedAt: instant().notNull(),
    recordedAt: instant().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.id] }),
    foreignKey({
      columns: [t.runId, t.operationId],
      foreignColumns: [capturePreservationOperations.runId, capturePreservationOperations.id],
    }),
    check(
      "capture_receipt_kind",
      sql`${t.kind} in ('unknown','pending','removal-completed') and (${t.kind} <> 'removal-completed' or length(${t.providerOperationId}) > 0)`,
    ),
  ],
);

/** Issued operations and descendants keep their artifacts pinned until canonical release. */
export const capturePreservationConsumers = snakeCase.table(
  "capture_preservation_consumers",
  {
    runId: text().notNull(),
    operationId: uuid().notNull(),
    artifactId: uuid().notNull(),
    releasedAt: instant(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.operationId, t.artifactId] }),
    foreignKey({
      columns: [t.runId, t.operationId],
      foreignColumns: [capturePreservationOperations.runId, capturePreservationOperations.id],
    }),
    foreignKey({
      columns: [t.runId, t.artifactId],
      foreignColumns: [captureRecoveryArtifacts.runId, captureRecoveryArtifacts.id],
    }),
    index("capture_consumer_artifact").on(t.artifactId, t.releasedAt),
  ],
);

/** Account observations are shared aggregates, never per-artifact included-slot assignments. */
export const boatSnapshotAllowanceObservations = snakeCase.table(
  "boat_snapshot_allowance_observations",
  {
    accountScope: text().primaryKey(),
    included: integer().notNull(),
    used: integer().notNull(),
    extra: integer().notNull(),
    extraDailyDollars: doublePrecision().notNull(),
    observedAt: instant().notNull(),
  },
  (t) => [
    check(
      "boat_allowance_counts",
      sql`${t.included} = 10 and ${t.used} >= 0 and ${t.extra} = greatest(0, ${t.used} - ${t.included}) and ${t.extraDailyDollars} >= 0`,
    ),
  ],
);
