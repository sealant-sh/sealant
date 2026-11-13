import type { BoatFailureKind } from "@sealant/api-contracts";
import { z } from "zod";

import { workspaceImageProbeSchema } from "./workspace-image-probe.js";

/** Content hashes are lowercase SHA-256, without an OCI prefix. */
export const nativeHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Historical facts remain readable after a trusted runtime pin changes. */
export const nativeRuntimeIdentitySchema = z.object({
  source: z
    .string()
    .regex(/^ghcr\.io\/sealant-sh\/sealantd-next:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/),
  platform: z.literal("linux/amd64"),
  manifest: nativeHashSchema,
  sealantd: nativeHashSchema,
  sealantctl: nativeHashSchema,
});

/** Scope is supplied by the authorized caller; parsing alone grants no authorization. */
export const nativeImageScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("owner"),
    ownerUserId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((id) => !id.startsWith("rdm:")),
  }),
  z.object({
    kind: z.literal("resource-domain"),
    domainId: z
      .string()
      .regex(/^rdm:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  }),
]);

/** All immutable inputs participating in native publication coalescing. */
export const nativePublicationKeySchema = z.object({
  deploymentId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\p{Cc}]+$/u)
    .refine((s) => Buffer.byteLength(s, "utf8") <= 256),
  scope: nativeImageScopeSchema,
  recipeHash: nativeHashSchema,
  runtime: nativeRuntimeIdentitySchema,
  assetsHash: nativeHashSchema,
  platform: z.literal("linux/amd64"),
});

/** Reserved before provider work, independent of a temporary worker claim. */
export const nativeBuildOwnershipSchema = z.object({
  publicationId: z.uuid(),
  buildId: z.uuid(),
  key: nativePublicationKeySchema,
});

/** Provider snapshot handle with independently checked source and creation facts. */
export const nativeSnapshotArtifactSchema = z.object({
  kind: z.literal("boat-saved-snapshot"),
  owner: z.uuid(),
  build: z.uuid(),
  recipeHash: nativeHashSchema,
  receiptHash: nativeHashSchema,
  runtime: nativeRuntimeIdentitySchema,
  identity: z.object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
      .brand<"BoatSnapshotName">(),
    sourceSandboxId: z
      .string()
      .regex(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/)
      .brand<"BoatSandboxId">(),
    createdAt: z.iso.datetime(),
    snapshotId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,256}$/)
      .optional(),
  }),
});

/** Factual daemon support does not establish executor recovery integration. */
export const nativePublicationEvidenceSchema = z.object({
  imageProbe: workspaceImageProbeSchema,
  receiptHash: nativeHashSchema,
  receipt: z.string().min(1).max(262144),
  runtime: nativeRuntimeIdentitySchema,
  assetsHash: nativeHashSchema,
  recipeHash: nativeHashSchema,
  daemonRecovery: z.enum(["supported", "unsupported", "unknown"]),
  executorRecovery: z.literal("unverified"),
});

/** Exact owned publication; this is never an OCI image. */
export const nativePublicationSchema = z.object({
  kind: z.literal("boat-native"),
  publicationId: z.uuid(),
  snapshot: nativeSnapshotArtifactSchema,
  evidence: nativePublicationEvidenceSchema,
});

/** Immutable build reservation handed to the native mechanism. */
export type NativeBuildOwnership = z.infer<typeof nativeBuildOwnershipSchema>;
/** Complete internal publication key, with explicit caller-authorized scope. */
export type NativePublicationKey = z.infer<typeof nativePublicationKeySchema>;
/** Parsed native publication and its original installation evidence. */
export type NativePublication = z.infer<typeof nativePublicationSchema>;
/** Probe, receipt and measured runtime provenance preserved through reuse. */
export type NativePublicationEvidence = z.infer<typeof nativePublicationEvidenceSchema>;

/**
 * runId is the workspace_attempts UUID, not a runs-table conversation key.
 * The initial runtime-instance row uses that same attempt UUID; keep the equality fence.
 */
export const nativeArtifactConsumerSchema = z
  .object({
    runId: z.uuid().brand<"NativeConsumerAttemptId">(),
    runtimeInstanceId: z.uuid().brand<"NativeConsumerRuntimeInstanceId">(),
  })
  .refine((consumer) => String(consumer.runId) === String(consumer.runtimeInstanceId));

/** A consumer remains pinned in every state except canonical explicit release. */
export const nativeConsumerStateSchema = z.enum([
  "pending",
  "live",
  "retained",
  "unknown",
  "released",
]);

/** A generation and token fence each external operation's completion. */
export const nativeCatalogClaimSchema = z.object({
  publicationId: z.uuid(),
  generation: z.number().int().min(1),
  token: z.uuid(),
  purpose: z.enum(["build", "reconcile", "remove"]),
  expiresAt: z.date(),
});
/**
 * The Boat failure kinds after which a build may pass on a later try with the same key and
 * account, so the next launch spends the one fresh reservation on it: Boat did not answer, a rate
 * limit, no machine, the plan's running limit (it frees when a session stops), and a refusal
 * sealant does not classify. Every other kind (the key, its permissions, the account, billing, a
 * trial, the snapshot allowance) needs a person; the build stays quarantined with that kind as its
 * reason.
 */
export const NATIVE_REBUILD_BOAT_FAILURES = [
  "native-boat-no-answer",
  "native-boat-rate-limited",
  "native-boat-no-machine",
  "native-boat-running-limit",
  "native-boat-refused",
] as const satisfies readonly `native-boat-${BoatFailureKind}`[];

/**
 * The Boat failure kinds a person fixes in Boat (a new key, a permission, paying, a plan, a freed
 * snapshot slot). A build quarantined for one stays so, reading its kind back to every launch,
 * until the cause may have cleared: the account's key is rotated, or a check of it (on demand or
 * the daily refresh) reports the wallet can start. Then it is reopened, and the next launch tries
 * it once more; a fresh refusal quarantines the new build with the fresh reason, until the next
 * such event.
 */
export const NATIVE_REOPEN_BOAT_FAILURES = [
  "native-boat-key-refused",
  "native-boat-key-expired",
  "native-boat-permission-missing",
  "native-boat-sandbox-outside-key",
  "native-boat-organization-mismatch",
  "native-boat-account-suspended",
  "native-boat-billing-required",
  "native-boat-member-cap",
  "native-boat-trial-restricted",
  "native-boat-snapshot-allowance-full",
] as const satisfies readonly `native-boat-${BoatFailureKind}`[];
export const nativeReopenReasonSchema = z.enum(NATIVE_REOPEN_BOAT_FAILURES);
export type NativeReopenReason = (typeof NATIVE_REOPEN_BOAT_FAILURES)[number];

/** Only completed construction failures may spend one fresh reservation. Integrity and cleanup stay closed. */
export const nativeBuildRetryReasonSchema = z.enum([
  "native-provider-transport_error",
  "native-provider-provider_error",
  "native-guest-command-failed",
  "native-sandbox-failed",
  "native-save-failed",
  "native-interrupted",
  ...NATIVE_REBUILD_BOAT_FAILURES,
]);
const reservation = z.object({
  buildAttempt: z.number().int().min(1).max(2).default(1),
  replacesPublicationId: z.uuid().nullable().default(null),
  ownership: nativeBuildOwnershipSchema,
  generation: z.number().int().nonnegative(),
  claim: nativeCatalogClaimSchema.nullable(),
  createdAt: z.date(),
  readyAt: z.date().nullable(),
  reason: z.string().nullable(),
  /** When a quarantine a person may have fixed was reopened (`NATIVE_REOPEN_BOAT_FAILURES`). */
  reopenedAt: z.date().nullable().default(null),
});
/** Parsed lifecycle states keep incomplete publications out of ready/removal paths. */
export const nativeCatalogRecordSchema = z
  .discriminatedUnion("state", [
    reservation.extend({ state: z.literal("reserved"), publication: z.null() }),
    reservation.extend({ state: z.literal("building"), publication: z.null() }),
    // Replaced by the next launch's build: a first build that failed for a retryable reason, or a
    // quarantine a person may have fixed, reopened (either attempt).
    reservation.extend({
      state: z.literal("superseded"),
      publication: z.null(),
      claim: z.null(),
      reason: z.union([nativeBuildRetryReasonSchema, nativeReopenReasonSchema]),
    }),
    reservation.extend({ state: z.literal("ready"), publication: nativePublicationSchema }),
    reservation.extend({ state: z.literal("retiring"), publication: nativePublicationSchema }),
    reservation.extend({ state: z.literal("removed"), publication: nativePublicationSchema }),
    reservation.extend({
      state: z.literal("quarantined"),
      publication: nativePublicationSchema.nullable(),
    }),
  ])
  .refine((record) => (record.buildAttempt === 1) === (record.replacesPublicationId === null), {
    message: "Replacement builds require their exact predecessor",
  })
  .refine(
    (record) =>
      record.state !== "superseded" ||
      (nativeReopenReasonSchema.safeParse(record.reason).success
        ? record.reopenedAt !== null
        : record.buildAttempt === 1),
    { message: "Only a first build, or a reopened quarantine, is superseded" },
  );
/** Exact durable consumer binding, unchanged by retries. */
export type NativeArtifactConsumer = z.infer<typeof nativeArtifactConsumerSchema>;
/** Parsed reservation; editable ORM rows never leave the repository. */
export type NativeCatalogRecord = z.infer<typeof nativeCatalogRecordSchema>;
/** Claim ownership is temporary; expiration never releases a consumer. */
export type NativeCatalogClaim = z.infer<typeof nativeCatalogClaimSchema>;
/** A released consumer is a permanent tombstone for that binding. */
export type NativeConsumerState = z.infer<typeof nativeConsumerStateSchema>;
