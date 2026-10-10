/**
 * A user's person binding against real Postgres (Mend ADR 0016): bound once, the same values again
 * answer as they did, another person for the same user is refused and nothing is overwritten, and a
 * person id or uid belongs to at most one user (unique indexes), so whoever binds first owns it.
 * Gated on SEALANT_TEST_DATABASE_URL (a disposable, migrated database).
 */
import { randomInt, randomUUID } from "node:crypto";

import { createSealantDB, SealantDB, user, UserRepo, UserRepoLive, type DB } from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

describe.skipIf(DATABASE_URL === undefined)("person binding (Postgres)", () => {
  let db: DB;
  const alice = `user_person_${randomUUID()}`;
  const bob = `user_person_${randomUUID()}`;
  // Unique to this run: the indexes span every test that shares the database.
  const base = 40001 + randomInt(0, 9000);
  const ALICE = { personId: `acct_a_${randomUUID()}`, uid: base, home: "/home/malice0000" };
  const BOB = { personId: `acct_b_${randomUUID()}`, uid: base + 1, home: "/home/mbob000000" };

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    for (const id of [alice, bob]) {
      await Effect.runPromise(
        db.insert(user).values({ id, name: "person", email: `${id}@example.test` }),
      );
    }
  });

  const run = <A, E>(effect: Effect.Effect<A, E, UserRepo>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(UserRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db))))),
    );
  const bind = (userId: string, person: typeof ALICE) =>
    run(Effect.flatMap(UserRepo, (users) => users.bindPerson(userId, person)));
  const read = (userId: string) =>
    run(Effect.flatMap(UserRepo, (users) => users.getPersonBinding(userId)));

  it("binds once, answers the same values again, and never overwrites", async () => {
    expect(await bind(alice, ALICE)).toEqual({ kind: "bound", created: true });
    expect(await bind(alice, ALICE)).toEqual({ kind: "bound", created: false });
    expect(await bind(alice, { ...ALICE, home: "/home/other00000" })).toEqual({ kind: "differs" });
    expect(await bind(alice, BOB)).toEqual({ kind: "differs" });
    expect(await read(alice)).toEqual(ALICE);
  });

  it("gives a person id and a uid to one user only: Bob cannot take Alice's", async () => {
    expect(await bind(bob, { ...BOB, uid: ALICE.uid })).toEqual({ kind: "taken", by: "uid" });
    expect(await bind(bob, { ...BOB, personId: ALICE.personId })).toEqual({
      kind: "taken",
      by: "person-id",
    });
    expect(await read(bob)).toBeUndefined();
    expect(await bind(bob, BOB)).toEqual({ kind: "bound", created: true });
    expect(await read(alice)).toEqual(ALICE);
  });
});
