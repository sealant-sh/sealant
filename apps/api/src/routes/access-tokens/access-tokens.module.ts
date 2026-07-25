/**
 * Access-token route handlers — mint, list, revoke scoped bearer tokens for the session surface.
 * The secret (`slt_<random>`) is generated here, returned once, and only its SHA-256 hex is
 * stored. Minting rides the pre-auth owner model like every other endpoint; the enforcement value
 * is downstream (a read-stream token can stream but can neither send input nor exec).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  AccessTokenInternalServerError,
  AccessTokenNotFoundError,
  type AccessTokenWire,
  type CreateAccessTokenRequest,
  type ListAccessTokensResponse,
} from "@sealant/api-contracts";
import { AccessTokenRepo, type AccessToken } from "@sealant/db";
import { Effect } from "effect";

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const withInternalError = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: string) =>
  effect.pipe(
    Effect.mapError(
      (error) => new AccessTokenInternalServerError({ message: toErrorMessage(error, fallback) }),
    ),
  );

const mapToken = (token: AccessToken): AccessTokenWire => ({
  tokenId: token.id,
  ownerUserId: token.ownerUserId,
  ...(token.name === null ? {} : { name: token.name }),
  scopes: [...token.scopes],
  ...(token.workspaceId === null ? {} : { workspaceId: token.workspaceId }),
  ...(token.expiresAt === null ? {} : { expiresAt: token.expiresAt.toISOString() }),
  ...(token.revokedAt === null ? {} : { revokedAt: token.revokedAt.toISOString() }),
  createdAt: token.createdAt.toISOString(),
});

export const createAccessToken = (payload: CreateAccessTokenRequest) =>
  Effect.gen(function* () {
    const tokens = yield* AccessTokenRepo;
    const secret = `slt_${randomBytes(32).toString("base64url")}`;
    const tokenHash = createHash("sha256").update(secret).digest("hex");

    const token = yield* withInternalError(
      tokens.createToken({
        id: `tok_${randomUUID()}`,
        ownerUserId: payload.ownerUserId,
        tokenHash,
        scopes: [...new Set(payload.scopes)],
        ...(payload.name === undefined ? {} : { name: payload.name }),
        ...(payload.workspaceId === undefined ? {} : { workspaceId: payload.workspaceId }),
        ...(payload.ttlSeconds === undefined
          ? {}
          : { expiresAt: new Date(Date.now() + payload.ttlSeconds * 1000) }),
      }),
      "Failed to create access token.",
    );

    return { ...mapToken(token), token: secret };
  });

export const listAccessTokens = (ownerUserId: string) =>
  Effect.gen(function* () {
    const tokens = yield* AccessTokenRepo;
    const items = yield* withInternalError(
      tokens.listTokens(ownerUserId),
      "Failed to list access tokens.",
    );
    return { items: items.map(mapToken) } satisfies ListAccessTokensResponse;
  });

export const revokeAccessToken = (input: {
  readonly tokenId: string;
  readonly ownerUserId: string;
}) =>
  Effect.gen(function* () {
    const tokens = yield* AccessTokenRepo;
    // Owner-scoped like everything else: look the token up via the owner's list, uniform 404.
    const items = yield* withInternalError(
      tokens.listTokens(input.ownerUserId),
      "Failed to load access tokens.",
    );
    const target = items.find((token) => token.id === input.tokenId);
    if (target === undefined) {
      return yield* new AccessTokenNotFoundError({
        message: `Access token not found: ${input.tokenId}`,
      });
    }
    const revoked = yield* withInternalError(
      tokens.revokeToken(target.id),
      "Failed to revoke access token.",
    );
    if (revoked === null) {
      return yield* new AccessTokenNotFoundError({
        message: `Access token not found: ${input.tokenId}`,
      });
    }
    return mapToken(revoked);
  });
