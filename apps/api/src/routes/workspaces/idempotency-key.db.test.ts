/**
 * The workspace idempotency key against real Postgres: unique per owner (another owner may use
 * the same key), found by owner and key, and a racing insert fails in a way the create path
 * recognises as a unique violation (SQLSTATE 23505) so it answers with the winner's workspace.
 * Gated on SEALANT_TEST_DATABASE_URL (a disposable, migrated database).
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  SealantDB,
  user,
  WorkspaceRepo,
  WorkspaceRepoLive,
  type DB,
} from "@sealant/db";
import { Effect, Layer, Result } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { isUniqueConstraintError } from "./workspaces.module.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

describe.skipIf(DATABASE_URL === undefined)("workspace idempotency key (Postgres)", () => {
  let db: DB;
  const owner = `user_idem_${randomUUID()}`;
  const other = `user_idem_${randomUUID()}`;

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    for (const id of [owner, other]) {
      await Effect.runPromise(
        db.insert(user).values({ id, name: "idem", email: `${id}@example.test` }),
      );
    }
  });

  const run = <A, E>(effect: Effect.Effect<A, E, WorkspaceRepo>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(WorkspaceRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db)))),
      ),
    );

  it("is unique per owner, found by owner and key, and a racing insert reads as a unique violation", async () => {
    const key = `key_${randomUUID()}`;
    const create = (ownerUserId: string) =>
      Effect.gen(function* () {
        return yield* (yield* WorkspaceRepo).createWorkspace({
          id: randomUUID(),
          name: "idem",
          ownerUserId,
          idempotencyKey: key,
        });
      });

    const first = await run(create(owner));
    const second = await run(Effect.result(create(owner)));
    expect(Result.isFailure(second)).toBe(true);
    if (Result.isFailure(second)) {
      expect(isUniqueConstraintError(second.failure)).toBe(true);
    }
    // Another owner's workspace with the same key is its own.
    const others = await run(create(other));
    expect(others.id).not.toBe(first.id);

    const found = await run(
      Effect.gen(function* () {
        return yield* (yield* WorkspaceRepo).getWorkspaceByIdempotencyKey({
          ownerUserId: owner,
          idempotencyKey: key,
        });
      }),
    );
    expect(found?.id).toBe(first.id);
  });
});
