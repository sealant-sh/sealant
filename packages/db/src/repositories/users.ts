import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import { account } from "../schema.js";

/*
Better-auth identity rows. Deliberately minimal: the control plane only needs an existence check to
drive the web app's first-run setup wizard. The check is on `account` (credential rows), not
`user`: the seeded SDK owner (usr_local) is a `user` row with no credentials and must not count as
"this deployment is set up". User CRUD stays owned by better-auth on the web side.
*/

const userRepoOperationSchema = Schema.Literals(["hasAnySignInAccounts"]);

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

export interface UserRepoService {
  /**
   * True once any sign-in capable account exists (better-auth `account` row). Existence check
   * (LIMIT 1), not a count — this gates anonymous navigations.
   */
  readonly hasAnySignInAccounts: () => Effect.Effect<boolean, UserRepoError>;
}

export class UserRepo extends Context.Service<UserRepo, UserRepoService>()("UserRepo") {}

export const UserRepoLive = Layer.effect(
  UserRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
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
