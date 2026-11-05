import { randomUUID } from "node:crypto";
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
import { nativeArtifactConsumerSchema, type NativePublicationKey } from "@sealant/validators";
import { Effect, Layer, Result } from "effect";
import { beforeAll, describe, expect } from "vitest";

import { nativeBuilderFixture } from "./builder.fixture.js";

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
    const runId = `run_${randomUUID()}`;
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

describe.skipIf(!enabled)("native publication ownership in migrated disposable Postgres", () => {
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
});
