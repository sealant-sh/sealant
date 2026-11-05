import { z } from "zod";

import { workspaceImageProbeSchema } from "./builder.js";

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
  socat: nativeHashSchema,
  relay: nativeHashSchema,
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

/** Runtime-instance rows are currently keyed by run_id, not a second invented UUID. */
export const nativeArtifactConsumerSchema = z
  .object({
    runId: z
      .string()
      .regex(/^run_[A-Za-z0-9_-]+$/)
      .brand<"NativeConsumerRunId">(),
    runtimeInstanceId: z
      .string()
      .regex(/^run_[A-Za-z0-9_-]+$/)
      .brand<"NativeConsumerInstanceId">(),
  })
  .refine((consumer) => consumer.runId.toString() === consumer.runtimeInstanceId.toString());

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
const reservation = z.object({
  ownership: nativeBuildOwnershipSchema,
  generation: z.number().int().nonnegative(),
  claim: nativeCatalogClaimSchema.nullable(),
  createdAt: z.date(),
  readyAt: z.date().nullable(),
  reason: z.string().nullable(),
});
/** Parsed lifecycle states keep incomplete publications out of ready/removal paths. */
export const nativeCatalogRecordSchema = z.discriminatedUnion("state", [
  reservation.extend({ state: z.literal("reserved"), publication: z.null() }),
  reservation.extend({ state: z.literal("building"), publication: z.null() }),
  reservation.extend({ state: z.literal("ready"), publication: nativePublicationSchema }),
  reservation.extend({ state: z.literal("retiring"), publication: nativePublicationSchema }),
  reservation.extend({ state: z.literal("removed"), publication: nativePublicationSchema }),
  reservation.extend({
    state: z.literal("quarantined"),
    publication: nativePublicationSchema.nullable(),
  }),
]);
/** Exact durable consumer binding, unchanged by retries. */
export type NativeArtifactConsumer = z.infer<typeof nativeArtifactConsumerSchema>;
/** Parsed reservation; editable ORM rows never leave the repository. */
export type NativeCatalogRecord = z.infer<typeof nativeCatalogRecordSchema>;
/** Claim ownership is temporary; expiration never releases a consumer. */
export type NativeCatalogClaim = z.infer<typeof nativeCatalogClaimSchema>;
/** A released consumer is a permanent tombstone for that binding. */
export type NativeConsumerState = z.infer<typeof nativeConsumerStateSchema>;
