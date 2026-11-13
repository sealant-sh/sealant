import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  NativePublicationRepo,
  NativePublicationRepoLive,
  type NativeCatalogStoreError,
  type NativeRetentionPolicy,
  type SealantDB,
} from "@sealant/db";
import {
  boatLaunchSupport,
  newWorkspaceSchema,
  nativeImageScopeSchema,
  nativeBuildRetryReasonSchema,
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
import {
  nativeCommandFailureSchema,
  nativeProviderFailureSchema,
  type NativeCommandFailure,
  type NativeProviderFailure,
} from "./command-diagnostics.js";
import type { NativeResult } from "./runtime-bundle.js";

/** A pending or failed acquisition keeps its exact durable reservation and consumer pin. */
export class NativeCatalogError extends Error {
  readonly _tag = "NativeCatalogError";
  readonly commandFailure: NativeCommandFailure | undefined;
  readonly providerFailure: NativeProviderFailure | undefined;
  constructor(
    readonly code:
      | "publication-pending"
      | "publication-quarantined"
      | "publication-build-attempts-exhausted"
      | "publication-build-replaced"
      | "mechanism-failed"
      | "invalid-input",
    readonly publicationId?: string,
    readonly detail?: string,
    commandFailure?: NativeCommandFailure,
    providerFailure?: NativeProviderFailure,
  ) {
    const provider =
      providerFailure === undefined
        ? undefined
        : nativeProviderFailureSchema.parse(providerFailure);
    const diagnostic =
      commandFailure === undefined ? undefined : nativeCommandFailureSchema.parse(commandFailure);
    super(
      `Native catalog: ${code}${code === "publication-build-attempts-exhausted" ? "; this environment build failed twice. Fix the recorded cause before trying a changed environment" : ""}${detail === undefined ? "" : ` (${detail})`}${diagnostic === undefined ? "" : `; command ${JSON.stringify(diagnostic)}`}${provider === undefined ? "" : `; provider ${JSON.stringify(provider)}`}`,
    );
    this.commandFailure = diagnostic;
    this.providerFailure = provider;
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
  /** Operator withdrawal is exact, refuses every live pin, and uses the original build journal. */
  readonly withdraw: (ownership: NativeBuildOwnership) => Effect.Effect<void, NativeCatalogFailure>;
  /**
   * One page of this account's retention: each saved image no workspace can use any more is
   * removed (`NativeRetentionPolicy`). The keys still wanted are what this sealant plans, now, for
   * the latest launch of every Boat workspace that can still start in the account (`startsOnBoat`):
   * not archived, and live, or stopped or failed at or after `stoppedSince`. An image is also kept while a run holds it,
   * while a build of its scope is queued or running, and until nothing has used it since
   * `unusedSince`. If any of those specs cannot be planned, nothing is removed.
   */
  readonly reap: (input: {
    readonly stoppedSince: Date;
    readonly unusedSince: Date;
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
  /**
   * The Boat wallet the builder's client names on every request (`X-Boat-Org`; null: none, the
   * key's only wallet). The catalog builds, verifies and removes only images recorded in it: Boat
   * not finding an image is evidence it is gone only when the request named the wallet the image
   * was made in. Absent: an install with no wallets to tell apart (tests); nothing is skipped.
   */
  readonly wallet?: string | null;
}

const claimMs = 30 * 60 * 1000;
/** Workspaces read per page, and pages at most, when retention reads what is still wanted. */
const startablePage = 500;
const startablePages = 40;
/** Plans kept per catalog, by spec: a plan is pure in its spec, the bundle and the assets. */
const plannedSpecs = 2000;
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
        : Effect.fail(
            new NativeCatalogError(
              "mechanism-failed",
              id,
              result.error.code,
              result.error.commandFailure,
              result.error.providerFailure,
            ),
          ),
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
/**
 * Whether a workspace's next launch can be a Boat one, and so look up an image here. Every create
 * has an image scope whatever its runtime: a workspace whose launch resolved to another runtime,
 * one that asks for another runtime and has not launched yet, and one whose spec Boat refuses (a
 * custom base image, host directories, Arch, Fedora) never looks a Boat image up, and is never
 * planned. An `auto` spec Boat can run counts even where the install's default is Docker: its key
 * matches no Boat image unless that spec also launched on Boat.
 */
const startsOnBoat = (spec: NativeAcquireInput["spec"], adapter: string | null) =>
  (adapter === null
    ? spec.target.runtime.family === "boat" || spec.target.runtime.family === "auto"
    : adapter === "boat") && boatLaunchSupport(spec).supported;
const failureCode = (error: NativeCatalogFailure) =>
  error instanceof NativeCatalogError ? (error.detail ?? error.code) : error.code;

const make = (
  options: BoatNativeCatalogOptions,
): Effect.Effect<BoatNativeCatalog["Service"], never, NativePublicationRepo> =>
  Effect.gen(function* () {
    const repo = yield* NativePublicationRepo;
    const builder = options.builder;
    /** Whether the publication is recorded in the wallet this catalog's builder names. */
    const inThisWallet = (id: string) =>
      options.wallet === undefined
        ? Effect.succeed(true)
        : repo
            .wallet(id)
            .pipe(
              Effect.map(
                (recorded) => recorded?.state === "known" && recorded.wallet === options.wallet,
              ),
            );
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
      const legacy = yield* repo.getActive(key);
      if (
        legacy?.state === "quarantined" &&
        legacy.publication === null &&
        legacy.reason === "native-build-abandoned"
      ) {
        // Older sweeps replaced the build cause with "abandoned". Recover the cause
        // from the exact private journal before pinning this new consumer.
        const repaired = yield* Effect.result(reconcileRecord(legacy.ownership));
        if (Result.isFailure(repaired)) {
          if (
            !(repaired.failure instanceof NativeCatalogError) ||
            repaired.failure.code !== "publication-quarantined" ||
            !nativeBuildRetryReasonSchema.safeParse(repaired.failure.detail).success
          )
            return yield* Effect.fail(repaired.failure);
        } else if (repaired.success === "active-claim" || repaired.success === "active-attempt") {
          return yield* Effect.fail(
            new NativeCatalogError("publication-pending", legacy.ownership.publicationId),
          );
        }
      }
      // An image being removed (retention, a withdrawal) is waited for like a build in progress:
      // the build job tries again, and once the removal is recorded the next reserve builds anew.
      const record = yield* repo.reserve(key, input.consumer).pipe(
        Effect.catchIf(
          (error) => error.code === "publication-removing",
          () =>
            Effect.fail(
              new NativeCatalogError(
                "publication-pending",
                undefined,
                "native-publication-removing",
              ),
            ),
        ),
      );
      const id = record.ownership.publicationId;
      // The account's wallet changed between this catalog's opening and the reservation: the
      // build or the image is the new wallet's, and a catalog that names it does it next time.
      if (!(yield* inThisWallet(id)))
        return yield* Effect.fail(new NativeCatalogError("publication-pending", id));
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
      if (record.state === "superseded")
        return yield* Effect.fail(
          new NativeCatalogError("publication-build-replaced", id, record.reason ?? undefined),
        );
      if (
        record.state === "quarantined" &&
        record.publication === null &&
        record.buildAttempt === 2 &&
        nativeBuildRetryReasonSchema.safeParse(record.reason).success
      )
        return yield* Effect.fail(
          new NativeCatalogError(
            "publication-build-attempts-exhausted",
            id,
            record.reason ?? undefined,
          ),
        );
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
                        : (recovered.failureCode ?? "native-build-abandoned"),
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

    const remove = Effect.fn("BoatNativeCatalog.remove")(function* (
      record: NativeCatalogRecord,
      policy?: NativeRetentionPolicy,
    ) {
      const id = record.ownership.publicationId;
      // An image recorded in another wallet is removed by a catalog that names that wallet.
      if (!(yield* inThisWallet(id))) return "retained";
      const retiring = yield* repo.retire(id, policy);
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
    const withdraw = Effect.fn("BoatNativeCatalog.withdraw")(function* (
      ownership: NativeBuildOwnership,
    ) {
      if (ownership.key.deploymentId !== options.deploymentId)
        return yield* Effect.fail(new NativeCatalogError("invalid-input"));
      const record = yield* repo.withdraw(ownership);
      if (record === undefined) return yield* Effect.fail(new NativeCatalogError("invalid-input"));
      if (record.state === "removed") return;
      const result = yield* remove(record);
      if (result !== "removed")
        return yield* Effect.fail(
          new NativeCatalogError("publication-pending", ownership.publicationId),
        );
    });
    type Plan = Pick<NativePublicationKey, "recipeHash" | "runtime" | "assetsHash" | "platform">;
    const plans = new Map<string, Plan>();
    /** The keys a workspace that can still start in this account would look up, planned now. */
    const wantedKeys = Effect.fn("BoatNativeCatalog.wantedKeys")(function* (stoppedSince: Date) {
      const wanted: NativePublicationKey[] = [];
      let after: string | undefined;
      for (let page = 0; page < startablePages; page++) {
        const rows = yield* repo.startable({
          deploymentId: options.deploymentId,
          stoppedSince,
          limit: startablePage,
          ...(after === undefined ? {} : { after }),
        });
        for (const row of rows) {
          // A launch whose spec or scope no longer parses cannot start: its build job refuses it.
          const spec = newWorkspaceSchema.safeParse(row.spec);
          const scope = nativeImageScopeSchema.safeParse(row.scope);
          if (!spec.success || !scope.success || !startsOnBoat(spec.data, row.adapter)) continue;
          const id = createHash("sha256").update(JSON.stringify(row.spec)).digest("hex");
          let plan = plans.get(id);
          if (plan === undefined) {
            const parsed = spec.data;
            plan = yield* mechanism(() => builder.plan(parsed));
            if (plans.size >= plannedSpecs) plans.clear();
            plans.set(id, plan);
          }
          const key = nativePublicationKeySchema.safeParse({
            ...plan,
            deploymentId: options.deploymentId,
            scope: scope.data,
          });
          if (key.success) wanted.push(key.data);
        }
        if (rows.length < startablePage) return wanted;
        after = rows.at(-1)?.workspaceId;
      }
      // More workspaces than one pass reads: nothing is removed rather than something wanted.
      return yield* Effect.fail(
        new NativeCatalogError("mechanism-failed", undefined, "native-retention-unbounded"),
      );
    });
    const reap = Effect.fn("BoatNativeCatalog.reap")(function* (
      input: Parameters<BoatNativeCatalogService["reap"]>[0],
    ) {
      const policy: NativeRetentionPolicy = {
        wanted: yield* wantedKeys(input.stoppedSince),
        unusedSince: input.unusedSince,
      };
      const records = yield* repo.images({
        deploymentId: options.deploymentId,
        limit: input.limit,
        ...(input.after === undefined ? {} : { after: input.after }),
      });
      const entries: Array<NativeCatalogSweep["entries"][number]> = [];
      for (const record of records) {
        const result = yield* Effect.result(remove(record, policy));
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
      if (record.state === "superseded") return "superseded";
      // A ready or retiring image of another wallet is verified and removed by a catalog that
      // names that wallet; asked here, Boat would answer that it has none.
      if (!(yield* inThisWallet(id))) return "other-wallet";
      if (
        record.state === "quarantined" &&
        record.publication === null &&
        nativeBuildRetryReasonSchema.safeParse(record.reason).success
      )
        return "failed-build";
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
            : (recovered.success.failureCode ?? "native-build-abandoned");
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
      withdraw,
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
