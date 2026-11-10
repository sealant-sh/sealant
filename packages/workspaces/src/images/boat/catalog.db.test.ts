import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { it } from "@effect/vitest";
import {
  makeSealantDBLayer,
  NativePublicationRepo,
  NativePublicationRepoLive,
  SealantDB,
  user,
  workspaceAttempts,
  type DB,
  type NativePublicationRepoService,
} from "@sealant/db";
import { runMigrations } from "@sealant/db/migrate";
import {
  expireNativeClaim,
  corruptNativePublication,
  corruptNativeKey,
  nativeConsumerRows,
  ageNativePublication,
} from "@sealant/db/testing/native-publications";
import {
  nativeArtifactConsumerSchema,
  nativeBuildOwnershipSchema,
  type NativePublicationKey,
} from "@sealant/validators";
import { Arbitrary, Effect, Layer, Result, Schema } from "effect";
import { beforeAll, describe, expect } from "vitest";
import { z } from "zod";

import { nativeBuilderFixture } from "./builder.fixture.js";
import {
  BoatNativeCatalog,
  NativeCatalogError,
  boatNativeCatalogLayer,
  type BoatNativeCatalogService,
} from "./catalog.js";

const databaseUrl = process.env.SEALANT_BOAT_CATALOG_TEST_DATABASE_URL;
const enabled = databaseUrl !== undefined && process.env.SEALANT_BOAT_RUNTIME_BUNDLE !== undefined;
const infrastructure = makeSealantDBLayer(
  databaseUrl ?? "postgresql://invalid:invalid@127.0.0.1:1/invalid",
);
const TestLayer = NativePublicationRepoLive.pipe(Layer.provideMerge(infrastructure));
const test = <A, E>(run: (repo: NativePublicationRepoService, db: DB) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const repo = yield* NativePublicationRepo;
    const db = yield* SealantDB;
    return yield* run(repo, db);
  }).pipe(Effect.provide(TestLayer));

const seed = (db: DB) =>
  Effect.gen(function* () {
    const owner = `usr_stage2a_${randomUUID()}`;
    yield* db
      .insert(user)
      .values({ id: owner, email: `${owner}@example.invalid`, name: "stage2a" });
    return owner;
  });
const consumer = (db: DB, owner: string) =>
  Effect.gen(function* () {
    const runId = randomUUID();
    yield* db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner });
    return nativeArtifactConsumerSchema.parse({ runId, runtimeInstanceId: runId });
  });
const prepare = (db: DB) =>
  Effect.gen(function* () {
    const owner = yield* seed(db);
    const fixture = yield* Effect.promise(() => nativeBuilderFixture("normal"));
    const plan = yield* Effect.promise(() => fixture.builder.plan(fixture.spec));
    if (!plan.ok) throw plan.error;
    const key: NativePublicationKey = {
      ...plan.value,
      deploymentId: "local-stage2a",
      scope: { kind: "owner", ownerUserId: owner },
    };
    return { ...fixture, owner, key };
  });
const published = (repo: NativePublicationRepoService, db: DB) =>
  Effect.gen(function* () {
    const fixture = yield* prepare(db);
    const pin = yield* consumer(db, fixture.owner);
    const reservation = yield* repo.reserve(fixture.key, pin);
    const claim = yield* repo.claim(reservation.ownership.publicationId, "build", 60000);
    if (claim === undefined) throw new Error("missing build claim");
    const built = yield* Effect.promise(() =>
      fixture.builder.build({ spec: fixture.spec, ownership: reservation.ownership }),
    );
    if (!built.ok) throw built.error;
    const publication = {
      kind: "boat-native" as const,
      publicationId: reservation.ownership.publicationId,
      snapshot: built.value.artifact,
      evidence: built.value.evidence,
    };
    return { ...fixture, pin, reservation, claim, publication };
  });

const throughCatalog = <A, E>(
  db: DB,
  fixture: Pick<Awaited<ReturnType<typeof nativeBuilderFixture>>, "builder">,
  run: (catalog: BoatNativeCatalogService) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const catalog = yield* BoatNativeCatalog;
    return yield* run(catalog);
  }).pipe(
    Effect.provide(
      boatNativeCatalogLayer({ builder: fixture.builder, deploymentId: "local-stage2a" }).pipe(
        Layer.provide(Layer.succeed(SealantDB, db)),
      ),
    ),
  );

describe.skipIf(!enabled)("native publication ownership in migrated disposable Postgres", () => {
  it.live(
    "replaces one failed build for a new consumer, preserves redelivery and refuses exhausted attempts",
    () =>
      test((repo, db) =>
        Effect.gen(function* () {
          const owner = yield* seed(db);
          const f = yield* Effect.promise(() => nativeBuilderFixture("command-failed"));
          const first = yield* consumer(db, owner);
          const second = yield* consumer(db, owner);
          const third = yield* consumer(db, owner);
          yield* throughCatalog(db, f, (catalog) =>
            Effect.gen(function* () {
              const input = { scope: { kind: "owner" as const, ownerUserId: owner }, spec: f.spec };
              const failed = yield* Effect.flip(catalog.acquire({ ...input, consumer: first }));
              expect(failed).toMatchObject({
                code: "mechanism-failed",
                detail: "native-guest-command-failed",
              });
              const oldPin = (yield* nativeConsumerRows(db, first.runId))[0];
              if (oldPin === undefined) throw new Error("missing original pin");
              const firstFailure = yield* repo.get(oldPin.publicationId);
              expect((yield* catalog.reconcile({ limit: 20 })).entries).toContainEqual({
                id: firstFailure?.ownership.buildId,
                outcome: "skipped",
                code: "failed-build",
              });
              expect((yield* repo.get(oldPin.publicationId))?.reason).toBe(
                "native-guest-command-failed",
              );
              const before = f.mutations.length;
              expect(
                yield* Effect.flip(catalog.acquire({ ...input, consumer: first })),
              ).toMatchObject({ code: "publication-quarantined" });
              expect(f.mutations).toHaveLength(before);
              expect(
                yield* Effect.flip(catalog.acquire({ ...input, consumer: second })),
              ).toMatchObject({ code: "mechanism-failed", detail: "native-guest-command-failed" });
              const replacementPin = (yield* nativeConsumerRows(db, second.runId))[0];
              if (replacementPin === undefined) throw new Error("missing replacement pin");
              expect(replacementPin.publicationId).not.toBe(oldPin.publicationId);
              expect(yield* repo.get(oldPin.publicationId)).toMatchObject({
                state: "superseded",
                buildAttempt: 1,
                reason: "native-guest-command-failed",
              });
              expect(yield* repo.get(replacementPin.publicationId)).toMatchObject({
                state: "quarantined",
                buildAttempt: 2,
                replacesPublicationId: oldPin.publicationId,
              });
              const sweep = yield* catalog.reconcile({ limit: 20 });
              expect(sweep.entries).toContainEqual({
                id: firstFailure?.ownership.buildId,
                outcome: "skipped",
                code: "superseded",
              });
              expect((yield* repo.get(replacementPin.publicationId))?.reason).toBe(
                "native-guest-command-failed",
              );
              const spent = f.mutations.length;
              const refusal = yield* Effect.flip(catalog.acquire({ ...input, consumer: third }));
              expect(refusal).toMatchObject({
                code: "publication-build-attempts-exhausted",
                detail: "native-guest-command-failed",
              });
              expect(refusal.message).toContain("failed twice");
              expect(f.mutations).toHaveLength(spent);
              expect(
                yield* Effect.flip(catalog.acquire({ ...input, consumer: first })),
              ).toMatchObject({
                code: "publication-build-replaced",
                detail: "native-guest-command-failed",
              });
              expect(yield* nativeConsumerRows(db, first.runId)).toEqual([oldPin]);
            }),
          );
        }),
      ),
  );

  it.live(
    "recovers a legacy transport failure once and shares the replacement under concurrent acquires",
    () =>
      test((repo, db) =>
        Effect.gen(function* () {
          const f = yield* prepare(db);
          const original = yield* consumer(db, f.owner);
          const failed = yield* repo.reserve(f.key, original);
          const claim = yield* repo.claim(failed.ownership.publicationId, "build", 60000);
          if (claim === undefined) throw new Error("missing original claim");
          // Run 4 has this reason and no published snapshot. Migration defaults make it attempt one.
          yield* repo.quarantine(claim, "native-provider-transport_error");
          const pins = yield* Effect.all(Array.from({ length: 6 }, () => consumer(db, f.owner)));
          const reservations = yield* Effect.all(
            pins.map((pin) => repo.reserve(f.key, pin)),
            { concurrency: "unbounded" },
          );
          expect(new Set(reservations.map((r) => r.ownership.publicationId)).size).toBe(1);
          const next = reservations[0],
            pin = pins[0];
          if (next === undefined || pin === undefined) throw new Error("missing replacement");
          expect(next).toMatchObject({
            state: "reserved",
            buildAttempt: 2,
            replacesPublicationId: failed.ownership.publicationId,
          });
          expect(next.ownership.buildId).not.toBe(failed.ownership.buildId);
          expect(
            yield* repo.claim(failed.ownership.publicationId, "reconcile", 60000),
          ).toBeUndefined();
          yield* throughCatalog(db, f, (catalog) =>
            Effect.gen(function* () {
              const ready = yield* catalog.acquire({
                scope: f.key.scope,
                spec: f.spec,
                consumer: pin,
              });
              expect(ready.publicationId).toBe(next.ownership.publicationId);
              expect((yield* repo.get(ready.publicationId))?.state).toBe("ready");
              expect(f.mutations.filter((m) => m === "POST /api/v1/sandboxes")).toHaveLength(1);
              // A ready artifact rejected on a transport read is an integrity quarantine,
              // even when its reason is otherwise eligible for construction retry.
              yield* repo.rejectReady(ready, "native-provider-transport_error");
              const calls = f.mutations.length;
              expect(
                yield* Effect.flip(
                  catalog.acquire({
                    scope: f.key.scope,
                    spec: f.spec,
                    consumer: yield* consumer(db, f.owner),
                  }),
                ),
              ).toMatchObject({ code: "publication-quarantined" });
              expect(f.mutations).toHaveLength(calls);
              expect(yield* repo.get(failed.ownership.publicationId)).toMatchObject({
                state: "superseded",
                reason: "native-provider-transport_error",
              });
            }),
          );
        }),
      ),
  );

  it.live("repairs a legacy swept build cause from its exact journal before replacing it", () =>
    test((repo, db) =>
      Effect.gen(function* () {
        const owner = yield* seed(db);
        const f = yield* Effect.promise(() => nativeBuilderFixture("command-failed"));
        const original = yield* consumer(db, owner);
        yield* throughCatalog(db, f, (catalog) =>
          Effect.gen(function* () {
            const input = { scope: { kind: "owner" as const, ownerUserId: owner }, spec: f.spec };
            expect(
              yield* Effect.flip(catalog.acquire({ ...input, consumer: original })),
            ).toMatchObject({ detail: "native-guest-command-failed" });
            const pin = (yield* nativeConsumerRows(db, original.runId))[0];
            if (pin === undefined) throw new Error("missing pin");
            const claim = yield* repo.claim(pin.publicationId, "reconcile", 60000);
            if (claim === undefined) throw new Error("missing claim");
            // Reproduce the old sweeper losing the original cause.
            yield* repo.quarantine(claim, "native-build-abandoned");
            const next = yield* consumer(db, owner);
            expect(yield* Effect.flip(catalog.acquire({ ...input, consumer: next }))).toMatchObject(
              { code: "mechanism-failed", detail: "native-guest-command-failed" },
            );
            expect(yield* repo.get(pin.publicationId)).toMatchObject({
              state: "superseded",
              reason: "native-guest-command-failed",
            });
            const replacement = (yield* nativeConsumerRows(db, next.runId))[0];
            expect(replacement?.publicationId).not.toBe(pin.publicationId);
            expect(f.mutations.filter((m) => m === "POST /api/v1/sandboxes")).toHaveLength(2);
          }),
        );
      }),
    ),
  );

  it.live(
    "keeps a legacy swept integrity failure closed after recovering its original journal cause",
    () =>
      test((repo, db) =>
        Effect.gen(function* () {
          const owner = yield* seed(db);
          const f = yield* Effect.promise(() => nativeBuilderFixture("agent-manifest-mismatch"));
          const original = yield* consumer(db, owner);
          yield* throughCatalog(db, f, (catalog) =>
            Effect.gen(function* () {
              const input = { scope: { kind: "owner" as const, ownerUserId: owner }, spec: f.spec };
              const failed = yield* Effect.flip(catalog.acquire({ ...input, consumer: original }));
              if (!(failed instanceof NativeCatalogError)) throw failed;
              const pin = (yield* nativeConsumerRows(db, original.runId))[0];
              if (pin === undefined) throw new Error("missing pin");
              const claim = yield* repo.claim(pin.publicationId, "reconcile", 60000);
              if (claim === undefined) throw new Error("missing claim");
              yield* repo.quarantine(claim, "native-build-abandoned");
              const calls = f.mutations.length,
                next = yield* consumer(db, owner);
              expect(
                yield* Effect.flip(catalog.acquire({ ...input, consumer: next })),
              ).toMatchObject({ code: "publication-quarantined", detail: failed.detail });
              expect(yield* repo.get(pin.publicationId)).toMatchObject({
                state: "quarantined",
                reason: failed.detail,
                buildAttempt: 1,
              });
              expect(yield* nativeConsumerRows(db, next.runId)).toEqual([]);
              expect(f.mutations).toHaveLength(calls);
            }),
          );
        }),
      ),
  );

  it.live("keeps integrity, unknown-journal and cleanup quarantine closed to new sessions", () =>
    test((repo, db) =>
      Effect.gen(function* () {
        const f = yield* prepare(db);
        for (const reason of [
          "native-publication-evidence-mismatch",
          "native-snapshot-identity-mismatch",
          "native-journal-missing",
          "native-cleanup-pending",
        ]) {
          const key = { ...f.key, deploymentId: reason };
          const original = yield* consumer(db, f.owner);
          const failed = yield* repo.reserve(key, original);
          const claim = yield* repo.claim(failed.ownership.publicationId, "build", 60000);
          if (claim === undefined) throw new Error("missing claim");
          yield* repo.quarantine(claim, reason);
          const unchanged = yield* repo.reserve(key, yield* consumer(db, f.owner));
          expect(unchanged).toMatchObject({ state: "quarantined", buildAttempt: 1, reason });
          expect(unchanged.ownership).toEqual(failed.ownership);
        }
        expect(f.mutations).toEqual([]);
      }),
    ),
  );

  it.live("withdraws only the exact unused build and removes it through its journal", () =>
    test((repo, db) =>
      Effect.gen(function* () {
        const f = yield* published(repo, db);
        {
          const ready = yield* repo.publish(f.claim, f.publication);
          const withdraw = (ownership: typeof ready.ownership) =>
            throughCatalog(db, f, (catalog) => catalog.withdraw(ownership));
          expect(Result.isFailure(yield* Effect.result(withdraw(ready.ownership)))).toBe(true);
          yield* repo.release(f.pin, f.publication.publicationId);
          expect(yield* repo.retire(f.publication.publicationId)).toBeUndefined();
          expect(
            Result.isFailure(
              yield* Effect.result(withdraw({ ...ready.ownership, buildId: randomUUID() })),
            ),
          ).toBe(true);
          yield* repo.withdraw(ready.ownership);
          const held = yield* repo.claim(f.publication.publicationId, "remove", 60000);
          expect(held).toBeDefined();
          expect(Result.isFailure(yield* Effect.result(withdraw(ready.ownership)))).toBe(true);
          yield* expireNativeClaim(db, f.publication.publicationId);
          yield* withdraw(ready.ownership);
          expect((yield* repo.get(f.publication.publicationId))?.state).toBe("removed");
          yield* withdraw(ready.ownership);
        }
      }),
    ),
  );
  beforeAll(async () => {
    if (
      databaseUrl === undefined ||
      !/^postgresql:\/\/stage2a:stage2a_fake_password@127\.0\.0\.1:\d+\/stage2a$/.test(databaseUrl)
    )
      throw new Error("explicit disposable loopback database required");
    const result = await runMigrations({
      databaseUrl,
      migrationsFolder: fileURLToPath(new URL("../../../../db/drizzle", import.meta.url)),
      log: () => undefined,
    });
    expect(result.applied).toBeDefined();
  }, 90000);

  it.live(
    "coalesces concurrent same-scope reservations and separates owner/resource-domain/deployment scope",
    () =>
      test((repo, db) =>
        Effect.gen(function* () {
          const f = yield* prepare(db);
          const pins = yield* Effect.forEach(Array.from({ length: 12 }), () =>
            consumer(db, f.owner),
          );
          const rows = yield* Effect.all(
            pins.map((pin) => repo.reserve(f.key, pin)),
            { concurrency: "unbounded" },
          );
          expect(new Set(rows.map((row) => row.ownership.publicationId)).size).toBe(1);
          expect(new Set(rows.map((row) => row.ownership.buildId)).size).toBe(1);
          const next = yield* consumer(db, f.owner);
          const separate = yield* repo.reserve(
            { ...f.key, scope: { kind: "resource-domain", domainId: `rdm:${randomUUID()}` } },
            next,
          );
          expect(separate.ownership.publicationId).not.toBe(rows[0]?.ownership.publicationId);
          const elsewhere = yield* repo.reserve(
            { ...f.key, deploymentId: "another-deployment" },
            yield* consumer(db, f.owner),
          );
          expect(elsewhere.ownership.publicationId).not.toBe(rows[0]?.ownership.publicationId);
        }),
      ),
  );

  it.live(
    "preserves exact consumer bindings through repeated acquisition and canonical release",
    () =>
      test((repo, db) =>
        Effect.gen(function* () {
          const f = yield* prepare(db);
          const pin = yield* consumer(db, f.owner);
          const first = yield* repo.reserve(f.key, pin);
          expect((yield* repo.reserve(f.key, pin)).ownership).toEqual(first.ownership);
          expect(
            yield* Effect.flip(repo.reserve({ ...f.key, deploymentId: "elsewhere" }, pin)),
          ).toMatchObject({ code: "consumer-conflict" });
          yield* repo.markConsumer(pin, first.ownership.publicationId, "retained");
          yield* repo.release(pin, first.ownership.publicationId);
          yield* repo.release(pin, first.ownership.publicationId);
          expect(yield* Effect.flip(repo.reserve(f.key, pin))).toMatchObject({
            code: "consumer-released",
          });
          expect(yield* nativeConsumerRows(db, pin.runId)).toMatchObject([
            { state: "released", publicationId: first.ownership.publicationId },
          ]);
        }),
      ),
  );

  it.live(
    "fences stale completion and adopts the exact published journal after a lost DB success",
    () =>
      test((repo, db) =>
        Effect.gen(function* () {
          const f = yield* published(repo, db);
          yield* expireNativeClaim(db, f.publication.publicationId);
          const next = yield* repo.claim(f.publication.publicationId, "reconcile", 60000);
          if (next === undefined) throw new Error("missing reconcile claim");
          expect(yield* Effect.flip(repo.publish(f.claim, f.publication))).toMatchObject({
            code: "stale-claim",
          });
          yield* repo.quarantine(next, "verification-pending");
          expect(yield* Effect.flip(repo.publish(next, f.publication))).toMatchObject({
            code: "stale-claim",
          });
          const fresh = yield* repo.claim(f.publication.publicationId, "reconcile", 60000);
          if (fresh === undefined) throw new Error("missing adoption claim");
          const recovered = yield* Effect.promise(() =>
            f.builder.reconcileBuild(f.reservation.ownership),
          );
          expect(recovered).toMatchObject({
            ok: true,
            value: {
              kind: "published",
              artifact: f.publication.snapshot,
              evidence: f.publication.evidence,
            },
          });
          expect((yield* repo.publish(fresh, f.publication)).state).toBe("ready");
          expect((yield* repo.reserve(f.key, f.pin)).publication).toEqual(f.publication);
          expect(f.posts()).toBe(1);
        }),
      ),
  );

  it.live("rejects malformed serialized keys and publication/receipt bindings on reads", () =>
    test((repo, db) =>
      Effect.gen(function* () {
        const f = yield* published(repo, db);
        yield* repo.publish(f.claim, f.publication);
        yield* corruptNativePublication(db, f.publication.publicationId, {
          ...f.publication,
          evidence: { ...f.publication.evidence, assetsHash: "0".repeat(64) },
        });
        expect(yield* Effect.flip(repo.get(f.publication.publicationId))).toMatchObject({
          code: "malformed-state",
        });
        yield* corruptNativeKey(db, f.publication.publicationId);
        expect(yield* Effect.flip(repo.get(f.publication.publicationId))).toMatchObject({
          code: "malformed-state",
        });
      }),
    ),
  );
  it.live(
    "keeps ten recent plans and indefinite retained/unknown pins, then fences pin versus retirement",
    () =>
      test((repo, db) =>
        Effect.gen(function* () {
          const f = yield* prepare(db);
          const entries: Array<{
            id: string;
            pin: ReturnType<typeof nativeArtifactConsumerSchema.parse>;
          }> = [];
          for (let index = 0; index < 12; index++) {
            const spec = {
              ...f.spec,
              lifecycle: {
                ...f.spec.lifecycle,
                setup: [{ run: `echo stage2a-${index}`, shell: "bash" as const }],
              },
            };
            const plan = yield* Effect.promise(() => f.builder.plan(spec));
            if (!plan.ok) throw plan.error;
            const pin = yield* consumer(db, f.owner);
            const reservation = yield* repo.reserve({ ...f.key, ...plan.value }, pin);
            const id = reservation.ownership.publicationId;
            const claim = yield* repo.claim(id, "build", 60000);
            if (claim === undefined) throw new Error("missing claim");
            const built = yield* Effect.promise(() =>
              f.builder.build({ spec, ownership: reservation.ownership }),
            );
            if (!built.ok) throw built.error;
            yield* repo.publish(claim, {
              kind: "boat-native",
              publicationId: id,
              snapshot: built.value.artifact,
              evidence: built.value.evidence,
            });
            yield* repo.release(pin, id);
            entries.push({ id, pin });
          }
          const oldest = entries[0];
          const other = entries[1];
          const newest = entries.at(-1);
          if (!oldest || !other || !newest) throw new Error("missing fixtures");
          yield* ageNativePublication(db, oldest.id);
          yield* ageNativePublication(db, other.id);
          yield* ageNativePublication(db, newest.id);
          expect(yield* repo.retire(newest.id)).toBeUndefined();
          const record = yield* repo.get(oldest.id);
          if (!record) throw new Error("missing publication");
          const retained = yield* consumer(db, f.owner);
          const unresolved = yield* consumer(db, f.owner);
          yield* repo.reserve(record.ownership.key, retained);
          yield* repo.reserve(record.ownership.key, unresolved);
          yield* repo.markConsumer(retained, oldest.id, "retained");
          yield* repo.markConsumer(unresolved, oldest.id, "unknown");
          expect(yield* repo.retire(oldest.id)).toBeUndefined();
          yield* repo.release(retained, oldest.id);
          expect(yield* repo.retire(oldest.id)).toBeUndefined();
          yield* repo.release(unresolved, oldest.id);
          const racer = yield* consumer(db, f.owner);
          const [pinResult, retired] = yield* Effect.all(
            [Effect.result(repo.reserve(record.ownership.key, racer)), repo.retire(oldest.id)],
            { concurrency: "unbounded" },
          );
          if (retired === undefined) {
            expect(Result.isSuccess(pinResult)).toBe(true);
            yield* repo.release(racer, oldest.id);
          } else {
            expect(Result.isFailure(pinResult)).toBe(true);
            expect(retired.state).toBe("retiring");
          }
          const retiring = yield* repo.retire(oldest.id);
          expect(retiring?.state).toBe("retiring");
          expect(
            yield* Effect.flip(repo.reserve(record.ownership.key, yield* consumer(db, f.owner))),
          ).toMatchObject({ code: "consumer-conflict" });
          const removal = yield* repo.claim(oldest.id, "remove", 60000);
          if (!removal || retiring?.publication === null || retiring?.publication === undefined)
            throw new Error("missing removal claim");
          const artifact = retiring.publication.snapshot;
          const removed = yield* Effect.promise(() => f.builder.remove(artifact));
          expect(removed).toEqual({ ok: true, value: "deleted" });
          yield* repo.removed(removal);
          expect((yield* repo.get(oldest.id))?.state).toBe("removed");
          expect(
            f.mutations.filter((entry) => entry.startsWith("DELETE /api/v1/saved-snapshots/")),
          ).toEqual([
            `DELETE /api/v1/saved-snapshots/${retiring.publication.snapshot.identity.name}`,
          ]);
        }),
      ),
    30000,
  );

  it.live(
    "acquires one publication concurrently through the catalog and preserves exact pins on retry",
    () =>
      test((_repo, db) =>
        Effect.gen(function* () {
          const f = yield* prepare(db);
          const pins = yield* Effect.forEach(Array.from({ length: 8 }), () =>
            consumer(db, f.owner),
          );
          yield* throughCatalog(db, f, (catalog) =>
            Effect.gen(function* () {
              const input = (pin: (typeof pins)[number]) => ({
                scope: f.key.scope,
                spec: f.spec,
                consumer: pin,
              });
              const results = yield* Effect.all(
                pins.map((pin) => Effect.result(catalog.acquire(input(pin)))),
                { concurrency: "unbounded" },
              );
              for (const result of results) {
                if (Result.isFailure(result))
                  expect(result.failure).toMatchObject({ code: "publication-pending" });
              }
              const acquired = yield* Effect.forEach(pins, (pin) => catalog.acquire(input(pin)));
              expect(new Set(acquired.map((entry) => entry.publicationId)).size).toBe(1);
              const first = acquired[0];
              if (first === undefined) throw new Error("missing publication");
              for (const entry of acquired) expect(entry).toEqual(first);
              expect(f.posts()).toBe(1);
              for (const pin of pins)
                expect(yield* nativeConsumerRows(db, pin.runId)).toEqual([
                  { state: "pending", publicationId: first.publicationId },
                ]);
              const other = yield* catalog.acquire({
                ...input(yield* consumer(db, f.owner)),
                scope: { kind: "resource-domain", domainId: `rdm:${randomUUID()}` },
              });
              expect(other.publicationId).not.toBe(first.publicationId);
              expect(f.posts()).toBe(2);
              const pin = pins[0];
              if (pin === undefined) throw new Error("missing pin");
              yield* catalog.markConsumer(pin, first.publicationId, "retained");
              expect(yield* catalog.acquire(input(pin))).toEqual(first);
              expect(yield* nativeConsumerRows(db, pin.runId)).toEqual([
                { state: "retained", publicationId: first.publicationId },
              ]);
              yield* catalog.release(pin, first.publicationId);
              yield* catalog.release(pin, first.publicationId);
              expect(yield* Effect.flip(catalog.acquire(input(pin)))).toMatchObject({
                code: "consumer-released",
              });
            }),
          );
        }),
      ),
  );

  it.live(
    "skips an active claim, then adopts a crash after journal publication without installing or saving again",
    () =>
      test((repo, db) =>
        Effect.gen(function* () {
          const f = yield* published(repo, db);
          const mutations = [...f.mutations];
          yield* throughCatalog(db, f, (catalog) =>
            Effect.gen(function* () {
              expect((yield* catalog.reconcile({ limit: 20 })).entries).toContainEqual({
                id: f.reservation.ownership.buildId,
                outcome: "skipped",
                code: "active-claim",
              });
              yield* expireNativeClaim(db, f.publication.publicationId);
              const unlock = yield* Effect.promise(() =>
                f.holdAttempt(f.reservation.ownership.buildId),
              );
              expect((yield* catalog.reconcile({ limit: 20 })).entries).toContainEqual({
                id: f.reservation.ownership.buildId,
                outcome: "skipped",
                code: "active-attempt",
              });
              expect((yield* repo.get(f.publication.publicationId))?.claim).toBeNull();
              yield* Effect.promise(unlock);
              expect((yield* catalog.reconcile({ limit: 20 })).entries).toContainEqual({
                id: f.reservation.ownership.buildId,
                outcome: "updated",
                code: "adopted",
              });
              expect(
                yield* catalog.acquire({ scope: f.key.scope, spec: f.spec, consumer: f.pin }),
              ).toEqual(f.publication);
              expect(f.posts()).toBe(1);
              expect(f.mutations).toEqual(mutations);
              expect(yield* Effect.flip(repo.publish(f.claim, f.publication))).toMatchObject({
                code: "stale-claim",
              });
            }),
          );
        }),
      ),
  );

  it.live(
    "retries acquisition after a lost catalog commit by adopting the stable builder journal",
    () =>
      test((repo, db) =>
        Effect.gen(function* () {
          const f = yield* published(repo, db);
          yield* expireNativeClaim(db, f.publication.publicationId);
          yield* throughCatalog(db, f, (catalog) =>
            Effect.gen(function* () {
              expect(
                yield* catalog.acquire({ scope: f.key.scope, spec: f.spec, consumer: f.pin }),
              ).toEqual(f.publication);
              expect(f.posts()).toBe(1);
              expect((yield* catalog.reconcile({ limit: 20 })).entries).toContainEqual({
                id: f.reservation.ownership.buildId,
                outcome: "skipped",
                code: "verified",
              });
            }),
          );
        }),
      ),
  );
  it.live(
    "keeps a started reservation with a missing journal quarantined without allocating again",
    () =>
      test((repo, db) =>
        Effect.gen(function* () {
          const f = yield* prepare(db);
          const pin = yield* consumer(db, f.owner);
          const record = yield* repo.reserve(f.key, pin);
          const id = record.ownership.publicationId;
          expect(yield* repo.claim(id, "build", 60000)).toBeDefined();
          yield* expireNativeClaim(db, id);
          expect(yield* repo.claim(id, "build", 60000)).toBeUndefined();
          yield* throughCatalog(db, f, (catalog) =>
            Effect.gen(function* () {
              const input = { scope: f.key.scope, spec: f.spec, consumer: pin };
              expect(yield* Effect.flip(catalog.acquire(input))).toMatchObject({
                code: "mechanism-failed",
                detail: "native-journal-missing",
              });
              expect(yield* Effect.flip(catalog.acquire(input))).toMatchObject({
                code: "publication-quarantined",
                detail: "native-journal-missing",
              });
              expect((yield* repo.get(id))?.state).toBe("quarantined");
              expect(f.mutations).toEqual([]);
            }),
          );
        }),
      ),
  );

  it.live(
    "quarantines disagreement with private evidence and keeps unowned journals as obligations",
    () =>
      test((_repo, db) =>
        Effect.gen(function* () {
          const f = yield* prepare(db);
          const pin = yield* consumer(db, f.owner);
          yield* throughCatalog(db, f, (catalog) =>
            Effect.gen(function* () {
              const input = { scope: f.key.scope, spec: f.spec, consumer: pin };
              const ready = yield* catalog.acquire(input);
              yield* corruptNativePublication(db, ready.publicationId, {
                ...ready,
                evidence: { ...ready.evidence, daemonRecovery: "unknown" },
              });
              expect(yield* Effect.flip(catalog.acquire(input))).toMatchObject({
                code: "publication-quarantined",
                detail: "native-publication-evidence-mismatch",
              });
              const orphan = yield* Effect.promise(() => f.builder.build({ spec: f.spec }));
              if (!orphan.ok) throw orphan.error;
              const report = yield* catalog.reconcile({ limit: 20 });
              expect(report.entries).toContainEqual({
                id: orphan.value.artifact.build,
                outcome: "obligation",
                code: "native-journal-ownership-unresolved",
              });
              expect(report.entries).toContainEqual({
                id: ready.snapshot.build,
                outcome: "obligation",
                code: "native-publication-evidence-mismatch",
              });
              expect(
                f.mutations.filter((entry) => entry.startsWith("DELETE /api/v1/saved-snapshots/")),
              ).toEqual([]);
              const path = join(f.root, ready.snapshot.build + ".json");
              const journal = yield* Effect.promise(async () => {
                const contents: unknown = JSON.parse(await readFile(path, "utf8"));
                return z
                  .object({ ownership: nativeBuildOwnershipSchema })
                  .passthrough()
                  .parse(contents);
              });
              yield* Effect.promise(() =>
                writeFile(path, JSON.stringify({ ...journal, phase: "running" })),
              );
              expect((yield* catalog.reconcile({ limit: 20 })).entries).toContainEqual({
                id: ready.snapshot.build,
                outcome: "obligation",
                code: "native-artifact-not-owned",
              });
              expect(
                f.mutations.filter((entry) => entry.startsWith("DELETE /api/v1/saved-snapshots/")),
              ).toEqual([]);
              yield* Effect.promise(() =>
                writeFile(
                  path,
                  JSON.stringify({
                    ...journal,
                    ownership: { ...journal.ownership, publicationId: randomUUID() },
                  }),
                ),
              );
              expect((yield* catalog.reconcile({ limit: 20 })).entries).toContainEqual({
                id: ready.snapshot.build,
                outcome: "obligation",
                code: "native-journal-ownership-unresolved",
              });
            }),
          );
        }),
      ),
  );

  it.live(
    "reaps only unpinned native publications and retries uncertain removal without resurrection",
    () =>
      test((repo, db) =>
        Effect.gen(function* () {
          const f = yield* prepare(db);
          yield* throughCatalog(db, f, (catalog) =>
            Effect.gen(function* () {
              const entries: Array<{ id: string }> = [];
              for (let index = 0; index < 12; index++) {
                const spec = {
                  ...f.spec,
                  lifecycle: {
                    ...f.spec.lifecycle,
                    setup: [{ run: `echo catalog-${index}`, shell: "bash" as const }],
                  },
                };
                const pin = yield* consumer(db, f.owner);
                const ready = yield* catalog.acquire({ scope: f.key.scope, spec, consumer: pin });
                yield* catalog.release(pin, ready.publicationId);
                entries.push({ id: ready.publicationId });
              }
              let after: string | undefined;
              const visited: string[] = [];
              do {
                const page = yield* catalog.reap({
                  scope: f.key.scope,
                  limit: 5,
                  ...(after === undefined ? {} : { after }),
                });
                expect(page.entries.length).toBeLessThanOrEqual(5);
                visited.push(...page.entries.map((entry) => entry.id));
                after = page.next;
              } while (after !== undefined);
              expect(visited.toSorted()).toEqual(entries.map((entry) => entry.id).toSorted());
              const oldest = entries[0],
                other = entries[1];
              if (!oldest || !other) throw new Error("missing publications");
              yield* ageNativePublication(db, oldest.id);
              yield* ageNativePublication(db, other.id);
              const record = yield* repo.get(oldest.id);
              if (!record || record.publication === null) throw new Error("missing publication");
              const artifact = record.publication.snapshot;
              const recovery = yield* consumer(db, f.owner);
              yield* repo.reserve(record.ownership.key, recovery);
              yield* catalog.markConsumer(recovery, oldest.id, "retained");
              expect(
                (yield* catalog.reap({ scope: f.key.scope, limit: 200 })).entries,
              ).toContainEqual({ id: oldest.id, outcome: "skipped", code: "retained" });
              yield* catalog.markConsumer(recovery, oldest.id, "unknown");
              expect(yield* repo.retire(oldest.id)).toBeUndefined();
              yield* catalog.release(recovery, oldest.id);
              f.failSnapshotRemoval();
              expect(
                (yield* catalog.reap({ scope: f.key.scope, limit: 200 })).entries,
              ).toContainEqual({
                id: oldest.id,
                outcome: "obligation",
                code: "native-provider-provider_error",
              });
              expect((yield* repo.get(oldest.id))?.state).toBe("quarantined");
              expect(yield* repo.claim(oldest.id, "reconcile", 60000)).toBeUndefined();
              expect(
                yield* Effect.flip(
                  repo.reserve(record.ownership.key, yield* consumer(db, f.owner)),
                ),
              ).toMatchObject({ code: "consumer-conflict" });
              expect((yield* catalog.reconcile({ limit: 100 })).entries).toContainEqual({
                id: record.ownership.buildId,
                outcome: "updated",
                code: "removed",
              });
              expect((yield* repo.get(oldest.id))?.state).toBe("removed");
              f.replaceSnapshot(artifact.identity.name);
              expect(yield* Effect.promise(() => f.builder.remove(artifact))).toEqual({
                ok: true,
                value: "absent",
              });
              const deletions = f.mutations.filter((entry) =>
                entry.startsWith("DELETE /api/v1/saved-snapshots/"),
              );
              expect(
                deletions.filter((entry) => entry.endsWith(artifact.identity.name)),
              ).toHaveLength(2);
              expect(
                deletions.every((entry) => entry.startsWith("DELETE /api/v1/saved-snapshots/")),
              ).toBe(true);
            }),
          );
        }),
      ),
    30000,
  );

  it.live(
    "preserves exact bindings and permanent release across generated state and retry sequences",
    () =>
      test((repo, db) =>
        Effect.gen(function* () {
          const f = yield* prepare(db);
          const commands = Arbitrary.array(
            Arbitrary.schema(
              Schema.Literals(["pending", "live", "retained", "unknown", "released"]),
            ),
            { minLength: 1, maxLength: 15 },
          );
          const result = yield* Arbitrary.checkEffect(
            commands,
            (states) =>
              Effect.gen(function* () {
                const pin = yield* consumer(db, f.owner);
                const reserved = yield* repo.reserve(f.key, pin);
                let released = false;
                for (const state of states) {
                  if (state === "released") {
                    yield* repo.release(pin, reserved.ownership.publicationId);
                    released = true;
                  } else if (!released) {
                    yield* repo.markConsumer(pin, reserved.ownership.publicationId, state);
                  } else {
                    expect(
                      yield* Effect.flip(
                        repo.markConsumer(pin, reserved.ownership.publicationId, state),
                      ),
                    ).toMatchObject({ code: "consumer-released" });
                  }
                  const replay = yield* Effect.result(
                    repo.reserve(
                      {
                        platform: f.key.platform,
                        assetsHash: f.key.assetsHash,
                        runtime: { ...f.key.runtime },
                        recipeHash: f.key.recipeHash,
                        scope: f.key.scope,
                        deploymentId: f.key.deploymentId,
                      },
                      pin,
                    ),
                  );
                  if (released)
                    expect(replay).toMatchObject({
                      _tag: "Failure",
                      failure: { code: "consumer-released" },
                    });
                  else {
                    if (Result.isFailure(replay)) return false;
                    expect(replay.success.ownership).toEqual(reserved.ownership);
                  }
                }
                return true;
              }),
            { runs: 24, size: 15, seed: "boat-stage2a-consumers" },
          );
          expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
          expect(result).toMatchObject({ _tag: "Passed", runs: 24 });
        }),
      ),
    30000,
  );
});
