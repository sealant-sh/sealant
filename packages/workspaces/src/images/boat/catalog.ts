import { isDeepStrictEqual } from "node:util";

import {
  NativePublicationRepo,
  NativePublicationRepoLive,
  type NativeCatalogStoreError,
  type SealantDB,
} from "@sealant/db";
import {
  nativeImageScopeSchema,
  nativePublicationKeySchema,
  type NativeArtifactConsumer,
  type NativeBuildOwnership,
  type NativeCatalogRecord,
  type NativeConsumerState,
  type NativePublication,
  type NativePublicationKey,
  type WorkspaceBlueprint,
} from "@sealant/validators";
import { Context, Effect, Layer, Result } from "effect";

import type { IBoatSnapshotBuilder } from "./builder.js";
import type { NativeResult } from "./runtime-bundle.js";

/** A pending or failed acquisition keeps its exact durable reservation and consumer pin. */
export class NativeCatalogError extends Error {
  readonly _tag = "NativeCatalogError";
  constructor(
    readonly code:
      | "publication-pending"
      | "publication-quarantined"
      | "mechanism-failed"
      | "invalid-input",
    readonly publicationId?: string,
    readonly detail?: string,
  ) {
    super(`Native catalog: ${code}${detail === undefined ? "" : ` (${detail})`}`);
  }
}

/** Store failures remain distinct from provider/journal observations. */
export type NativeCatalogFailure = NativeCatalogError | NativeCatalogStoreError;
/** The later public caller must authorize this scope before calling the internal catalog. */
export interface NativeAcquireInput {
  readonly scope: NativePublicationKey["scope"];
  readonly consumer: NativeArtifactConsumer;
  readonly spec: WorkspaceBlueprint;
}
/** A bounded sweep reports every unresolved item so callers can schedule another observation. */
export interface NativeCatalogSweep {
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly outcome: "updated" | "skipped" | "obligation";
    readonly code: string;
  }>;
  readonly next?: string;
}
/** Environment publications only. Private recovery snapshots have no publication path here. */
export interface BoatNativeCatalogService {
  readonly acquire: (
    input: NativeAcquireInput,
  ) => Effect.Effect<NativePublication, NativeCatalogFailure>;
  readonly markConsumer: (
    consumer: NativeArtifactConsumer,
    publicationId: string,
    state: Exclude<NativeConsumerState, "released">,
  ) => Effect.Effect<void, NativeCatalogStoreError>;
  readonly release: (
    consumer: NativeArtifactConsumer,
    publicationId: string,
  ) => Effect.Effect<void, NativeCatalogStoreError>;
  readonly reap: (input: {
    readonly scope: NativePublicationKey["scope"];
    readonly limit: number;
    readonly after?: string;
  }) => Effect.Effect<NativeCatalogSweep, NativeCatalogFailure>;
  readonly reconcile: (input: {
    readonly limit: number;
    readonly after?: string;
  }) => Effect.Effect<NativeCatalogSweep, NativeCatalogFailure>;
}

/** Owns publication policy; the builder owns native mechanism and the repository owns transactions. */
export class BoatNativeCatalog extends Context.Service<
  BoatNativeCatalog,
  BoatNativeCatalogService
>()("@sealant/workspaces/images/boat/BoatNativeCatalog") {}

/** The composition root supplies a private builder and deployment identity, without ambient config. */
export interface BoatNativeCatalogOptions {
  readonly deploymentId: string;
  readonly builder: IBoatSnapshotBuilder;
}

const claimMs = 30 * 60 * 1000;
const mechanism = <A>(
  action: () => Promise<NativeResult<A>>,
  id?: string,
): Effect.Effect<A, NativeCatalogError> =>
  Effect.tryPromise({
    try: action,
    catch: () => new NativeCatalogError("mechanism-failed", id, "native-local-io-failed"),
  }).pipe(
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result.value)
        : Effect.fail(new NativeCatalogError("mechanism-failed", id, result.error.code)),
    ),
  );
const publication = (
  ownership: NativeBuildOwnership,
  built: {
    readonly artifact: NativePublication["snapshot"];
    readonly evidence: NativePublication["evidence"];
  },
): NativePublication => ({
  kind: "boat-native",
  publicationId: ownership.publicationId,
  snapshot: built.artifact,
  evidence: built.evidence,
});
const failureCode = (error: NativeCatalogFailure) =>
  error instanceof NativeCatalogError ? (error.detail ?? error.code) : error.code;

const make = (
  options: BoatNativeCatalogOptions,
): Effect.Effect<BoatNativeCatalog["Service"], never, NativePublicationRepo> =>
  Effect.gen(function* () {
    const repo = yield* NativePublicationRepo;
    const builder = options.builder;
    const acquire = Effect.fn("BoatNativeCatalog.acquire")(function* (input: NativeAcquireInput) {
      const plan = yield* mechanism(() => builder.plan(input.spec));
      const key = yield* Effect.try({
        try: () =>
          nativePublicationKeySchema.parse({
            ...plan,
            deploymentId: options.deploymentId,
            scope: input.scope,
          }),
        catch: () => new NativeCatalogError("invalid-input"),
      });
      const record = yield* repo.reserve(key, input.consumer);
      const id = record.ownership.publicationId;
      if (record.state === "ready") {
        const checked = yield* Effect.result(
          mechanism(
            () =>
              builder.findPublished({
                spec: input.spec,
                previous: record.publication.snapshot,
                evidence: record.publication.evidence,
              }),
            id,
          ),
        );
        if (Result.isFailure(checked) || checked.success === null) {
          const reason = Result.isFailure(checked)
            ? failureCode(checked.failure)
            : "native-publication-missing";
          yield* repo.rejectReady(record.publication, reason);
          return yield* Effect.fail(new NativeCatalogError("publication-quarantined", id, reason));
        }
        return record.publication;
      }
      if (record.state === "quarantined")
        return yield* Effect.fail(
          new NativeCatalogError("publication-quarantined", id, record.reason ?? undefined),
        );
      if (record.state !== "reserved" && record.state !== "building")
        return yield* Effect.fail(new NativeCatalogError("publication-pending", id));
      const fresh = record.state === "reserved";
      const claim = yield* repo.claim(id, fresh ? "build" : "reconcile", claimMs);
      if (claim === undefined)
        return yield* Effect.fail(new NativeCatalogError("publication-pending", id));
      const work: Effect.Effect<
        {
          readonly artifact: NativePublication["snapshot"];
          readonly evidence: NativePublication["evidence"];
        },
        NativeCatalogError
      > = fresh
        ? mechanism(() => builder.build({ spec: input.spec, ownership: record.ownership }), id)
        : mechanism(() => builder.reconcileBuild(record.ownership), id).pipe(
            Effect.flatMap((recovered) =>
              recovered.kind === "published"
                ? Effect.succeed(recovered)
                : Effect.fail(
                    new NativeCatalogError(
                      "mechanism-failed",
                      id,
                      recovered.kind === "missing"
                        ? "native-journal-missing"
                        : "native-build-abandoned",
                    ),
                  ),
            ),
          );
      const built = yield* Effect.result(work);
      if (Result.isFailure(built)) {
        if (built.failure.detail === "native-attempt-busy") {
          yield* repo.releaseClaim(claim);
          return yield* Effect.fail(new NativeCatalogError("publication-pending", id));
        }
        yield* repo.quarantine(claim, failureCode(built.failure));
        return yield* Effect.fail(built.failure);
      }
      const exact = publication(record.ownership, built.success);
      yield* repo.publish(claim, exact);
      return exact;
    });

    const remove = Effect.fn("BoatNativeCatalog.remove")(function* (record: NativeCatalogRecord) {
      const id = record.ownership.publicationId;
      const retiring = yield* repo.retire(id);
      if (retiring?.state !== "retiring") return "retained";
      const claim = yield* repo.claim(id, "remove", claimMs);
      if (claim === undefined) return "active-claim";
      const removed = yield* Effect.result(
        mechanism(() => builder.remove(retiring.publication.snapshot), id),
      );
      if (Result.isFailure(removed)) {
        if (removed.failure.detail === "native-attempt-busy") {
          yield* repo.releaseClaim(claim);
          return "active-attempt";
        }
        yield* repo.quarantine(claim, "native-removal-pending");
        return yield* Effect.fail(removed.failure);
      }
      yield* repo.removed(claim);
      return "removed";
    });
    const reap = Effect.fn("BoatNativeCatalog.reap")(function* (
      input: Parameters<BoatNativeCatalogService["reap"]>[0],
    ) {
      const scope = yield* Effect.try({
        try: () => nativeImageScopeSchema.parse(input.scope),
        catch: () => new NativeCatalogError("invalid-input"),
      });
      const records = yield* repo.candidates(
        { deploymentId: options.deploymentId, scope },
        input.limit,
        input.after,
      );
      const entries: Array<NativeCatalogSweep["entries"][number]> = [];
      for (const record of records) {
        const result = yield* Effect.result(remove(record));
        entries.push(
          Result.isFailure(result)
            ? {
                id: record.ownership.publicationId,
                outcome: "obligation",
                code: failureCode(result.failure),
              }
            : {
                id: record.ownership.publicationId,
                outcome: result.success === "removed" ? "updated" : "skipped",
                code: result.success,
              },
        );
      }
      const next =
        records.length === input.limit ? records.at(-1)?.ownership.publicationId : undefined;
      return { entries, ...(next === undefined ? {} : { next }) };
    });

    const reconcileRecord = Effect.fn("BoatNativeCatalog.reconcileRecord")(function* (
      ownership: NativeBuildOwnership,
    ) {
      const id = ownership.publicationId;
      const record = yield* repo.get(id);
      if (
        ownership.key.deploymentId !== options.deploymentId ||
        record === undefined ||
        !isDeepStrictEqual(record.ownership, ownership)
      )
        return yield* Effect.fail(
          new NativeCatalogError("mechanism-failed", id, "native-journal-ownership-unresolved"),
        );
      if (record.state === "removed") return "removed";
      if (
        record.state === "retiring" ||
        (record.state === "quarantined" && record.reason === "native-removal-pending")
      )
        return yield* remove(record);
      if (record.state === "ready") {
        const recovered = yield* Effect.result(
          mechanism(
            () =>
              builder.reconcileBuild(ownership, {
                artifact: record.publication.snapshot,
                evidence: record.publication.evidence,
              }),
            id,
          ),
        );
        if (Result.isFailure(recovered) && recovered.failure.detail === "native-attempt-busy")
          return "active-attempt";
        if (
          Result.isFailure(recovered) ||
          recovered.success.kind !== "published" ||
          !isDeepStrictEqual(publication(ownership, recovered.success), record.publication)
        ) {
          const reason = Result.isFailure(recovered)
            ? failureCode(recovered.failure)
            : "native-publication-evidence-mismatch";
          yield* repo.rejectReady(record.publication, reason);
          return yield* Effect.fail(new NativeCatalogError("publication-quarantined", id, reason));
        }
        return "verified";
      }
      const claim = yield* repo.claim(id, "reconcile", claimMs);
      if (claim === undefined) return "active-claim";
      const recovered = yield* Effect.result(
        mechanism(
          () =>
            builder.reconcileBuild(
              ownership,
              record.publication === null
                ? undefined
                : { artifact: record.publication.snapshot, evidence: record.publication.evidence },
            ),
          id,
        ),
      );
      if (Result.isFailure(recovered)) {
        if (recovered.failure.detail === "native-attempt-busy") {
          yield* repo.releaseClaim(claim);
          return "active-attempt";
        }
        yield* repo.quarantine(claim, failureCode(recovered.failure));
        return yield* Effect.fail(recovered.failure);
      }
      if (recovered.success.kind !== "published") {
        const reason =
          recovered.success.kind === "missing"
            ? "native-journal-missing"
            : "native-build-abandoned";
        yield* repo.quarantine(claim, reason);
        return yield* Effect.fail(new NativeCatalogError("publication-quarantined", id, reason));
      }
      const exact = publication(ownership, recovered.success);
      if (record.publication !== null && !isDeepStrictEqual(record.publication, exact)) {
        yield* repo.quarantine(claim, "native-publication-evidence-mismatch");
        return yield* Effect.fail(
          new NativeCatalogError(
            "publication-quarantined",
            id,
            "native-publication-evidence-mismatch",
          ),
        );
      }
      yield* repo.publish(claim, exact);
      return "adopted";
    });
    const reconcile = Effect.fn("BoatNativeCatalog.reconcile")(function* (
      input: Parameters<BoatNativeCatalogService["reconcile"]>[0],
    ) {
      const page = yield* mechanism(() => builder.journals(input));
      const entries: Array<NativeCatalogSweep["entries"][number]> = page.failures.map(
        ({ name, error }) => ({ id: name, outcome: "obligation", code: error.code }),
      );
      for (const entry of page.entries) {
        if (entry.ownership === undefined) {
          entries.push({
            id: entry.buildId,
            outcome: "obligation",
            code: "native-journal-ownership-unresolved",
          });
          continue;
        }
        const result = yield* Effect.result(reconcileRecord(entry.ownership));
        entries.push(
          Result.isFailure(result)
            ? { id: entry.buildId, outcome: "obligation", code: failureCode(result.failure) }
            : {
                id: entry.buildId,
                outcome:
                  result.success === "adopted" || result.success === "removed"
                    ? "updated"
                    : "skipped",
                code: result.success,
              },
        );
      }
      return { entries, ...(page.next === undefined ? {} : { next: page.next }) };
    });
    return BoatNativeCatalog.of({
      acquire,
      markConsumer: repo.markConsumer,
      release: repo.release,
      reap,
      reconcile,
    });
  });

export const boatNativeCatalogLayerNoDeps = (
  options: BoatNativeCatalogOptions,
): Layer.Layer<BoatNativeCatalog, never, NativePublicationRepo> =>
  Layer.effect(BoatNativeCatalog, make(options));
/** Own the repository implementation and leave SQL infrastructure to the composition root. */
export const boatNativeCatalogLayer = (
  options: BoatNativeCatalogOptions,
): Layer.Layer<BoatNativeCatalog, never, SealantDB> =>
  boatNativeCatalogLayerNoDeps(options).pipe(Layer.provide(NativePublicationRepoLive));
