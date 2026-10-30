/**
 * Member decisions against real Postgres: each grant or revoke is a compare-and-set on the member's
 * version, so a grant racing a revoke from the same version can never undo it, and repeating a
 * decision changes nothing. Gated on SEALANT_TEST_DATABASE_URL (a disposable, migrated database).
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  ResourceDomainRepo,
  ResourceDomainRepoLive,
  SealantDB,
  user,
  type DB,
  type ResourceDomainMemberDecision,
} from "@sealant/db";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

describe.skipIf(DATABASE_URL === undefined)("resource domain members (Postgres)", () => {
  let db: DB;

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
  });

  const run = <A, E>(effect: Effect.Effect<A, E, ResourceDomainRepo>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(ResourceDomainRepoLive), Effect.provideService(SealantDB, db)),
    );

  /** A fresh person in a fresh domain. */
  const pair = async () => {
    const userId = `user_member_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(user).values({ id: userId, name: "member", email: `${userId}@example.test` }),
    );
    const { domain } = await run(
      Effect.flatMap(ResourceDomainRepo, (repo) => repo.ensure(`test:${randomUUID()}`)),
    );
    return { resourceDomainId: domain.id, userId };
  };

  const decide = (
    at: { readonly resourceDomainId: string; readonly userId: string },
    state: ResourceDomainMemberDecision["state"],
    version: number,
  ) =>
    run(Effect.flatMap(ResourceDomainRepo, (repo) => repo.decideMember({ ...at, state, version })));

  const deletePerson = (userId: string) =>
    db.execute(`DELETE FROM "user" WHERE "id" = '${userId}'`);

  const members = (resourceDomainId: string) =>
    run(
      Effect.flatMap(ResourceDomainRepo, (repo) =>
        repo.listMembers({ resourceDomainId, limit: 500 }),
      ),
    ).then((page) => page.members);

  /**
   * `held` is written in a transaction that stays open while `late` runs, then commits: `late`
   * must wait for the row and decide against what `held` left.
   */
  const race = (
    at: { readonly resourceDomainId: string; readonly userId: string },
    held: { readonly state: ResourceDomainMemberDecision["state"]; readonly version: number },
    late: { readonly state: ResourceDomainMemberDecision["state"]; readonly version: number },
  ) =>
    run(
      Effect.gen(function* () {
        const repo = yield* ResourceDomainRepo;
        const written = yield* Deferred.make<void>();
        const commit = yield* Deferred.make<void>();
        const first = yield* Effect.forkChild(
          db.transaction(() =>
            repo.decideMember({ ...at, ...held }).pipe(
              Effect.tap(() => Deferred.succeed(written, undefined)),
              Effect.tap(() => Deferred.await(commit)),
            ),
          ),
        );
        yield* Deferred.await(written);
        const second = yield* Effect.forkChild(repo.decideMember({ ...at, ...late }));
        yield* Effect.sleep("300 millis");
        const waited = second.pollUnsafe() === undefined;
        yield* Deferred.succeed(commit, undefined);
        return { waited, held: yield* Fiber.join(first), late: yield* Fiber.join(second) };
      }),
    );

  it.each([
    ["no decision yet", []],
    ["a grant at 1", [{ state: "member", version: 1 }]],
  ] as const)(
    "a delayed grant waits out a newer revoke, then cannot undo it (%s)",
    async (_before, earlier) => {
      const at = await pair();
      for (const decision of earlier) await decide(at, decision.state, decision.version);
      const raced = await race(
        at,
        { state: "revoked", version: 3 },
        { state: "member", version: 2 },
      );
      expect(raced.waited).toBe(true);
      expect(raced.held).toMatchObject({
        kind: "decided",
        member: { state: "revoked", version: 3 },
      });
      expect(raced.late).toMatchObject({
        kind: "stale",
        current: { state: "revoked", version: 3 },
      });
      expect(await members(at.resourceDomainId)).toEqual([
        expect.objectContaining({ userId: at.userId, state: "revoked", version: 3 }),
      ]);
    },
  );

  it("a newer grant that waits out an older revoke replaces it", async () => {
    const at = await pair();
    const raced = await race(at, { state: "revoked", version: 1 }, { state: "member", version: 2 });
    expect(raced.waited).toBe(true);
    expect(raced.late).toMatchObject({ kind: "decided", member: { state: "member", version: 2 } });
    expect(await members(at.resourceDomainId)).toEqual([
      expect.objectContaining({ state: "member", version: 2 }),
    ]);
  });

  it("keeps the highest of many concurrent decisions, whatever order they land in", async () => {
    const at = await pair();
    const decisions = Array.from({ length: 16 }, (_, index) => ({
      state: index % 2 === 0 ? ("revoked" as const) : ("member" as const),
      version: index + 1,
    })).toSorted(() => Math.random() - 0.5);
    const outcomes = await Promise.all(
      decisions.map((decision) => decide(at, decision.state, decision.version)),
    );
    expect(await members(at.resourceDomainId)).toEqual([
      expect.objectContaining({ state: "member", version: 16 }),
    ]);
    outcomes.forEach((outcome, index) => {
      const sent = decisions[index];
      if (outcome.kind === "decided") expect(outcome.member).toMatchObject({ ...sent });
      else if (outcome.kind === "stale")
        expect(outcome.current.version).toBeGreaterThan(sent?.version ?? 0);
      else throw new Error(`unexpected ${outcome.kind}`);
    });
  });

  it("answers a repeated grant or revoke with the row it wrote, and refuses an older or contrary one", async () => {
    const at = await pair();
    const granted = await decide(at, "member", 1);
    expect(granted).toMatchObject({ kind: "decided", member: { state: "member", version: 1 } });
    expect(await decide(at, "member", 1)).toEqual(granted);

    const revoked = await decide(at, "revoked", 2);
    expect(revoked).toMatchObject({ kind: "decided", member: { state: "revoked", version: 2 } });
    expect(await decide(at, "revoked", 2)).toEqual(revoked);
    if (revoked.kind !== "decided") throw new Error("the revoke was not written");

    // The first grant, delivered once more after the revoke, changes nothing.
    expect(await decide(at, "member", 1)).toEqual({ kind: "stale", current: revoked.member });
    // So does a grant that claims the revoke's own version.
    expect(await decide(at, "member", 2)).toEqual({ kind: "stale", current: revoked.member });
    expect(await members(at.resourceDomainId)).toEqual([revoked.member]);
  });

  it.each([1, 7])(
    "answers a person who does not exist as missing, at version %i",
    async (version) => {
      const at = await pair();
      expect(
        await decide({ ...at, userId: `user_nobody_${randomUUID()}` }, "member", version),
      ).toEqual({
        kind: "no-such-person",
      });
    },
  );

  it("answers a person deleted while their first decision is written as missing, not as a failure", async () => {
    const at = await pair();
    const outcome = await run(
      Effect.gen(function* () {
        const repo = yield* ResourceDomainRepo;
        const deleted = yield* Deferred.make<void>();
        const commit = yield* Deferred.make<void>();
        const removal = yield* Effect.forkChild(
          db.transaction(() =>
            deletePerson(at.userId).pipe(
              Effect.tap(() => Deferred.succeed(deleted, undefined)),
              Effect.tap(() => Deferred.await(commit)),
            ),
          ),
        );
        yield* Deferred.await(deleted);
        const decision = yield* Effect.forkChild(
          Effect.exit(repo.decideMember({ ...at, state: "member", version: 1 })),
        );
        yield* Effect.sleep("300 millis");
        const waited = decision.pollUnsafe() === undefined;
        yield* Deferred.succeed(commit, undefined);
        yield* Fiber.join(removal);
        return { waited, exit: yield* Fiber.join(decision) };
      }),
    );
    expect(outcome.waited).toBe(true);
    expect(outcome.exit).toEqual(Exit.succeed({ kind: "no-such-person" }));
  });

  it("answers a person deleted after their decisions as missing, whatever version comes next", async () => {
    const at = await pair();
    await decide(at, "member", 1);
    await Effect.runPromise(deletePerson(at.userId));
    expect(await decide(at, "revoked", 2)).toEqual({ kind: "no-such-person" });
    expect(await members(at.resourceDomainId)).toEqual([]);
  });

  it("reads one person's decision, and tells no decision from no such person", async () => {
    const at = await pair();
    const read = (userId: string) =>
      run(
        Effect.flatMap(ResourceDomainRepo, (repo) => repo.getMember(at.resourceDomainId, userId)),
      );
    expect(await read(at.userId)).toEqual({ kind: "no-decision" });
    const revoked = await decide(at, "revoked", 4);
    expect(await read(at.userId)).toEqual(
      revoked.kind === "decided" ? { kind: "found", member: revoked.member } : revoked,
    );
    expect(await read(`user_nobody_${randomUUID()}`)).toEqual({ kind: "no-such-person" });
  });

  it("pages every decision, revoked ones included, by user id", async () => {
    const { resourceDomainId } = await pair();
    const people = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const userId = `user_page_${index}_${randomUUID()}`;
        await Effect.runPromise(
          db.insert(user).values({ id: userId, name: "page", email: `${userId}@example.test` }),
        );
        await decide({ resourceDomainId, userId }, index % 2 === 0 ? "member" : "revoked", 1);
        return userId;
      }),
    );
    const pages: Array<{ readonly users: readonly string[]; readonly next?: string }> = [];
    let after: string | undefined;
    do {
      const page = await run(
        Effect.flatMap(ResourceDomainRepo, (repo) =>
          repo.listMembers({
            resourceDomainId,
            limit: 2,
            ...(after === undefined ? {} : { after }),
          }),
        ),
      );
      pages.push({
        users: page.members.map(({ userId }) => userId),
        ...(page.next === undefined ? {} : { next: page.next }),
      });
      after = page.next;
    } while (after !== undefined);
    expect(pages.map(({ users }) => users.length)).toEqual([2, 2, 1]);
    expect(pages.flatMap(({ users }) => users)).toEqual(people.toSorted());
    expect(pages.at(-1)?.next).toBeUndefined();
  });
});
