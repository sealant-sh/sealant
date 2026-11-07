import { z } from "zod";

import { boatExecutionTargetSchema } from "./boat-execution.js";
import {
  nativeArtifactConsumerSchema,
  nativeImageScopeSchema,
  nativePublicationSchema,
} from "./native-publication.js";

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const sandbox = z.string().regex(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);

/** The worker must authorize scope before reservation. A consumer already pins this exact publication. */
export const boatAllocationInputSchema = z.strictObject({
  deploymentId: name,
  workspaceId: name,
  consumer: nativeArtifactConsumerSchema,
  launchAttemptId: name,
  publication: nativePublicationSchema,
  scope: nativeImageScopeSchema,
  sourceKind: z.enum(["git", "capture", "empty"]),
});
/** Immutable allocation inputs; retries may not substitute another source or run. */
export type BoatAllocationInput = z.infer<typeof boatAllocationInputSchema>;

/** Issuance is durable before create. Issued requests are observed, never automatically created again. */
export const boatAllocationRecordSchema = z
  .strictObject({
    input: boatAllocationInputSchema,
    idempotencyKey: z.uuid(),
    diskLineage: z.uuid(),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.enum(["reserved", "issued", "allocated", "bound", "held"]),
    sandboxId: sandbox.nullable(),
    conflictingSandboxes: z.array(sandbox).max(200),
    target: boatExecutionTargetSchema.nullable(),
    reason: z.enum(["allocation-conflict", "lifetime-unverified", "run-stopped"]).nullable(),
  })
  .superRefine((record, context) => {
    const { phase, sandboxId, target, input, reason } = record;
    const valid =
      phase === "reserved" || phase === "issued"
        ? sandboxId === null && target === null && reason === null
        : phase === "held"
          ? target === null &&
            reason !== null &&
            (reason === "lifetime-unverified" ? sandboxId !== null : sandboxId === null)
          : sandboxId !== null &&
            reason === null &&
            (phase === "allocated" ? target === null : target !== null);
    if (
      !valid ||
      (reason === "allocation-conflict"
        ? record.conflictingSandboxes.length < 2
        : record.conflictingSandboxes.length !== 0) ||
      new Set(record.conflictingSandboxes).size !== record.conflictingSandboxes.length ||
      (target !== null &&
        (target.deploymentId !== input.deploymentId ||
          target.workspaceId !== input.workspaceId ||
          target.runId !== input.consumer.runId ||
          target.runtimeInstanceId !== input.consumer.runtimeInstanceId ||
          target.launchAttemptId !== input.launchAttemptId ||
          target.sourceId !== input.publication.publicationId ||
          target.sandboxId !== sandboxId ||
          target.diskLineage !== record.diskLineage ||
          target.manifestDigest !== record.manifestDigest))
    )
      context.addIssue({ code: "custom", message: "Invalid allocation binding" });
  });
/** Persisted ownership contains public identities only. Bootstrap secrets belong to BoatExecution. */
export type BoatAllocationRecord = z.infer<typeof boatAllocationRecordSchema>;
