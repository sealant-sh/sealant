/**
 * Resource domain budgets against real Postgres: a change takes the revision it read and answers
 * the budget it wrote, and a read is one snapshot even while a change and an allocation commit
 * around it. Gated on SEALANT_TEST_DATABASE_URL (a disposable, migrated database).
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  ResourceDomainRepo,
  ResourceDomainRepoLive,
  schema,
  SealantDB,
  type DB,
  type ResourceDomainBudget,
} from "@sealant/db";
import { Deferred, Effect, Fiber } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

const limits = (storageBytes: number): ResourceDomainBudget => ({
  cpuMillicores: 1,
  memoryBytes: 1,
  storageBytes,
});

describe.skipIf(DATABASE_URL === undefined)("resource domain budgets (Postgres)", () => {
  let db: DB;

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
  });

  const run = <A, E>(effect: Effect.Effect<A, E, ResourceDomainRepo | SealantDB>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(ResourceDomainRepoLive), Effect.provideService(SealantDB, db)),
    );
  const domain = async (budget?: ResourceDomainBudget) =>
    (
      await run(
        Effect.flatMap(ResourceDomainRepo, (repo) => repo.ensure(`test:${randomUUID()}`, budget)),
      )
    ).domain.id;
  const setBudget = (resourceDomainId: string, revision: number, budget: ResourceDomainBudget) =>
    run(
      Effect.flatMap(ResourceDomainRepo, (repo) =>
        repo.setBudget({ resourceDomainId, revision, budget }),
      ),
    );

  it("answers the budget a change wrote, refuses a stale revision, and answers a lost reply's retry", async () => {
    const id = await domain();
    const zero = { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 };
    const written = await setBudget(id, 1, limits(1));
    expect(written).toEqual({
      kind: "set",
      record: { budget: limits(1), revision: 2, charge: expect.anything() },
    });
    expect(await setBudget(id, 1, limits(1))).toEqual(written);
    expect(await setBudget(id, 2, limits(2))).toMatchObject({ record: { revision: 3 } });
    expect(await setBudget(id, 1, limits(1))).toEqual({ kind: "stale", revision: 3 });
    expect(await setBudget(id, 2, limits(9))).toEqual({ kind: "stale", revision: 3 });
    expect(await run(Effect.flatMap(ResourceDomainRepo, (repo) => repo.getBudget(id)))).toEqual({
      budget: limits(2),
      revision: 3,
      charge: { used: zero, reserved: zero, archivedBytes: 0, protectionBytes: 0 },
    });
  });

  it("reads one snapshot while a budget change and an allocation commit during the read", async () => {
    const id = await domain(limits(100));
    const read = await run(
      Effect.gen(function* () {
        const sql = yield* SealantDB;
        const repo = yield* ResourceDomainRepo;
        const locked = yield* Deferred.make<void>();
        const go = yield* Deferred.make<void>();
        // The writer holds the allocations table, so a read of it waits until the writer commits.
        const writer = yield* Effect.forkChild(
          sql.transaction(() =>
            Effect.gen(function* () {
              yield* sql.execute(
                `LOCK TABLE "resource_domain_allocations" IN ACCESS EXCLUSIVE MODE`,
              );
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(go);
              yield* sql.execute(
                `UPDATE "resource_domains" SET "storage_bytes" = 1000, "budget_revision" = 2 WHERE "id" = '${id}'`,
              );
              yield* sql.insert(schema.resourceDomainAllocations).values({
                id: randomUUID(),
                resourceDomainId: id,
                use: "volume",
                objectKey: `volume:${randomUUID()}`,
                operationKey: randomUUID(),
                storageBytes: 900,
              });
            }),
          ),
        );
        yield* Deferred.await(locked);
        const reader = yield* Effect.forkChild(repo.getBudget(id));
        yield* Effect.sleep("300 millis");
        yield* Deferred.succeed(go, undefined);
        yield* Fiber.join(writer);
        return yield* Fiber.join(reader);
      }),
    );
    // Before the writer committed, or after: never its old limit with its new allocation.
    expect([read?.revision, read?.budget.storageBytes, read?.charge.reserved.storageBytes]).toEqual(
      read?.revision === 1 ? [1, 100, 0] : [2, 1000, 900],
    );
  });
});
