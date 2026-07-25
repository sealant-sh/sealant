/**
 * AccessTokenRepo — data access for `access_tokens` (scoped bearer tokens for the session
 * surface). Only the SHA-256 hash of a secret is ever stored or looked up; the secret itself
 * exists only in the mint response. Mirrors the `RunRepo` idiom.
 */
import { desc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  accessTokens,
  type AccessToken,
  type AccessTokenScope,
  type NewAccessToken,
} from "../schema.js";

export interface CreateAccessTokenInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly tokenHash: string;
  readonly scopes: readonly AccessTokenScope[];
  readonly name?: string;
  readonly workspaceId?: string;
  readonly expiresAt?: Date;
}

const accessTokenRepoOperationSchema = Schema.Literals([
  "createToken",
  "getTokenByHash",
  "listTokens",
  "revokeToken",
]);

type AccessTokenRepoOperation = typeof accessTokenRepoOperationSchema.Type;

export class AccessTokenRepoInvariantError extends Schema.TaggedErrorClass<AccessTokenRepoInvariantError>()(
  "AccessTokenRepoInvariantError",
  {
    operation: accessTokenRepoOperationSchema,
    message: Schema.String,
  },
) {}

export class AccessTokenRepoUnexpectedError extends Schema.TaggedErrorClass<AccessTokenRepoUnexpectedError>()(
  "AccessTokenRepoUnexpectedError",
  {
    operation: accessTokenRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const accessTokenRepoErrorSchema = Schema.Union([
  AccessTokenRepoInvariantError,
  AccessTokenRepoUnexpectedError,
]);

export type AccessTokenRepoError = typeof accessTokenRepoErrorSchema.Type;

const withRepoError = <A>(
  operation: AccessTokenRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, AccessTokenRepoError> => {
  return effect.pipe(
    Effect.mapError((cause) => {
      if (
        cause instanceof AccessTokenRepoInvariantError ||
        cause instanceof AccessTokenRepoUnexpectedError
      ) {
        return cause;
      }
      return new AccessTokenRepoUnexpectedError({
        operation,
        message: cause instanceof Error ? cause.message : `${operation} failed.`,
        cause,
      });
    }),
  );
};

export interface AccessTokenRepoService {
  readonly createToken: (
    input: CreateAccessTokenInput,
  ) => Effect.Effect<AccessToken, AccessTokenRepoError>;
  readonly getTokenByHash: (
    tokenHash: string,
  ) => Effect.Effect<AccessToken | undefined, AccessTokenRepoError>;
  readonly listTokens: (
    ownerUserId: string,
  ) => Effect.Effect<readonly AccessToken[], AccessTokenRepoError>;
  readonly revokeToken: (id: string) => Effect.Effect<AccessToken | null, AccessTokenRepoError>;
}

export class AccessTokenRepo extends Context.Service<AccessTokenRepo, AccessTokenRepoService>()(
  "AccessTokenRepo",
) {}

export const AccessTokenRepoLive = Layer.effect(
  AccessTokenRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      createToken: (input) =>
        withRepoError(
          "createToken",
          Effect.gen(function* () {
            const [token] = yield* db
              .insert(accessTokens)
              .values({
                id: input.id,
                ownerUserId: input.ownerUserId,
                tokenHash: input.tokenHash,
                scopes: input.scopes,
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
                ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
              } satisfies NewAccessToken)
              .returning();

            if (token === undefined) {
              return yield* new AccessTokenRepoInvariantError({
                operation: "createToken",
                message: "Failed to create access token.",
              });
            }
            return token;
          }),
        ),

      getTokenByHash: (tokenHash) =>
        withRepoError(
          "getTokenByHash",
          Effect.gen(function* () {
            const [token] = yield* db
              .select()
              .from(accessTokens)
              .where(eq(accessTokens.tokenHash, tokenHash))
              .limit(1);
            return token;
          }),
        ),

      listTokens: (ownerUserId) =>
        withRepoError(
          "listTokens",
          Effect.gen(function* () {
            return yield* db
              .select()
              .from(accessTokens)
              .where(eq(accessTokens.ownerUserId, ownerUserId))
              .orderBy(desc(accessTokens.createdAt))
              .limit(200);
          }),
        ),

      revokeToken: (id) =>
        withRepoError(
          "revokeToken",
          Effect.gen(function* () {
            const [token] = yield* db
              .update(accessTokens)
              .set({ revokedAt: new Date() })
              .where(eq(accessTokens.id, id))
              .returning();
            return token ?? null;
          }),
        ),
    } satisfies AccessTokenRepoService;
  }),
);
