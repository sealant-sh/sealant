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
import { Deferred, Effect, Fiber } from "effect";
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
    expectedVersion: number,
  ) =>
    run(
      Effect.flatMap(ResourceDomainRepo, (repo) =>
        repo.decideMember({ ...at, state, expectedVersion }),
      ),
    );

  const members = (resourceDomainId: string) =>
    run(Effect.flatMap(ResourceDomainRepo, (repo) => repo.listMembers(resourceDomainId)));

  it.each([0, 1])(
    "a grant from version %i waits out a revoke from that version, then cannot undo it",
    async (from) => {
      const at = await pair();
      if (from === 1) await decide(at, "member", 0);
      const raced = await run(
        Effect.gen(function* () {
          const repo = yield* ResourceDomainRepo;
          const written = yield* Deferred.make<void>();
          const commit = yield* Deferred.make<void>();
          // The revoke's transaction has written its row and holds it, uncommitted.
          const revoke = yield* Effect.forkChild(
            db.transaction(() =>
              repo.decideMember({ ...at, state: "revoked", expectedVersion: from }).pipe(
                Effect.tap(() => Deferred.succeed(written, undefined)),
                Effect.tap(() => Deferred.await(commit)),
              ),
            ),
          );
          yield* Deferred.await(written);
          const grant = yield* Effect.forkChild(
            repo.decideMember({ ...at, state: "member", expectedVersion: from }),
          );
          yield* Effect.sleep("300 millis");
          const grantWaited = grant.pollUnsafe() === undefined;
          yield* Deferred.succeed(commit, undefined);
          return {
            grantWaited,
            revoke: yield* Fiber.join(revoke),
            grant: yield* Fiber.join(grant),
          };
        }),
      );
      expect(raced.grantWaited).toBe(true);
      expect(raced.revoke).toMatchObject({
        kind: "decided",
        member: { state: "revoked", version: from + 1 },
      });
      expect(raced.grant).toEqual({ kind: "version-moved" });
      expect(await members(at.resourceDomainId)).toEqual([
        expect.objectContaining({ userId: at.userId, state: "revoked", version: from + 1 }),
      ]);
    },
  );

  it("writes one of many concurrent decisions from one version, and refuses the rest", async () => {
    const at = await pair();
    await decide(at, "member", 0);
    const outcomes = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        decide(at, index % 2 === 0 ? "revoked" : "member", 1),
      ),
    );
    const [current] = await members(at.resourceDomainId);
    expect(current?.version).toBe(2);
    for (const outcome of outcomes) {
      if (outcome.kind === "decided") expect(outcome.member).toEqual(current);
      else expect(outcome).toEqual({ kind: "version-moved" });
    }
    expect(outcomes.filter(({ kind }) => kind === "version-moved")).toHaveLength(8);
  });

  it("answers a repeated grant or revoke with the row it wrote, and keeps a revoked row", async () => {
    const at = await pair();
    const granted = await decide(at, "member", 0);
    expect(granted).toMatchObject({ kind: "decided", member: { state: "member", version: 1 } });
    expect(await decide(at, "member", 0)).toEqual(granted);

    const revoked = await decide(at, "revoked", 1);
    expect(revoked).toMatchObject({ kind: "decided", member: { state: "revoked", version: 2 } });
    expect(await decide(at, "revoked", 1)).toEqual(revoked);
    // The first grant, delivered once more after the revoke, changes nothing.
    expect(await decide(at, "member", 0)).toEqual({ kind: "version-moved" });

    expect(await members(at.resourceDomainId)).toEqual(
      revoked.kind === "decided" ? [revoked.member] : [],
    );
  });

  it("refuses a version that is not the member's, behind or ahead, and a person who does not exist", async () => {
    const at = await pair();
    expect(await decide(at, "member", 1)).toEqual({ kind: "version-moved" });
    await decide(at, "member", 0);
    await decide(at, "revoked", 1);
    expect(await decide(at, "member", 1)).toEqual({ kind: "version-moved" });
    expect(await decide(at, "member", 5)).toEqual({ kind: "version-moved" });
    expect(await members(at.resourceDomainId)).toEqual([
      expect.objectContaining({ state: "revoked", version: 2 }),
    ]);
    expect(await decide({ ...at, userId: `user_nobody_${randomUUID()}` }, "member", 0)).toEqual({
      kind: "no-such-person",
    });
  });
});
