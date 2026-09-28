/**
 * The worker's capture drain ledger: ownership and progress of every drain in
 * `workspace_capture_drains`, so the exclusion and the stall/silence clocks hold across every
 * worker process and survive a worker restart (`capture-drain.ts`). Each claim holds the lease
 * under its own token (`<owner>#<uuid>`), so two drains of one run never overlap even inside one
 * worker process, and neither can release the other's lease.
 */
import { randomUUID } from "node:crypto";

import {
  executorOriginFromStored,
  SealantDB,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  type DB,
  type WorkspaceCaptureDrain,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { z } from "zod";

import type { CaptureFlushReport } from "../sealantd/runtime.js";
import {
  claimLeaseOwner,
  type CaptureDrainEntry,
  type CaptureDrainLedger,
  type CaptureDrainObservation,
} from "./capture-drain.js";

const storedStatusSchema = z.object({
  epoch: z.number(),
  worktreeId: z.string(),
  headN: z.number().optional(),
  pending: z.number(),
  stagedBytes: z.number(),
  uploadedObjects: z.number(),
  uploadedBytes: z.number(),
  registered: z.number(),
  fenced: z.boolean(),
  paused: z.boolean(),
  lastSnapUnixMs: z.number().optional(),
  refused: z.array(z.enum(["small", "bulk"])).default([]),
  complete: z.boolean().optional(),
  incompleteReason: z.string().optional(),
  pendingBytes: z.number().optional(),
  pendingBulk: z.number().optional(),
  unreadable: z.number().optional(),
  carried: z.number().optional(),
  unreadablePaths: z.array(z.string()).optional(),
  registerRefused: z.string().optional(),
  registerRefusedN: z.number().optional(),
  registerMissing: z.array(z.string()).optional(),
  registerRefusals: z.number().optional(),
  repairing: z.boolean().optional(),
  bulkBuilding: z.boolean().optional(),
  snaps: z
    .array(
      z.object({
        class: z.enum(["small", "bulk"]),
        snapsFailed: z.number(),
        lastSnapError: z.string().optional(),
        snapFailingSinceUnixMs: z.number().optional(),
      }),
    )
    .optional(),
  lastSnapError: z.string().optional(),
  snapFailingSinceUnixMs: z.number().optional(),
  snapsFailed: z.number().optional(),
  origin: z
    .object({
      epoch: z.number(),
      launch: z.string().min(1),
      bootId: z.string().min(1),
      bootGeneration: z.number(),
      observation: z.number(),
      headN: z.number().optional(),
    })
    .optional(),
});

/** A stored status back into a report; a row of an unknown shape reads as none. */
export const captureStatusFromStored = (stored: unknown): CaptureFlushReport | undefined => {
  const parsed = storedStatusSchema.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
};

const entryFromRow = (row: WorkspaceCaptureDrain): CaptureDrainEntry => ({
  lastProgressAt: row.lastProgressAt?.getTime(),
  last: captureStatusFromStored(row.lastStatus),
  lastAtMs: row.lastStatusAt?.getTime(),
  lastUnreadable: row.lastStatus !== null && captureStatusFromStored(row.lastStatus) === undefined,
  evidenceVersion: row.evidenceVersion,
  observationsInFlight: Object.keys(row.observationFences).length,
  unreachableSince: row.unreachableSince?.getTime(),
  keptLogged: row.keptLogged,
  silentLogged: row.silentLogged,
  ...(row.discardRequestedAt === null
    ? {}
    : {
        discardRequested: {
          atMs: row.discardRequestedAt.getTime(),
          by: row.discardRequestedBy ?? "unknown",
        },
      }),
  ...(row.completionExecutorId === null ||
  row.completionEpoch === null ||
  row.completionCaptureN === null ||
  row.completionAttestedAt === null
    ? {}
    : {
        completionAttested: {
          executorId: row.completionExecutorId,
          epoch: row.completionEpoch,
          captureN: row.completionCaptureN,
          sealedAtMs: row.completionSealedAt?.getTime(),
          ...(executorOriginFromStored(row.completionOrigin) === undefined
            ? {}
            : { origin: executorOriginFromStored(row.completionOrigin) }),
          atMs: row.completionAttestedAt.getTime(),
          by: row.completionAttestedBy ?? "unknown",
        },
      }),
  ...(row.retainedAt === null
    ? {}
    : {
        retained: {
          atMs: row.retainedAt.getTime(),
          reason: row.retainedReason ?? "not recorded",
          recoveryAttempts: row.recoveryAttempts,
          nextRecoveryAtMs: row.nextRecoveryAt?.getTime(),
          lastRecoveryError: row.lastRecoveryError ?? undefined,
        },
      }),
});

/** A status as the drain record stores it (`workspace_capture_drains.last_status`). */
export const storedCaptureStatus = (
  status: CaptureFlushReport,
): Readonly<Record<string, unknown>> => ({
  ...status,
  refused: [...status.refused],
});

export interface DatabaseCaptureDrainLedgerOptions {
  readonly db: DB;
  /** This worker's identity on the lease (`WORKER_ID` plus a per-process suffix). */
  readonly owner: string;
  /** How long a claim lasts without renewal. */
  readonly leaseMs: number;
}

/** The ledger over `workspace_capture_drains`; every failure is logged and fails safe. */
export const databaseCaptureDrainLedger = (
  options: DatabaseCaptureDrainLedgerOptions,
): CaptureDrainLedger => {
  const layer = WorkspaceCaptureDrainRepoLive.pipe(
    Layer.provide(Layer.succeed(SealantDB, options.db)),
  );
  return captureDrainLedgerFromRepo({ owner: options.owner, leaseMs: options.leaseMs }, (effect) =>
    effect.pipe(Effect.provide(layer)),
  );
};

/**
 * The ledger over any `WorkspaceCaptureDrainRepo` (the database one, or a test double): `run`
 * provides the repo to each call.
 */
export const captureDrainLedgerFromRepo = (
  options: { readonly owner: string; readonly leaseMs: number },
  run: <A>(
    effect: Effect.Effect<A, unknown, WorkspaceCaptureDrainRepo>,
  ) => Effect.Effect<A, unknown>,
): CaptureDrainLedger => ({
  claim: (runId) =>
    run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCaptureDrainRepo;
        const token = randomUUID();
        const row = yield* repo.claimLease({
          runId,
          owner: claimLeaseOwner(options.owner, token),
          leaseMs: options.leaseMs,
        });
        return row === undefined ? undefined : { entry: entryFromRow(row), token };
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Capture drain: claiming run ${runId} failed; treated as held elsewhere (nothing is stopped).`,
          cause,
        ).pipe(Effect.as(undefined)),
      ),
    ),

  save: (runId, token, entry, observation: CaptureDrainObservation | undefined) =>
    run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCaptureDrainRepo;
        const row = yield* repo.recordProgress({
          runId,
          owner: claimLeaseOwner(options.owner, token),
          leaseMs: options.leaseMs,
          progress: {
            lastProgressAt:
              entry.lastProgressAt === undefined ? null : new Date(entry.lastProgressAt),
            unreachableSince:
              entry.unreachableSince === undefined ? null : new Date(entry.unreachableSince),
            keptLogged: entry.keptLogged,
            silentLogged: entry.silentLogged,
            ...(observation === undefined
              ? {}
              : {
                  state: observation.state,
                  detail: observation.detail ?? null,
                  observedAt: new Date(),
                }),
          },
        });
        return row !== undefined;
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Capture drain: recording progress of run ${runId} failed; giving the drain up for this sweep.`,
          cause,
        ).pipe(Effect.as(false)),
      ),
    ),

  read: (runId) =>
    run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCaptureDrainRepo;
        const row = yield* repo.getByRunId(runId);
        return {
          readable: true as const,
          entry: row === undefined ? undefined : entryFromRow(row),
        };
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Capture drain: reading run ${runId}'s drain failed; nothing in it is known (no completion, attestation or discard counts).`,
          cause,
        ).pipe(Effect.as({ readable: false as const })),
      ),
    ),

  openObservation: (runId, ttlMs) =>
    run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCaptureDrainRepo;
        const token = randomUUID();
        yield* repo.openObservation({ runId, token, ttlMs });
        return { token };
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Capture drain: marking an observation of run ${runId}'s executor in flight failed; nothing is asked of its daemon.`,
          cause,
        ).pipe(Effect.as(undefined)),
      ),
    ),

  closeObservation: (runId, fence) =>
    run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCaptureDrainRepo;
        yield* repo.closeObservation({ runId, token: fence.token });
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Capture drain: resolving an observation of run ${runId}'s executor that received nothing failed; it stays in flight until a later observation resolves it.`,
          cause,
        ),
      ),
    ),

  recordStatus: (runId, status, atMs, fence) =>
    run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCaptureDrainRepo;
        yield* repo.recordStatus({
          runId,
          status: storedCaptureStatus(status),
          observedAt: new Date(atMs),
          ...(fence === undefined ? {} : { fence: fence.token }),
        });
        return true;
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(
          `Capture drain: recording a status read from run ${runId}'s executor failed; its observation stays unresolved, so nothing Core holds of the executor counts as current until a later one is recorded.`,
          cause,
        ).pipe(Effect.as(false)),
      ),
    ),

  authorizeDeletion: (runId, evidenceVersion) =>
    run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCaptureDrainRepo;
        return yield* repo.authorizeDeletion({ runId, evidenceVersion });
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Capture drain: authorizing the removal of run ${runId}'s executor failed; it is not removed.`,
          cause,
        ).pipe(Effect.as(false)),
      ),
    ),

  markRetained: (runId, reason) =>
    run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCaptureDrainRepo;
        yield* repo.markRetained({ runId, reason });
        return true;
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(
          `Capture drain: recording run ${runId}'s executor as retained failed (not recorded); the executor is kept, and nothing that depends on the record is written.`,
          cause,
        ).pipe(Effect.as(false)),
      ),
    ),

  observe: (runId, observation) =>
    run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCaptureDrainRepo;
        yield* repo.recordObservation({
          runId,
          state: observation.state,
          detail: observation.detail ?? null,
        });
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Capture drain: recording "${observation.state}" for run ${runId} failed.`,
          cause,
        ),
      ),
    ),

  release: (runId, token) =>
    run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCaptureDrainRepo;
        yield* repo.releaseLease({ runId, owner: claimLeaseOwner(options.owner, token) });
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Capture drain: releasing run ${runId} failed; its lease expires on its own.`,
          cause,
        ),
      ),
    ),
});
