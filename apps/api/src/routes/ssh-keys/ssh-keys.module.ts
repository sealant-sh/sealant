import { randomUUID, timingSafeEqual } from "node:crypto";

import {
  SshKeyBadRequestError,
  SshKeyConflictError,
  SshKeyInternalServerError,
  SshKeyNotFoundError,
  SshKeyServiceUnavailableError,
  SshKeyUnauthorizedError,
  type CreateSshKeyRequest,
  type ListSshKeysResponse,
  type ResolveSshPrincipalRequest,
  type ResolveSshPrincipalResponse,
  type SshKeyGatewayHeaders,
  type SshKeySummary,
} from "@sealant/api-contracts";
import { SshKeyRepo, type SshKey } from "@sealant/db";
import {
  computeSshPublicKeyFingerprint,
  parseSshPublicKey,
} from "@sealant/validators/ssh-public-key";
import { Effect } from "effect";

import { env } from "../../runtime-env.js";

/*
User SSH public keys. Registration/list/archive serve the web tRPC proxy (owner injected by the
web server — same trust model as createSandbox). `resolveSshPrincipal` is the gateway's key ->
principal lookup at SSH auth time, gated by the shared gateway token like getSandboxSshTarget.
*/

const toErrorMessage = (error: unknown, fallback: string): string => {
  return error instanceof Error ? error.message : fallback;
};

const withInternalError = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: string) => {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new SshKeyInternalServerError({
          message: toErrorMessage(error, fallback),
        }),
    ),
  );
};

/** Constant-time shared-token comparison; length mismatch still returns false. */
const gatewayTokenMatches = (provided: string | undefined, expected: string): boolean => {
  if (provided === undefined) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
};

const requireGatewayToken = (headers: SshKeyGatewayHeaders) => {
  return Effect.gen(function* () {
    const expectedGatewayToken = env.SANDBOX_SSH_GATEWAY_TOKEN?.trim();

    if (expectedGatewayToken === undefined || expectedGatewayToken.length === 0) {
      return yield* new SshKeyServiceUnavailableError({
        message: "Sandbox SSH gateway token is not configured.",
      });
    }

    if (!gatewayTokenMatches(headers["x-sealant-gateway-token"], expectedGatewayToken)) {
      return yield* new SshKeyUnauthorizedError({
        message: "Invalid sandbox SSH gateway token.",
      });
    }
  });
};

const toSshKeySummary = (sshKey: SshKey): SshKeySummary => {
  // publicKey is stored canonically as "<algorithm> <base64>"; the first token is the algorithm.
  const algorithm = sshKey.publicKey.split(" ")[0] ?? "unknown";

  return {
    sshKeyId: sshKey.id,
    ownerUserId: sshKey.ownerUserId,
    name: sshKey.name,
    algorithm,
    fingerprint: sshKey.fingerprint,
    createdAt: sshKey.createdAt.toISOString(),
  };
};

export const createSshKey = (input: { readonly payload: CreateSshKeyRequest }) => {
  return Effect.gen(function* () {
    const parseResult = Effect.try({
      try: () => parseSshPublicKey(input.payload.publicKey),
      catch: (error) =>
        new SshKeyBadRequestError({
          message: toErrorMessage(error, "SSH public key is invalid."),
        }),
    });
    const parsed = yield* parseResult;

    const sshKeyRepo = yield* SshKeyRepo;

    // Idempotent per owner: re-registering the same key returns the existing row (the dev
    // seed/setup path re-runs); an archived row is resurrected so the fingerprint can be reused.
    const existing = yield* withInternalError(
      sshKeyRepo.getSshKeyByOwnerAndFingerprint({
        ownerUserId: input.payload.ownerUserId,
        fingerprint: parsed.fingerprint,
      }),
      "Failed to look up SSH key.",
    );

    if (existing !== undefined && existing.archivedAt === null) {
      return toSshKeySummary(existing);
    }

    // Active fingerprints are globally unique (ssh_keys_fingerprint_active_idx): the gateway
    // resolves key -> owner by fingerprint alone, so another owner's active key must block this.
    const activeElsewhere = yield* withInternalError(
      sshKeyRepo.findActiveSshKeyByFingerprint(parsed.fingerprint),
      "Failed to look up SSH key.",
    );

    if (activeElsewhere !== undefined) {
      return yield* new SshKeyConflictError({
        message: "This SSH key is already registered to another account.",
      });
    }

    const name =
      input.payload.name?.trim() ??
      parsed.comment ??
      `${parsed.algorithm} ${parsed.fingerprint.slice("SHA256:".length, "SHA256:".length + 8)}`;

    if (existing !== undefined) {
      // Archived under the same owner: the per-owner unique index blocks a fresh insert, so
      // resurrect the existing row in place instead.
      const restored = yield* withInternalError(
        sshKeyRepo.restoreSshKey({ id: existing.id, ownerUserId: input.payload.ownerUserId, name }),
        "Failed to restore SSH key.",
      );

      if (restored === undefined) {
        return yield* new SshKeyInternalServerError({
          message: "Failed to restore SSH key.",
        });
      }

      return toSshKeySummary(restored);
    }

    const created = yield* sshKeyRepo
      .createSshKey({
        id: `sshk_${randomUUID()}`,
        ownerUserId: input.payload.ownerUserId,
        name,
        publicKey: parsed.normalized,
        fingerprint: parsed.fingerprint,
      })
      .pipe(
        Effect.mapError((error) => {
          // Owner FK failure means the user id does not exist.
          if (error.message.includes("violates foreign key constraint")) {
            return new SshKeyNotFoundError({
              message: `Owner user not found: ${input.payload.ownerUserId}`,
            });
          }

          if (error.message.includes("duplicate key value")) {
            return new SshKeyConflictError({
              message: "This SSH key is already registered.",
            });
          }

          return new SshKeyInternalServerError({
            message: toErrorMessage(error, "Failed to create SSH key."),
          });
        }),
      );

    return toSshKeySummary(created);
  });
};

export const listSshKeys = (input: { readonly ownerUserId: string }) => {
  return Effect.gen(function* () {
    const sshKeyRepo = yield* SshKeyRepo;

    const items = yield* withInternalError(
      sshKeyRepo.listSshKeysByOwner(input.ownerUserId),
      "Failed to list SSH keys.",
    );

    return { items: items.map(toSshKeySummary) } satisfies ListSshKeysResponse;
  });
};

export const archiveSshKey = (input: {
  readonly sshKeyId: string;
  readonly ownerUserId: string;
}) => {
  return Effect.gen(function* () {
    const sshKeyRepo = yield* SshKeyRepo;

    const archived = yield* withInternalError(
      sshKeyRepo.archiveSshKey({ id: input.sshKeyId, ownerUserId: input.ownerUserId }),
      "Failed to remove SSH key.",
    );

    if (archived === undefined) {
      return yield* new SshKeyNotFoundError({
        message: `SSH key not found: ${input.sshKeyId}`,
      });
    }

    return toSshKeySummary(archived);
  });
};

export const resolveSshPrincipal = (input: {
  readonly payload: ResolveSshPrincipalRequest;
  readonly headers: SshKeyGatewayHeaders;
}) => {
  return Effect.gen(function* () {
    yield* requireGatewayToken(input.headers);

    // The fingerprint is recomputed server-side from the offered key blob — callers never supply
    // one, so a compromised gateway cannot probe arbitrary fingerprints it does not hold keys for.
    const blob = Buffer.from(input.payload.publicKeyBase64, "base64");

    if (blob.length === 0) {
      return yield* new SshKeyNotFoundError({
        message: "No SSH key matches the offered public key.",
      });
    }

    const fingerprint = computeSshPublicKeyFingerprint(blob);

    const sshKeyRepo = yield* SshKeyRepo;
    const sshKey = yield* withInternalError(
      sshKeyRepo.findActiveSshKeyByFingerprint(fingerprint),
      "Failed to resolve SSH key principal.",
    );

    // Uniform 404 for unknown keys — nothing here is enumerable beyond "a key I hold is known".
    if (sshKey === undefined) {
      return yield* new SshKeyNotFoundError({
        message: "No SSH key matches the offered public key.",
      });
    }

    return {
      principalId: sshKey.ownerUserId,
      sshKeyId: sshKey.id,
      fingerprint: sshKey.fingerprint,
    } satisfies ResolveSshPrincipalResponse;
  });
};
