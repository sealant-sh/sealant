/**
 * Admission to a resource domain's budget against real Postgres: reservations and events racing
 * on two connections queue for the domain and never exceed it, a repeat charges once, an
 * unconfirmed outcome stays charged, only a confirmed stop or purge releases, a backup draws on its
 * volume's reserve, and a fenced or archived domain still admits preservation. Gated on
 * SEALANT_TEST_DATABASE_URL (a disposable, migrated database).
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  ResourceDomainRepo,
  ResourceDomainRepoLive,
  RESOURCE_DOMAIN_ADMISSION_ISOLATION,
  SealantDB,
  user,
  type DB,
  type ResourceDomainAdmissionRequest,
  type ResourceDomainAllocationEvent,
  type ResourceDomainBudget,
} from "@sealant/db";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import {
  admitToResourceDomain,
  recordResourceDomainAllocation,
} from "./resource-domain-admission.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

const compute = (cpuMillicores: number, memoryBytes = 1): ResourceDomainAdmissionRequest => ({
  use: "compute",
  objectKey: `service:${randomUUID()}`,
  cpuMillicores,
  memoryBytes,
});
const volume = (storageBytes: number, protectionBytes = 0): ResourceDomainAdmissionRequest => ({
  use: "volume",
  objectKey: `volume:${randomUUID()}`,
  storageBytes,
  protectionBytes,
});

const admission = (
  resourceDomainId: string,
  request: ResourceDomainAdmissionRequest,
  operationKey: string = randomUUID(),
) => admitToResourceDomain({ resourceDomainId, operationKey, request });
const backup = (
  sourceObjectKey: string,
  protectionBytes: number,
): ResourceDomainAdmissionRequest => ({
  use: "protection",
  objectKey: `backup:${randomUUID()}`,
  sourceObjectKey,
  protectionBytes,
});
const record = (
  resourceDomainId: string,
  allocationId: string,
  event: ResourceDomainAllocationEvent,
) => recordResourceDomainAllocation({ resourceDomainId, allocationId, event });

/** `effect` inside a REPEATABLE READ transaction. */
const repeatable = <A, E>(effect: Effect.Effect<A, E, ResourceDomainRepo>) =>
  Effect.flatMap(SealantDB, (sql) =>
    sql.transaction(() =>
      Effect.andThen(sql.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"), effect),
    ),
  );
const viaRepo = (use: (repo: ResourceDomainRepo["Service"]) => Effect.Effect<unknown, unknown>) =>
  Effect.flatMap(ResourceDomainRepo, use);

describe.skipIf(DATABASE_URL === undefined)("resource domain admission (Postgres)", () => {
  let db: DB;

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
  });

  const provided = <A, E>(effect: Effect.Effect<A, E, ResourceDomainRepo | SealantDB>) =>
    effect.pipe(Effect.provide(ResourceDomainRepoLive), Effect.provideService(SealantDB, db));
  const run = <A, E>(effect: Effect.Effect<A, E, ResourceDomainRepo | SealantDB>) =>
    Effect.runPromise(provided(effect));
  /** The typed failure an effect ends in. */
  const failure = async <A, E>(effect: Effect.Effect<A, E, ResourceDomainRepo | SealantDB>) => {
    const exit = await Effect.runPromiseExit(provided(effect));
    if (Exit.isSuccess(exit)) throw new Error("expected a failure");
    return Cause.squash(exit.cause);
  };

  const domain = async (budget: Partial<ResourceDomainBudget>) => {
    const ensured = await run(
      Effect.flatMap(ResourceDomainRepo, (repo) =>
        repo.ensure(`test:${randomUUID()}`, {
          cpuMillicores: 0,
          memoryBytes: 0,
          storageBytes: 0,
          ...budget,
        }),
      ),
    );
    return ensured.domain.id;
  };
  const admit = (...args: Parameters<typeof admission>) => run(admission(...args));
  const charge = async (resourceDomainId: string) =>
    (await run(Effect.flatMap(ResourceDomainRepo, (repo) => repo.getBudget(resourceDomainId))))
      ?.charge;
  const setBudget = (resourceDomainId: string, revision: number, budget: ResourceDomainBudget) =>
    run(
      Effect.flatMap(ResourceDomainRepo, (repo) =>
        repo.setBudget({ resourceDomainId, revision, budget }),
      ),
    );

  /**
   * `held` runs in a transaction that stays open while `late` starts on another connection, then
   * commits. Answers whether `late` was still waiting when `held` committed, and both results.
   */
  const race = <A, E, B, F>(
    held: Effect.Effect<A, E, ResourceDomainRepo>,
    late: Effect.Effect<B, F, ResourceDomainRepo>,
  ) =>
    run(
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        const commit = yield* Deferred.make<void>();
        const first = yield* Effect.forkChild(
          Effect.flatMap(SealantDB, (sql) =>
            sql.transaction(() =>
              held.pipe(
                Effect.tap(() => Deferred.succeed(done, undefined)),
                Effect.tap(() => Deferred.await(commit)),
              ),
            ),
          ),
        );
        yield* Deferred.await(done);
        const second = yield* Effect.forkChild(Effect.exit(late));
        yield* Effect.sleep("300 millis");
        const waited = second.pollUnsafe() === undefined;
        yield* Deferred.succeed(commit, undefined);
        return { waited, held: yield* Fiber.join(first), late: yield* Fiber.join(second) };
      }),
    );

  it("serializes two reservations on two connections, so they never exceed the budget", async () => {
    const id = await domain({ storageBytes: 100 });
    const raced = await race(admission(id, volume(60)), admission(id, volume(60)));
    expect(await charge(id)).toMatchObject({ reserved: { storageBytes: 60 } });
    expect(Exit.isFailure(raced.late)).toBe(true);
    expect(raced.waited).toBe(true);

    const burst = await run(
      Effect.all(
        Array.from({ length: 12 }, () => Effect.exit(admission(id, volume(5)))),
        { concurrency: "unbounded" },
      ),
    );
    expect(burst.filter(Exit.isSuccess)).toHaveLength(8);
    expect(await charge(id)).toMatchObject({ reserved: { storageBytes: 100 } });
  });

  it("charges a repeated admission once, and refuses its key for another request", async () => {
    const id = await domain({ cpuMillicores: 1000, memoryBytes: 1000 });
    const request = compute(600, 600);
    const [first, again] = [await admit(id, request, "op-1"), await admit(id, request, "op-1")];
    expect(first.replayed).toBe(false);
    expect(again).toEqual({ allocation: first.allocation, replayed: true });
    expect(await charge(id)).toMatchObject({ reserved: { cpuMillicores: 600, memoryBytes: 600 } });
    expect(await failure(admission(id, compute(10, 10), "op-1"))).toMatchObject({
      _tag: "ResourceDomainAdmissionRefusedError",
      reason: "operation-key-reused",
    });
  });

  it("keeps an unconfirmed admission charged until its outcome is confirmed", async () => {
    const id = await domain({ cpuMillicores: 1000, memoryBytes: 1000 });
    const { allocation } = await admit(id, compute(700, 700));
    // The runtime never answered: nothing is recorded, and the charge stays.
    expect(await failure(admission(id, compute(400, 1)))).toMatchObject({
      _tag: "ResourceDomainBudgetReachedError",
      dimension: "cpuMillicores",
      used: 0,
      reserved: 700,
    });
    await run(record(id, allocation.id, "created"));
    expect(await charge(id)).toMatchObject({
      used: { cpuMillicores: 700 },
      reserved: { cpuMillicores: 0 },
    });
  });

  it("releases compute only on a confirmed stop, and storage only on a confirmed purge", async () => {
    const id = await domain({ cpuMillicores: 1000, memoryBytes: 1000, storageBytes: 1000 });
    const workloadRequest = compute(500, 500);
    const workload = (await admit(id, workloadRequest)).allocation;
    const data = (await admit(id, volume(400, 100))).allocation;
    await run(record(id, workload.id, "created"));
    await run(record(id, data.id, "created"));

    for (const [allocation, wrong] of [
      [workload, "purged"],
      [data, "stopped"],
    ] as const) {
      expect(await failure(record(id, allocation.id, wrong))).toMatchObject({
        reason: "event-does-not-apply",
      });
    }
    await run(record(id, data.id, "archived"));
    expect(await charge(id)).toEqual({
      used: { cpuMillicores: 500, memoryBytes: 500, storageBytes: 500 },
      reserved: { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 },
      archivedBytes: 400,
      protectionBytes: 0,
    });

    await run(record(id, workload.id, "stopped"));
    expect(await run(record(id, workload.id, "stopped"))).toMatchObject({ state: "released" });
    await run(record(id, data.id, "purged"));
    expect(await charge(id)).toMatchObject({
      used: { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 },
      archivedBytes: 0,
    });
    // A delayed repeat of a released admission is not admitted again.
    expect(await failure(admission(id, workloadRequest, workload.operationKey))).toMatchObject({
      reason: "operation-released",
    });
  });

  it("leaves held allocations alone when the budget is lowered, and refuses the next one", async () => {
    const id = await domain({ cpuMillicores: 1000, memoryBytes: 1000, storageBytes: 1000 });
    const { allocation } = await admit(id, compute(800, 100));
    await run(record(id, allocation.id, "created"));
    expect(
      await setBudget(id, 1, { cpuMillicores: 500, memoryBytes: 1000, storageBytes: 1000 }),
    ).toMatchObject({ kind: "set" });

    expect(await charge(id)).toMatchObject({ used: { cpuMillicores: 800 } });
    expect(await failure(admission(id, compute(1, 1)))).toMatchObject({
      _tag: "ResourceDomainBudgetReachedError",
      dimension: "cpuMillicores",
      used: 800,
      requested: 1,
      limit: 500,
    });
    // Only the dimension over its limit refuses: storage still has room.
    expect((await admit(id, volume(10))).replayed).toBe(false);
    expect(await run(record(id, allocation.id, "stopped"))).toMatchObject({ state: "released" });
  });

  it("names used, requested and limit with the remedies, and nothing the request sent", async () => {
    const id = await domain({ storageBytes: 1000 });
    await admit(id, volume(900));
    const request = volume(150, 50);
    const operationKey = `op-${randomUUID()}`;
    const refusal = await failure(admission(id, request, operationKey));
    expect(refusal).toMatchObject({
      _tag: "ResourceDomainBudgetReachedError",
      dimension: "storageBytes",
      used: 0,
      reserved: 900,
      requested: 200,
      limit: 1000,
      remedies: ["raise-budget", "purge-objects"],
    });
    const said = JSON.stringify(refusal);
    expect(said).toContain("Raise the budget, or purge objects you choose");
    expect(said).not.toContain(request.objectKey);
    expect(said).not.toContain(operationKey);
    expect(await failure(admission(id, compute(1, 1)))).toMatchObject({
      dimension: "cpuMillicores",
      remedies: ["raise-budget", "stop-objects"],
    });
  });

  it.each(["fenced", "archived"] as const)(
    "admits preservation of a held volume while %s, and no new work",
    async (state) => {
      const id = await domain({ cpuMillicores: 100, memoryBytes: 100, storageBytes: 1000 });
      const data = (await admit(id, volume(500))).allocation;
      // Fencing and archiving arrive with their own routes; set the state they leave.
      await Effect.runPromise(
        db.execute(`UPDATE "resource_domains" SET "state" = '${state}' WHERE "id" = '${id}'`),
      );

      const kept = await admit(id, backup(data.objectKey, 300));
      expect(kept.allocation).toMatchObject({ use: "protection", state: "reserved" });
      for (const work of [volume(10), compute(1, 1)]) {
        expect(await failure(admission(id, work))).toMatchObject({ reason: "domain-not-active" });
      }
      expect(await failure(admission(id, backup("volume:not-held", 1)))).toMatchObject({
        reason: "no-source-volume",
      });
      // Preservation stays inside the shared allowance.
      expect(await failure(admission(id, backup(data.objectKey, 201)))).toMatchObject({
        _tag: "ResourceDomainBudgetReachedError",
        reserved: 800,
        limit: 1000,
      });
    },
  );

  it("draws a backup from its volume's reserve, and keeps it charged after the volume's purge", async () => {
    const id = await domain({ storageBytes: 1000 });
    const data = (await admit(id, volume(700, 300))).allocation;
    // The budget is full, and the backup fits the reserve: it charges nothing more.
    const kept = (await admit(id, backup(data.objectKey, 300))).allocation;
    expect(await charge(id)).toMatchObject({
      reserved: { storageBytes: 1000 },
      protectionBytes: 300,
    });
    expect(await failure(admission(id, backup(data.objectKey, 1)))).toMatchObject({
      requested: 1,
      reserved: 1000,
    });
    await run(record(id, data.id, "purged"));
    expect(await charge(id)).toMatchObject({
      reserved: { storageBytes: 300 },
      protectionBytes: 300,
    });
    await run(record(id, kept.id, "purged"));
    expect(await charge(id)).toMatchObject({ reserved: { storageBytes: 0 }, protectionBytes: 0 });
  });

  it("replays a backup only when it names the same source, even after that source's purge", async () => {
    const id = await domain({ storageBytes: 1000 });
    const a = (await admit(id, volume(100, 200))).allocation;
    const b = (await admit(id, volume(100))).allocation;
    const objectKey = `backup:${randomUUID()}`;
    const backupOf = (sourceObjectKey: string): ResourceDomainAdmissionRequest => ({
      use: "protection",
      objectKey,
      sourceObjectKey,
      protectionBytes: 200,
    });
    const request = backupOf(a.objectKey);
    const kept = (await admit(id, request, "backup-once")).allocation;
    for (const sourceObjectKey of [b.objectKey, "volume:never-held"]) {
      expect(await failure(admission(id, backupOf(sourceObjectKey), "backup-once"))).toMatchObject({
        _tag: "ResourceDomainAdmissionRefusedError",
        reason: "operation-key-reused",
      });
    }
    await run(record(id, a.id, "purged"));
    const charged = await charge(id);
    expect(charged).toMatchObject({ reserved: { storageBytes: 300 }, protectionBytes: 200 });
    expect(await admit(id, request, "backup-once")).toEqual({ allocation: kept, replayed: true });
    expect(await charge(id)).toEqual(charged);
  });

  it("queues a purge and a backup of the purged volume, so the backup never outlives its check", async () => {
    // The budget is full: before the purge a backup does not fit; after it, it has no volume.
    const id = await domain({ storageBytes: 100 });
    const data = (await admit(id, volume(100))).allocation;
    const purgeFirst = await race(
      record(id, data.id, "purged"),
      admission(id, backup(data.objectKey, 50)),
    );
    expect(purgeFirst.waited).toBe(true);
    expect(Exit.isFailure(purgeFirst.late) && Cause.squash(purgeFirst.late.cause)).toMatchObject({
      reason: "no-source-volume",
    });
    expect(await charge(id)).toMatchObject({ reserved: { storageBytes: 0 }, protectionBytes: 0 });

    const other = (await admit(id, volume(100))).allocation;
    const backupFirst = await race(
      admission(id, backup(other.objectKey, 50)).pipe(Effect.exit),
      record(id, other.id, "purged"),
    );
    expect(backupFirst.waited).toBe(true);
    expect(backupFirst.held).toMatchObject({ _tag: "Failure" });
    expect(await charge(id)).toMatchObject({ reserved: { storageBytes: 0 }, protectionBytes: 0 });
  });

  it("refuses an amount it cannot hold exactly as an invalid amount, never a defect", async () => {
    const id = await domain({ storageBytes: Number.MAX_SAFE_INTEGER });
    for (const request of [
      volume(Number.MAX_SAFE_INTEGER, 1),
      volume(Number.MAX_SAFE_INTEGER, 2),
      volume(Number.MAX_SAFE_INTEGER + 1),
      volume(Number.MAX_SAFE_INTEGER + 2),
    ]) {
      expect(await failure(admission(id, request))).toMatchObject({
        _tag: "ResourceDomainAdmissionRefusedError",
        reason: "invalid-amount",
      });
    }
    await admit(id, volume(Number.MAX_SAFE_INTEGER - 1));
    expect(await failure(admission(id, volume(Number.MAX_SAFE_INTEGER - 1, 1)))).toMatchObject({
      _tag: "ResourceDomainBudgetReachedError",
      reserved: Number.MAX_SAFE_INTEGER - 1,
      requested: Number.MAX_SAFE_INTEGER,
      limit: Number.MAX_SAFE_INTEGER,
    });
  });

  it("lets a member grant through while an admission holds the domain", async () => {
    const id = await domain({ storageBytes: 100 });
    const person = `user_admission_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(user).values({ id: person, name: "admission", email: `${person}@example.test` }),
    );
    const grant = Effect.flatMap(ResourceDomainRepo, (repo) =>
      repo.decideMember({ resourceDomainId: id, userId: person, state: "member", version: 1 }),
    );
    const raced = await race(admission(id, volume(10)), grant);
    expect(raced.waited).toBe(false);
    expect(raced.late).toMatchObject({ _tag: "Success", value: { kind: "decided" } });
  });

  it("refuses to admit or record at any isolation but READ COMMITTED", async () => {
    const id = await domain({ storageBytes: 100 });
    const data = (await admit(id, volume(10))).allocation;
    const refusal = async <A, E>(effect: Effect.Effect<A, E, ResourceDomainRepo>) =>
      String(await failure(repeatable(effect)));
    const operationKey = randomUUID();
    expect(
      await refusal(
        viaRepo((repo) => repo.admit({ resourceDomainId: id, operationKey, request: volume(10) })),
      ),
    ).toContain(RESOURCE_DOMAIN_ADMISSION_ISOLATION);
    expect(
      await refusal(
        viaRepo((repo) =>
          repo.record({ resourceDomainId: id, allocationId: data.id, event: "created" }),
        ),
      ),
    ).toContain(RESOURCE_DOMAIN_ADMISSION_ISOLATION);
    expect(await charge(id)).toMatchObject({ reserved: { storageBytes: 10 } });
  });
});
