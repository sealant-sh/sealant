import { z } from "zod";

import {
  nativeArtifactConsumerSchema,
  nativeImageScopeSchema,
  nativePublicationSchema,
} from "./native-publication.js";

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sandbox = z.string().regex(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
const instant = z.date().nullable();

/** Immutable provider target, publication and run identity, reserved before bootstrap delivery. */
export const boatExecutionTargetSchema = z.strictObject({
  deploymentId: name,
  workspaceId: name,
  runId: name,
  runtimeInstanceId: name,
  launchAttemptId: name,
  sourceId: name,
  sandboxId: sandbox,
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
/** Exact launch-time resolutions, kept inside the sealed launch material. */
export type BoatAdmissionPins = z.infer<typeof boatAdmissionPinsSchema>;

/** The worker must authorize scope before reservation. A consumer already pins this exact publication. */
export const boatRunInputSchema = z.strictObject({
  deploymentId: name,
  /**
   * The stored Boat account the run is created under (its key, its deployment). Absent: the
   * install's default account, the env key.
   */
  accountId: z.uuid().optional(),
  workspaceId: name,
  consumer: nativeArtifactConsumerSchema,
  launchAttemptId: name,
  publication: nativePublicationSchema,
  scope: nativeImageScopeSchema,
  sourceKind: z.enum(["git", "capture", "empty"]),
  /**
   * `"none"`: the workspace was created never to be linked to project resources
   * (`runtime.resources` of its stored spec), read once at launch and frozen on the run's row. Such
   * a run has no resource gateway, tunnel or in-VM resolver; readiness, the removal and every sweep
   * read this, and nothing derives it again. Absent: the run has a gateway and a tunnel.
   */
  resources: z.literal("none").optional(),
});
/** What a launch asks Boat for; retries may not substitute another source or run. */
export type BoatRunInput = z.infer<typeof boatRunInputSchema>;

/**
 * What a launch was isolated under, frozen before it is pushed: the gateway's and the guest's
 * network receipts, or the fact that the run has no resource network at all (a workspace created
 * with `runtime.resources: "none"`), after which the guest is never given one.
 */
export const boatRunIsolationSchema = z.union([
  z.strictObject({ resourceReceipt: hash, tunnelReceipt: hash }),
  z.strictObject({ resources: z.literal("none") }),
]);
export type BoatRunIsolation = z.infer<typeof boatRunIsolationSchema>;

/**
 * Why a run's VM is held for an operator. `create-unresolved`: create was issued, no VM carries
 * its labels, and its key may have expired at Boat, so neither a replay nor a refusal can say
 * whether a VM exists. Discovery keeps looking.
 */
export const boatRunHeldReasonSchema = z.enum([
  "allocation-conflict",
  "lifetime-unverified",
  "run-stopped",
  "create-unresolved",
]);

/**
 * How sealant knows Boat holds no VM for a run. `not-found`: Boat's typed 404 for a VM it had
 * reported past creation. `deletion-completed`: Boat's own deletion operation for it completed.
 * `never-created`: create was never issued, or Boat definitively refused it under the run's key.
 */
export const boatRunAbsentBasisSchema = z.enum([
  "not-found",
  "deletion-completed",
  "never-created",
]);
export type BoatRunAbsentBasis = z.infer<typeof boatRunAbsentBasisSchema>;

/**
 * One Boat run, as its one row holds it. Every fact is a column, written by one guarded statement
 * and never rewritten: what was asked of Boat (the create and its key), what Boat answered (the
 * VM, its creation seen, its deletion, its absence), and what was handed to the VM's agent (the
 * bound target, the sealed bearer, the launch). Secret-bearing values are ciphertext only.
 */
export const boatRunSchema = z
  .strictObject({
    runId: name,
    deploymentId: name,
    /** The stored Boat account the run was created under; null for the install's default one. */
    accountId: z.uuid().nullable(),
    publicationId: z.uuid(),
    workspaceId: name,
    launchAttemptId: name,
    manifestDigest: hash,
    /** The saved snapshot create names, frozen so a replay under the key asks for the same VM. */
    snapshotName: z.string().min(1),
    resources: z.literal("none").nullable(),
    idempotencyKey: z.uuid(),
    diskLineage: z.uuid(),
    /**
     * When create was durably issued, by the database's clock. It bounds only when a replay under
     * the same idempotency key is safe (Boat keeps a key for 24 hours); it never stands for an
     * observation.
     */
    createIssuedAt: instant,
    sandboxId: sandbox.nullable(),
    /**
     * When Boat first reported the VM past creation (a state after `cloning`). Until then a 404 may
     * be Boat not yet able to read a VM it accepted, so it is never absence.
     */
    createdSeenAt: instant,
    target: boatExecutionTargetSchema.nullable(),
    exchangeId: z.uuid().nullable(),
    /** The bind exchange in flight: its public key and its sealed private key, until the bearer is sealed. */
    exchangePublicKey: z.string().min(100).max(4096).nullable(),
    sealedExchange: z.string().min(1).nullable(),
    sealedControl: z.string().min(1).nullable(),
    admissionOperationId: z.uuid().nullable(),
    admissionEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    admissionDigest: hash.nullable(),
    /** Whether the launch asks the agent for the workspace's own Docker (launch contract v2). */
    docker: z.boolean().nullable(),
    /** The sealed launch material: pushed once, then kept for redaction until Boat has no VM. */
    sealedLaunch: z.string().min(1).nullable(),
    isolation: boatRunIsolationSchema.nullable(),
    /** The launch push was issued: from here on a daemon may have run on the VM. */
    launchIssuedAt: instant,
    /** The agent acknowledged the launch. */
    launchAcceptedAt: instant,
    /** Nothing can start on the VM again. With no launch issued, nothing ever ran on it. */
    fencedAt: instant,
    /** The claim on the first DELETE: one call sends it, and no other does while the claim is live. */
    deletionClaimedAt: instant,
    deletionOperationId: z
      .string()
      .regex(/^bdop_[a-f0-9]{32}$/)
      .nullable(),
    deletionCompletedAt: instant,
    absentAt: instant,
    absentBasis: boatRunAbsentBasisSchema.nullable(),
    heldReason: boatRunHeldReasonSchema.nullable(),
    conflictingSandboxes: z.array(sandbox).max(200),
  })
  .superRefine((run, context) => {
    const { target } = run;
    const admitted = [
      run.admissionOperationId,
      run.admissionEpoch,
      run.admissionDigest,
      run.docker,
    ];
    const valid =
      (run.sandboxId !== null ||
        (target === null &&
          run.createdSeenAt === null &&
          run.deletionClaimedAt === null &&
          run.deletionOperationId === null)) &&
      (run.createIssuedAt !== null || run.sandboxId === null) &&
      (target === null ||
        (target.deploymentId === run.deploymentId &&
          target.workspaceId === run.workspaceId &&
          target.runId === run.runId &&
          target.runtimeInstanceId === run.runId &&
          target.launchAttemptId === run.launchAttemptId &&
          target.sourceId === run.publicationId &&
          target.sandboxId === run.sandboxId &&
          target.diskLineage === run.diskLineage &&
          target.manifestDigest === run.manifestDigest)) &&
      (run.exchangeId === null || target !== null) &&
      (run.sealedExchange === null ||
        (run.exchangeId !== null && run.exchangePublicKey !== null)) &&
      (run.sealedControl === null || (run.exchangeId !== null && run.sealedExchange === null)) &&
      (admitted.every((value) => value === null) || admitted.every((value) => value !== null)) &&
      (run.admissionOperationId === null || run.exchangeId !== null) &&
      (run.sealedLaunch === null || run.admissionOperationId !== null) &&
      (run.isolation === null || run.admissionOperationId !== null) &&
      (run.launchIssuedAt === null || run.admissionOperationId !== null) &&
      (run.launchAcceptedAt === null || run.launchIssuedAt !== null) &&
      (run.deletionCompletedAt === null ||
        (run.deletionOperationId !== null && run.absentAt !== null)) &&
      (run.absentAt === null
        ? run.absentBasis === null
        : run.absentBasis === "never-created"
          ? run.sandboxId === null
          : run.sandboxId !== null &&
            (run.absentBasis === "deletion-completed" ||
              (run.absentBasis === "not-found" && run.createdSeenAt !== null))) &&
      (run.heldReason === null ||
        (run.absentAt === null &&
          target === null &&
          (run.heldReason === "lifetime-unverified"
            ? run.sandboxId !== null
            : run.sandboxId === null) &&
          (run.heldReason === "run-stopped"
            ? run.createIssuedAt === null
            : run.createIssuedAt !== null))) &&
      (run.heldReason === "allocation-conflict"
        ? run.conflictingSandboxes.length >= 2
        : run.conflictingSandboxes.length === 0) &&
      new Set(run.conflictingSandboxes).size === run.conflictingSandboxes.length;
    if (!valid) context.addIssue({ code: "custom", message: "Invalid Boat run" });
  });
/** Parsed durable ownership of one run's VM; a stored row is parsed before any external effect. */
export type BoatRun = z.infer<typeof boatRunSchema>;

/**
 * How far the run's VM is, read from the row: `reserved` (create not issued), `issued` (create
 * issued, no VM known yet), `allocated` (a VM, not bound), `bound` (its boot is the run's target),
 * `held` (for an operator), `deleting` (the first DELETE is claimed, or Boat's deletion operation
 * is on record) and `deleted` (Boat holds no VM for the run, by a committed absence).
 */
export type BoatRunVmPhase =
  | "reserved"
  | "issued"
  | "allocated"
  | "bound"
  | "held"
  | "deleting"
  | "deleted";
export const boatRunVmPhase = (run: BoatRun): BoatRunVmPhase =>
  run.absentAt !== null
    ? "deleted"
    : run.deletionClaimedAt !== null || run.deletionOperationId !== null
      ? "deleting"
      : run.heldReason !== null
        ? "held"
        : run.sandboxId === null
          ? run.createIssuedAt === null
            ? "reserved"
            : "issued"
          : run.target === null
            ? "allocated"
            : "bound";

/**
 * How far the run's launch is, read from the row: `none` (no bind exchange yet), `exchange` (the
 * bind is in flight), `control` (the bearer is sealed), `installed` (the launch is sealed),
 * `issued` (its push was issued), `running` (the agent acknowledged it), `held` (fenced after its
 * push was issued: a daemon may have run) and `aborted` (fenced before any push: nothing ran).
 */
export type BoatRunLaunchPhase =
  | "none"
  | "exchange"
  | "control"
  | "installed"
  | "issued"
  | "running"
  | "held"
  | "aborted";
export const boatRunLaunchPhase = (run: BoatRun): BoatRunLaunchPhase =>
  run.fencedAt !== null
    ? run.launchIssuedAt !== null
      ? "held"
      : "aborted"
    : run.launchAcceptedAt !== null
      ? "running"
      : run.launchIssuedAt !== null
        ? "issued"
        : run.admissionOperationId !== null
          ? "installed"
          : run.sealedControl !== null
            ? "control"
            : run.exchangeId !== null
              ? "exchange"
              : "none";

/** Whether a launch push was issued to the VM's agent: a daemon may have run on it. */
export const boatRunLaunched = (run: BoatRun): boolean => run.launchIssuedAt !== null;
