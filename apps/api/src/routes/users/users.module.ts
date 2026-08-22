/**
 * Users route handlers — the service-principal provisioning path (see the contract's header).
 * Reads are unscoped by design: a caller that reached this surface holds a service key (or the
 * deployment is open), and the row carries no secret material.
 */
import {
  UserBadRequestError,
  UserInternalServerError,
  UserNotFoundError,
  type EnsureUserRequest,
  type EnsureUserResponse,
  type UserWire,
} from "@sealant/api-contracts";
import { UserRepo, type UserRecord } from "@sealant/db";
import { Effect } from "effect";

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
