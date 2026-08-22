import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import { account, user } from "../schema.js";

/*
Identity rows (the better-auth `user` table). Two writers exist: better-auth on the web side, and
SERVICE PRINCIPALS through `POST /v1/users` — a product that owns its own login (Mend) provisions
one Sealant user per person and acts on their behalf. `ensureUser` is the idempotent upsert that
path rides on; it never touches sign-in rows. `hasAnySignInAccounts` checks `account` (credential
rows), not `user`: the seeded SDK owner (usr_local) and service-provisioned users have no
credentials and must not count as "this deployment is set up".
*/

const userRepoOperationSchema = Schema.Literals([
  "hasAnySignInAccounts",
  "ensureUser",
  "getUserById",
]);

export class UserRepoUnexpectedError extends Schema.TaggedErrorClass<UserRepoUnexpectedError>()(
  "UserRepoUnexpectedError",
  {
    operation: userRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type UserRepoError = UserRepoUnexpectedError;

type UserRepoOperation = typeof userRepoOperationSchema.Type;

const withUserRepoError = <A>(
  operation: UserRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, UserRepoError> => {
  return effect.pipe(
    Effect.mapError((cause) => {
      if (cause instanceof UserRepoUnexpectedError) {
        return cause;
      }

      return new UserRepoUnexpectedError({
        operation,
        message: cause instanceof Error ? cause.message : `${operation} failed.`,
        cause,
      });
    }),
  );
};

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface EnsureUserInput {
  /** Caller-chosen id for a NEW row; ignored when the email already exists. */
  readonly id?: string;
  readonly email: string;
  readonly name: string;
}

export interface EnsureUserResult {
  readonly user: UserRecord;
  /** True when this call inserted the row. */
  readonly created: boolean;
}

export interface UserRepoService {
  /**
   * True once any sign-in capable account exists (better-auth `account` row). Existence check
   * (LIMIT 1), not a count — this gates anonymous navigations.
   */
  readonly hasAnySignInAccounts: () => Effect.Effect<boolean, UserRepoError>;
  /** Idempotent on email: returns the existing row (name refreshed) or inserts one. */
  readonly ensureUser: (input: EnsureUserInput) => Effect.Effect<EnsureUserResult, UserRepoError>;
  readonly getUserById: (id: string) => Effect.Effect<UserRecord | undefined, UserRepoError>;
}

const toRecord = (row: {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: Date;
}): UserRecord => ({ id: row.id, email: row.email, name: row.name, createdAt: row.createdAt });

export class UserRepo extends Context.Service<UserRepo, UserRepoService>()("UserRepo") {}

export const UserRepoLive = Layer.effect(
  UserRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      ensureUser: (input) =>
        withUserRepoError(
          "ensureUser",
          Effect.gen(function* () {
            const email = input.email.trim().toLowerCase();
            const [existing] = yield* db
              .select({
                id: user.id,
                email: user.email,
                name: user.name,
                createdAt: user.createdAt,
              })
              .from(user)
              .where(eq(user.email, email))
              .limit(1);
            if (existing !== undefined) {
              if (existing.name !== input.name) {
                yield* db.update(user).set({ name: input.name }).where(eq(user.id, existing.id));
              }
              return { user: toRecord({ ...existing, name: input.name }), created: false };
            }
            const id = input.id ?? `usr_${crypto.randomUUID()}`;
            const [inserted] = yield* db
              .insert(user)
              .values({ id, email, name: input.name, emailVerified: true })
              .onConflictDoNothing({ target: user.email })
              .returning({
                id: user.id,
                email: user.email,
                name: user.name,
                createdAt: user.createdAt,
              });
            if (inserted !== undefined) {
              return { user: toRecord(inserted), created: true };
            }
            // Lost a race with a concurrent insert of the same email: read the winner.
            const [winner] = yield* db
              .select({
                id: user.id,
                email: user.email,
                name: user.name,
                createdAt: user.createdAt,
              })
              .from(user)
              .where(eq(user.email, email))
              .limit(1);
            if (winner === undefined) {
              return yield* Effect.fail(new Error(`User vanished after insert race: ${email}`));
            }
            return { user: toRecord(winner), created: false };
          }),
        ),
      getUserById: (id) =>
        withUserRepoError(
          "getUserById",
          Effect.gen(function* () {
            const [row] = yield* db
              .select({
                id: user.id,
                email: user.email,
                name: user.name,
                createdAt: user.createdAt,
              })
              .from(user)
              .where(eq(user.id, id))
              .limit(1);
            return row === undefined ? undefined : toRecord(row);
          }),
        ),
      hasAnySignInAccounts: () =>
        withUserRepoError(
          "hasAnySignInAccounts",
          Effect.gen(function* () {
            const [row] = yield* db.select({ id: account.id }).from(account).limit(1);

            return row !== undefined;
          }),
        ),
    } satisfies UserRepoService;
  }),
);
