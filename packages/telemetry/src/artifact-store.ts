/**
 * ArtifactStore — the content-addressed blob store for ioChunk content bytes (and daemon ArtifactRef
 * bodies). A separate Tag from {@link TelemetrySink} so blobs can move to S3/filesystem independently
 * of the log engine. The MVP default stores bytes inline in `telemetry_artifacts.inline_bytes`.
 */
import { SealantDB, telemetryArtifacts, type TSealantDB } from "@sealant/db";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import {
  ArtifactStoreInvariantError,
  type ArtifactStoreError,
  withArtifactStoreError,
} from "./errors.js";

export interface ArtifactPutInput {
  readonly runId: string;
  readonly algo: string;
  readonly hash: string;
  readonly bytes: Uint8Array;
  readonly byteSize: bigint;
}

export interface ArtifactGetInput {
  readonly runId: string;
  readonly algo: string;
  readonly hash: string;
}

export interface ArtifactStoreService {
  /** Idempotently store a content body (content-addressed by `(runId, algo, hash)`). */
  readonly put: (input: ArtifactPutInput) => Effect.Effect<void, ArtifactStoreError>;
  /** Resolve a content body by its natural key. */
  readonly get: (input: ArtifactGetInput) => Effect.Effect<Uint8Array, ArtifactStoreError>;
}

export class ArtifactStore extends Context.Service<ArtifactStore, ArtifactStoreService>()(
  "@sealant/telemetry/ArtifactStore",
) {}

export const makeInlineByteaArtifactStore = (db: TSealantDB): ArtifactStoreService => ({
  put: (input) =>
    withArtifactStoreError(
      "put",
      db
        .insert(telemetryArtifacts)
        .values({
          id: `tart_${input.runId}_${input.algo}_${input.hash.slice(0, 24)}`,
          runId: input.runId,
          algo: input.algo,
          hash: input.hash,
          byteSize: input.byteSize,
          storageBackend: "inline",
          inlineBytes: Buffer.from(input.bytes),
        })
        .onConflictDoNothing(),
    ).pipe(Effect.asVoid),

  get: (input) =>
    withArtifactStoreError(
      "get",
      Effect.gen(function* () {
        const [row] = yield* db
          .select()
          .from(telemetryArtifacts)
          .where(
            and(
              eq(telemetryArtifacts.runId, input.runId),
              eq(telemetryArtifacts.algo, input.algo),
              eq(telemetryArtifacts.hash, input.hash),
            ),
          )
          .limit(1);

        if (row === undefined || row.inlineBytes === null) {
          return yield* new ArtifactStoreInvariantError({
            operation: "get",
            message: `Artifact ${input.algo}:${input.hash} not found for run ${input.runId}.`,
          });
        }

        return new Uint8Array(row.inlineBytes);
      }),
    ),
});

export const InlineByteaArtifactStoreLive = Layer.effect(
  ArtifactStore,
  Effect.gen(function* () {
    const db = yield* SealantDB;
    return makeInlineByteaArtifactStore(db);
  }),
);

/** TEST-ONLY: discards bytes on put and returns empty on get. NEVER used by the worker. */
export const NoopArtifactStoreLive = Layer.succeed(ArtifactStore, {
  put: () => Effect.void,
  get: () => Effect.succeed(new Uint8Array()),
} satisfies ArtifactStoreService);
