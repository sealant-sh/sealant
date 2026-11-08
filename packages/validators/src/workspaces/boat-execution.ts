import { z } from "zod";

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

/** Immutable provider target, publication and run identity, reserved before bootstrap delivery. */
export const boatExecutionTargetSchema = z.strictObject({
  deploymentId: name,
  workspaceId: name,
  runId: name,
  runtimeInstanceId: name,
  launchAttemptId: name,
  sourceId: name,
  sandboxId: z.string().regex(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/),
  diskLineage: name,
  bootId: z.uuid(),
  manifestDigest: hash,
});
/** Parsed execution identity. Parsing does not authorize allocation or resource access. */
export type BoatExecutionTarget = z.infer<typeof boatExecutionTargetSchema>;

/** Pins are resolved once; retries deliver the original sealed bytes. */
export const boatAdmissionPinsSchema = z.strictObject({
  credentialVersions: z.array(z.strictObject({ id: name, version: name })),
  dotfiles: z.array(z.strictObject({ name, sha256: hash })),
});
/** Exact launch-time resolutions, kept inside the sealed admission envelope. */
export type BoatAdmissionPins = z.infer<typeof boatAdmissionPinsSchema>;

/** A stored row is parsed before any external effect or decryption. */
export const boatExecutionRecordSchema = z
  .strictObject({
    target: boatExecutionTargetSchema,
    exchangeId: z.uuid(),
    publicKey: z.string().min(100).max(4096),
    sealedExchange: z.string().min(1).nullable(),
    sealedControl: z.string().min(1).nullable(),
    admission: z
      .strictObject({
        operationId: z.uuid(),
        epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        digest: hash,
        sealedEnvelope: z.string().min(1).nullable(),
        sealedResumeEnvelope: z.string().min(1).optional(),
      })
      .nullable(),
    isolation: z.strictObject({ resourceReceipt: hash, tunnelReceipt: hash }).optional(),
    phase: z.enum(["exchange", "control", "prepared", "installed", "issued", "running", "held"]),
  })
  .superRefine((record, context) => {
    const valid =
      record.phase === "exchange"
        ? record.sealedExchange !== null &&
          record.sealedControl === null &&
          record.admission === null
        : record.sealedExchange === null &&
          record.sealedControl !== null &&
          (record.phase === "control"
            ? record.admission === null
            : record.admission !== null &&
              (record.phase === "running" || record.phase === "held"
                ? record.admission.sealedEnvelope === null
                : record.admission.sealedEnvelope !== null));
    if (
      !valid ||
      (record.isolation !== undefined &&
        !["installed", "issued", "running", "held"].includes(record.phase))
    )
      context.addIssue({ code: "custom", message: "Invalid execution phase" });
  });
/** Private persisted ownership, including ciphertext only for secret-bearing values. */
export type BoatExecutionRecord = z.infer<typeof boatExecutionRecordSchema>;
