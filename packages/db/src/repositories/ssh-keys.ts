import { and, desc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import { sshKeys, type NewSshKey, type SshKey } from "../schema.js";

/*
User SSH public keys (gateway client auth). The gateway resolves an offered key to its owner by
fingerprint; only active (archived_at IS NULL) keys authenticate. Deletion is a soft archive:
profile_ssh_key_bindings references ssh_keys.id without cascade, so hard deletes can fail.
*/

const sshKeyRepoOperationSchema = Schema.Literals([
  "createSshKey",
  "findActiveSshKeyByFingerprint",
  "getSshKeyByOwnerAndFingerprint",
  "listSshKeysByOwner",
  "archiveSshKey",
  "restoreSshKey",
]);

export class SshKeyRepoInvariantError extends Schema.TaggedErrorClass<SshKeyRepoInvariantError>()(
  "SshKeyRepoInvariantError",
  {
    operation: sshKeyRepoOperationSchema,
    message: Schema.String,
  },
) {}

export class SshKeyRepoUnexpectedError extends Schema.TaggedErrorClass<SshKeyRepoUnexpectedError>()(
  "SshKeyRepoUnexpectedError",
  {
    operation: sshKeyRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const sshKeyRepoErrorSchema = Schema.Union([
  SshKeyRepoInvariantError,
  SshKeyRepoUnexpectedError,
]);

export type SshKeyRepoError = typeof sshKeyRepoErrorSchema.Type;

type SshKeyRepoOperation = typeof sshKeyRepoOperationSchema.Type;

const mapSshKeyRepoError = (operation: SshKeyRepoOperation, cause: unknown): SshKeyRepoError => {
  if (cause instanceof SshKeyRepoInvariantError || cause instanceof SshKeyRepoUnexpectedError) {
    return cause;
  }

  return new SshKeyRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withSshKeyRepoError = <A>(
  operation: SshKeyRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, SshKeyRepoError> => {
  return effect.pipe(Effect.mapError((cause) => mapSshKeyRepoError(operation, cause)));
};

export interface CreateSshKeyInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  /** Canonical `<algorithm> <base64>` line (comment stripped). */
  readonly publicKey: string;
  /** OpenSSH-format fingerprint `SHA256:<unpadded base64>`. */
  readonly fingerprint: string;
}

export interface SshKeyRepoService {
  readonly createSshKey: (input: CreateSshKeyInput) => Effect.Effect<SshKey, SshKeyRepoError>;
  /**
   * The single active key matching a fingerprint — across ALL owners; this is the gateway's
   * key -> principal resolution. Uniqueness is enforced by ssh_keys_fingerprint_active_idx.
   */
  readonly findActiveSshKeyByFingerprint: (
    fingerprint: string,
  ) => Effect.Effect<SshKey | undefined, SshKeyRepoError>;
  readonly getSshKeyByOwnerAndFingerprint: (input: {
    readonly ownerUserId: string;
    readonly fingerprint: string;
  }) => Effect.Effect<SshKey | undefined, SshKeyRepoError>;
  /** Active keys for one owner, newest first. */
  readonly listSshKeysByOwner: (
    ownerUserId: string,
  ) => Effect.Effect<readonly SshKey[], SshKeyRepoError>;
  /** Soft delete; returns undefined when no active key matched (wrong id or wrong owner). */
  readonly archiveSshKey: (input: {
    readonly id: string;
    readonly ownerUserId: string;
  }) => Effect.Effect<SshKey | undefined, SshKeyRepoError>;
  /** Un-archive a previously removed key (same owner re-registering the same fingerprint). */
  readonly restoreSshKey: (input: {
    readonly id: string;
    readonly ownerUserId: string;
    readonly name: string;
  }) => Effect.Effect<SshKey | undefined, SshKeyRepoError>;
}

export class SshKeyRepo extends Context.Service<SshKeyRepo, SshKeyRepoService>()("SshKeyRepo") {}

export const SshKeyRepoLive = Layer.effect(
  SshKeyRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      createSshKey: (input) =>
        withSshKeyRepoError(
          "createSshKey",
          Effect.gen(function* () {
            const [sshKey] = yield* db
              .insert(sshKeys)
              .values({
                id: input.id,
                ownerUserId: input.ownerUserId,
                name: input.name,
                publicKey: input.publicKey,
                fingerprint: input.fingerprint,
              } satisfies NewSshKey)
              .returning();

            if (sshKey === undefined) {
              return yield* new SshKeyRepoInvariantError({
                operation: "createSshKey",
                message: `Failed to create SSH key for owner ${input.ownerUserId}.`,
              });
            }

            return sshKey;
          }),
        ),

      findActiveSshKeyByFingerprint: (fingerprint) =>
        withSshKeyRepoError(
          "findActiveSshKeyByFingerprint",
          Effect.gen(function* () {
            const [sshKey] = yield* db
              .select()
              .from(sshKeys)
              .where(and(eq(sshKeys.fingerprint, fingerprint), isNull(sshKeys.archivedAt)))
              .limit(1);

            return sshKey;
          }),
        ),

      getSshKeyByOwnerAndFingerprint: (input) =>
        withSshKeyRepoError(
          "getSshKeyByOwnerAndFingerprint",
          Effect.gen(function* () {
            const [sshKey] = yield* db
              .select()
              .from(sshKeys)
              .where(
                and(
                  eq(sshKeys.ownerUserId, input.ownerUserId),
                  eq(sshKeys.fingerprint, input.fingerprint),
                ),
              )
              .limit(1);

            return sshKey;
          }),
        ),

      listSshKeysByOwner: (ownerUserId) =>
        withSshKeyRepoError(
          "listSshKeysByOwner",
          db
            .select()
            .from(sshKeys)
            .where(and(eq(sshKeys.ownerUserId, ownerUserId), isNull(sshKeys.archivedAt)))
            .orderBy(desc(sshKeys.createdAt)),
        ),

      archiveSshKey: (input) =>
        withSshKeyRepoError(
          "archiveSshKey",
          Effect.gen(function* () {
            const [sshKey] = yield* db
              .update(sshKeys)
              .set({ archivedAt: new Date() })
              .where(
                and(
                  eq(sshKeys.id, input.id),
                  eq(sshKeys.ownerUserId, input.ownerUserId),
                  isNull(sshKeys.archivedAt),
                ),
              )
              .returning();

            return sshKey;
          }),
        ),

      restoreSshKey: (input) =>
        withSshKeyRepoError(
          "restoreSshKey",
          Effect.gen(function* () {
            const [sshKey] = yield* db
              .update(sshKeys)
              .set({ archivedAt: null, name: input.name })
              .where(and(eq(sshKeys.id, input.id), eq(sshKeys.ownerUserId, input.ownerUserId)))
              .returning();

            return sshKey;
          }),
        ),
    } satisfies SshKeyRepoService;
  }),
);
