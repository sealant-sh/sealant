/**
 * Users route handlers — the service-principal provisioning path (see the contract's header).
 * Reads are unscoped by design: a caller that reached this surface holds a service key (or the
 * deployment is open), and the row carries no secret material.
 */
import { posix } from "node:path";

import {
  CAPTURE_OWNER_MAP_ID_PATTERN,
  CAPTURE_OWNER_MAP_UID_RANGE,
  UserBadRequestError,
  UserInternalServerError,
  UserNotFoundError,
  UserPersonConflictError,
  type BindUserPersonResponse,
  type EnsureUserRequest,
  type EnsureUserResponse,
  type PersonBindingWire,
  type UserWire,
} from "@sealant/api-contracts";
import { UserRepo, type UserRecord } from "@sealant/db";
import { Effect } from "effect";

import { env } from "../../runtime-env.js";

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const withInternalError = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: string) =>
  effect.pipe(
    Effect.mapError(
      (error) => new UserInternalServerError({ message: toErrorMessage(error, fallback) }),
    ),
  );

const mapUser = (user: UserRecord): UserWire => ({
  userId: user.id,
  email: user.email,
  name: user.name,
  createdAt: user.createdAt.toISOString(),
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

export const ensureUser = (payload: EnsureUserRequest) =>
  Effect.gen(function* () {
    if (!EMAIL_PATTERN.test(payload.email)) {
      return yield* new UserBadRequestError({ message: "email must be an address." });
    }
    if (payload.userId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(payload.userId)) {
      return yield* new UserBadRequestError({
        message: "userId may only contain letters, digits, '_' and '-' (max 128).",
      });
    }
    const users = yield* UserRepo;
    const result = yield* withInternalError(
      users.ensureUser({
        email: payload.email,
        name: payload.name,
        ...(payload.userId === undefined ? {} : { id: payload.userId }),
      }),
      "Failed to ensure user.",
    );
    return { ...mapUser(result.user), created: result.created } satisfies EnsureUserResponse;
  });

export const getUser = (userId: string) =>
  Effect.gen(function* () {
    const users = yield* UserRepo;
    const user = yield* withInternalError(users.getUserById(userId), "Failed to load user.");
    if (user === undefined) {
      return yield* new UserNotFoundError({ message: `User not found: ${userId}` });
    }
    return mapUser(user);
  });

/**
 * Why a person binding is refused before anything is written: an id that cannot name an owner-map
 * person, a uid outside the people's range (never 0, never the `mend` group), or a home that is not
 * an absolute normalised path under the homes root. Undefined when it may be bound.
 */
export const personBindingProblem = (
  person: PersonBindingWire,
  homesRoot: string = env.SEALANT_PERSON_HOMES_ROOT,
): string | undefined => {
  if (!CAPTURE_OWNER_MAP_ID_PATTERN.test(person.id)) {
    return "person id must be one owner-map id: letters, digits, '.', '_' or '-' (at most 128), not starting with '.' or '-'.";
  }
  const { first, last } = CAPTURE_OWNER_MAP_UID_RANGE;
  if (!Number.isInteger(person.uid) || person.uid < first || person.uid > last) {
    return `person uid must be in ${String(first)}–${String(last)} (never root, never the mend group).`;
  }
  const home = person.home;
  const prefix = homesRoot === "/" ? "/" : `${homesRoot}/`;
  if (
    !home.startsWith("/") ||
    posix.normalize(home) !== home ||
    home.endsWith("/") ||
    home.split("/").includes("..") ||
    !home.startsWith(prefix) ||
    home.length <= prefix.length
  ) {
    return `person home must be an absolute, normalised path under ${homesRoot}.`;
  }
  return undefined;
};

/**
 * `POST /v1/users/:userId/person`: binds the user to a person once (Mend ADR 0016). The same values
 * again answer as they did; another person for this user, or this person id or uid for another
 * user, is refused (409) and nothing is overwritten. There is no rebind through the API: an
 * operator who must change one deletes the user's `user_person_binding` row (an audited change in
 * the database) before binding again.
 */
export const bindUserPerson = (userId: string, person: PersonBindingWire) =>
  Effect.gen(function* () {
    const problem = personBindingProblem(person);
    if (problem !== undefined) {
      return yield* new UserBadRequestError({ message: problem });
    }
    const users = yield* UserRepo;
    const user = yield* withInternalError(users.getUserById(userId), "Failed to load user.");
    if (user === undefined) {
      return yield* new UserNotFoundError({ message: `User not found: ${userId}` });
    }
    const result = yield* withInternalError(
      users.bindPerson(userId, { personId: person.id, uid: person.uid, home: person.home }),
      "Failed to bind the user's person.",
    );
    if (result.kind === "differs") {
      return yield* new UserPersonConflictError({
        code: "person-binding-differs",
        message: `User ${userId} is bound to another person, and a binding is never changed through the API. An operator clears it (the user's user_person_binding row) before it is bound again.`,
      });
    }
    if (result.kind === "taken") {
      return yield* new UserPersonConflictError({
        code: "person-taken",
        message: `That person ${result.by === "uid" ? "uid" : "id"} is bound to another user.`,
      });
    }
    if (result.created) {
      // The audit line: who is bound to which person, never anyone's home.
      yield* Effect.logInfo("users: person bound").pipe(
        Effect.annotateLogs({ userId, personId: person.id, uid: person.uid }),
      );
    }
    return { userId, person, created: result.created } satisfies BindUserPersonResponse;
  });
