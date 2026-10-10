/**
 * `POST /v1/users/:userId/person` (Mend ADR 0016): what may be bound (an owner-map id, a uid in the
 * people's range, a normalised home under the homes root), and how a binding that would change one
 * already made is refused: 409 with a stable code, naming no other user's values.
 */
import {
  UserBadRequestError,
  UserNotFoundError,
  UserPersonConflictError,
} from "@sealant/api-contracts";
import { UserRepo, type BindPersonResult, type UserRepoService } from "@sealant/db";
import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import { bindUserPerson, personBindingProblem } from "./users.module.js";

const ALICE = { id: "acct_alice", uid: 40001, home: "/home/m4lice000" };

const repoAnswering = (answer: BindPersonResult, exists = true) => {
  const binds: Array<string> = [];
  const repo: UserRepoService = {
    hasAnySignInAccounts: () => Effect.die("unused"),
    ensureUser: () => Effect.die("unused"),
    getUserById: (id) =>
      Effect.succeed(
        exists ? { id, email: `${id}@example.test`, name: id, createdAt: new Date() } : undefined,
      ),
    bindPerson: (userId, person) =>
      Effect.sync(() => {
        binds.push(`${userId}:${person.personId}:${String(person.uid)}`);
        return answer;
      }),
    getPersonBinding: () => Effect.die("unused"),
  };
  return { binds, layer: Layer.succeed(UserRepo, repo) };
};

const bind = (layer: Layer.Layer<UserRepo>, person = ALICE) =>
  Effect.runPromise(bindUserPerson("usr_alice", person).pipe(Effect.result, Effect.provide(layer)));

describe("what a person binding may name", () => {
  it("takes an owner-map id, a uid in 40001–49999 and a normalised home under the root", () => {
    expect(personBindingProblem(ALICE, "/home")).toBeUndefined();
    for (const uid of [0, 40000, 50000, 1000, 40001.5]) {
      expect(personBindingProblem({ ...ALICE, uid }, "/home"), String(uid)).toBeDefined();
    }
    for (const home of [
      "home/m4lice000",
      "/home",
      "/home/",
      "/home/m4lice000/",
      "/home/../root",
      "/home/./m4lice000",
      "/root/m4lice000",
      "/homeother/m4lice000",
    ]) {
      expect(personBindingProblem({ ...ALICE, home }, "/home"), home).toBeDefined();
    }
    for (const id of ["", ".hidden", "-dash", "a/b", "x".repeat(129)]) {
      expect(personBindingProblem({ ...ALICE, id }, "/home"), id).toBeDefined();
    }
  });
});

describe("POST /v1/users/:userId/person", () => {
  it("binds, and answers the same binding again as made before", async () => {
    for (const created of [true, false]) {
      const { layer } = repoAnswering({ kind: "bound", created });
      const result = await bind(layer);
      expect(Result.isSuccess(result) && result.success).toEqual({
        userId: "usr_alice",
        person: ALICE,
        created,
      });
    }
  });

  it("refuses another person for a bound user, and a person id or uid another user holds (409)", async () => {
    const cases: ReadonlyArray<readonly [BindPersonResult, string]> = [
      [{ kind: "differs" }, "person-binding-differs"],
      [{ kind: "taken", by: "uid" }, "person-taken"],
      [{ kind: "taken", by: "person-id" }, "person-taken"],
    ];
    for (const [answer, code] of cases) {
      const { layer } = repoAnswering(answer);
      const result = await bind(layer);
      const failure = Result.isFailure(result) ? result.failure : undefined;
      expect(failure).toBeInstanceOf(UserPersonConflictError);
      expect(failure instanceof UserPersonConflictError && failure.code).toBe(code);
      expect(failure instanceof UserPersonConflictError && failure.message).not.toContain("/home");
    }
  });

  it("writes nothing for a refused name or an unknown user", async () => {
    const refused = repoAnswering({ kind: "bound", created: true });
    const bad = await bind(refused.layer, { ...ALICE, uid: 0 });
    expect(Result.isFailure(bad) && bad.failure).toBeInstanceOf(UserBadRequestError);
    const unknown = repoAnswering({ kind: "bound", created: true }, false);
    const missing = await bind(unknown.layer);
    expect(Result.isFailure(missing) && missing.failure).toBeInstanceOf(UserNotFoundError);
    expect([...refused.binds, ...unknown.binds]).toEqual([]);
  });
});
