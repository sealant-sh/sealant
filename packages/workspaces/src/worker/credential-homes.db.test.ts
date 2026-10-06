/**
 * The per-home login record against a REAL Postgres (docs/connected-accounts-design.md §6c): two
 * writes into one home take turns, the second deciding on what the first left (a first write too,
 * before any row exists); a failed write changes nothing; a release deletes the row; and a refresh
 * push lists only the homes of ready instances that hold the account. Gated on
 * SEALANT_TEST_DATABASE_URL (a disposable database with the migrations applied; it writes rows
 * under fresh ids and leaves them).
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/worker/credential-homes.db.test.ts
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  SealantDB,
  user,
  workspaceAttempts,
  WorkspaceCredentialHomeRepo,
  WorkspaceCredentialHomeRepoLive,
  makeWorkspaceCredentialHomeRepoLayer,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
  type WorkspaceCredentialHome,
} from "@sealant/db";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

const hold = (person: string, connectedAccountId: string) =>
  ({
    kind: "hold",
    onBehalfOfUserId: person,
    accounts: [{ provider: "claude", connectedAccountId }],
    generation: `generation-${person}`,
  }) as const;

describe.skipIf(DATABASE_URL === undefined)("credential homes (Postgres)", () => {
  let db: DB;
  const userId = `user_homes_${randomUUID()}`;

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    await Effect.runPromise(
      db.insert(user).values({ id: userId, name: "homes", email: `${userId}@example.test` }),
    );
  });

  const run = <A, E>(
    effect: Effect.Effect<A, E, WorkspaceCredentialHomeRepo | WorkspaceRuntimeInstanceRepo>,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(WorkspaceCredentialHomeRepoLive, WorkspaceRuntimeInstanceRepoLive).pipe(
            Layer.provide(Layer.succeed(SealantDB, db)),
          ),
        ),
      ),
    );

  const launch = async (status: "ready" | "stopped") => {
    const runId = `run_homes_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(workspaceAttempts).values({ id: runId, ownerUserId: userId }),
    );
    await run(
      Effect.gen(function* () {
        yield* (yield* WorkspaceRuntimeInstanceRepo).upsertRuntimeInstance({
          runId,
          status,
          adapter: "docker",
          resourceId: `container-${runId}`,
          launchCredentialInjections: [],
        });
      }),
    );
    return runId;
  };

  it("serialises two first writes into one home: the second sees the first's person", async () => {
    const runId = await launch("ready");
    const home = "/run/mend/conv/ses_race";
    const seen = await run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCredentialHomeRepo;
        const firstInside = yield* Deferred.make<void>();
        const letFirstFinish = yield* Deferred.make<void>();
        const first = yield* repo
          .withLockedHome({ runId, home }, () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(firstInside, undefined);
              yield* Deferred.await(letFirstFinish);
              return { result: "first", outcome: hold("usr_alice", "cacc_alice") };
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstInside);
        const observed: Array<WorkspaceCredentialHome | undefined> = [];
        const second = yield* repo
          .withLockedHome({ runId, home }, (held) =>
            Effect.sync(() => {
              observed.push(held);
              return { result: "second", outcome: { kind: "keep" as const } };
            }),
          )
          .pipe(Effect.forkChild);
        // The second waits on the first's lock while the first holds it.
        yield* Effect.sleep("200 millis");
        const whileFirstHeld = observed.length;
        yield* Deferred.succeed(letFirstFinish, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        return { whileFirstHeld, observed };
      }),
    );
    expect(seen.whileFirstHeld).toBe(0);
    expect(seen.observed).toHaveLength(1);
    expect(seen.observed[0]?.onBehalfOfUserId).toBe("usr_alice");
  });

  it("answers busy, retryably, when another write holds the home past the wait", async () => {
    const runId = await launch("ready");
    const home = "/home/m4busy000";
    const quick = makeWorkspaceCredentialHomeRepoLayer({ lockTimeoutMs: 200 }).pipe(
      Layer.provide(Layer.succeed(SealantDB, db)),
    );
    const outcome = await run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCredentialHomeRepo;
        const inside = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const holder = yield* repo
          .withLockedHome({ runId, home }, () =>
            Deferred.succeed(inside, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as({ result: undefined, outcome: { kind: "keep" as const } }),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(inside);
        const waited = yield* Effect.gen(function* () {
          return yield* (yield* WorkspaceCredentialHomeRepo).withLockedHome({ runId, home }, () =>
            Effect.succeed({ result: "ran", outcome: { kind: "keep" as const } }),
          );
        }).pipe(Effect.provide(quick), Effect.flip);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(holder);
        return waited;
      }),
    );
    expect(outcome).toMatchObject({ _tag: "WorkspaceCredentialHomeBusyError" });
  });

  it("changes nothing when the write fails, and deletes the row on release", async () => {
    const runId = await launch("ready");
    const home = "/home/m4lice000";
    const rows = await run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCredentialHomeRepo;
        yield* repo.withLockedHome({ runId, home }, () =>
          Effect.succeed({ result: undefined, outcome: hold("usr_alice", "cacc_alice") }),
        );
        const failed = yield* repo
          .withLockedHome({ runId, home }, () => Effect.fail("the executor did not answer"))
          .pipe(Effect.flip);
        const afterFailure = yield* repo.listByRunId(runId);
        yield* repo.withLockedHome({ runId, home }, () =>
          Effect.succeed({ result: undefined, outcome: { kind: "release" as const } }),
        );
        return { failed, afterFailure, afterRelease: yield* repo.listByRunId(runId) };
      }),
    );
    expect(rows.failed).toBe("the executor did not answer");
    expect(rows.afterFailure.map((row) => [row.onBehalfOfUserId, row.accounts])).toEqual([
      ["usr_alice", [{ provider: "claude", connectedAccountId: "cacc_alice" }]],
    ]);
    expect(rows.afterRelease).toEqual([]);
  });

  it("lists for a push only the homes of ready instances that hold the account", async () => {
    const ready = await launch("ready");
    const stopped = await launch("stopped");
    const account = `cacc_${randomUUID()}`;
    const listed = await run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceCredentialHomeRepo;
        yield* repo.withLockedHome({ runId: ready, home: "/home/a" }, () =>
          Effect.succeed({ result: undefined, outcome: hold("usr_alice", account) }),
        );
        yield* repo.withLockedHome({ runId: ready, home: "/home/b" }, () =>
          Effect.succeed({ result: undefined, outcome: hold("usr_bob", `cacc_${randomUUID()}`) }),
        );
        yield* repo.withLockedHome({ runId: stopped, home: "/home/a" }, () =>
          Effect.succeed({ result: undefined, outcome: hold("usr_alice", account) }),
        );
        return yield* repo.listReadyHoldingAccount(account);
      }),
    );
    expect(listed.map((target) => [target.home.runId, target.home.home])).toEqual([
      [ready, "/home/a"],
    ]);
  });
});
