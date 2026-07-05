import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { Context, Effect, Layer, Schema } from "effect";

/*
Encryption at rest for connected-account credentials (design doc §4). AES-256-GCM via
node:crypto; the 32-byte key comes from SEALANT_CREDENTIALS_KEY (base64), generated once per
install. Sealed format: `v1.<keyId>.<iv b64url>.<authTag b64url>.<ciphertext b64url>` — the
version prefix + persisted `encryption_key_id` leave room for key rotation.
*/

export const SEALED_CREDENTIAL_VERSION = "v1";

const credentialCipherOperationSchema = Schema.Literals(["configure", "encrypt", "decrypt"]);

export type CredentialCipherOperation = typeof credentialCipherOperationSchema.Type;

export class CredentialCipherError extends Schema.TaggedErrorClass<CredentialCipherError>()(
  "CredentialCipherError",
  {
    operation: credentialCipherOperationSchema,
    message: Schema.String,
  },
) {}

export interface CredentialCipherOptions {
  /** Base64 encoding of exactly 32 random bytes (SEALANT_CREDENTIALS_KEY). */
  readonly key: string;
  /** Persisted alongside sealed payloads as `encryption_key_id`; defaults to "k1". */
  readonly keyId?: string;
}

export interface SealedCredential {
  readonly sealed: string;
  readonly keyId: string;
}

export interface CredentialCipherService {
  readonly encrypt: (plaintext: string) => Effect.Effect<SealedCredential, CredentialCipherError>;
  readonly decrypt: (sealed: string) => Effect.Effect<string, CredentialCipherError>;
}

export class CredentialCipher extends Context.Service<CredentialCipher, CredentialCipherService>()(
  "@sealant/credentials/CredentialCipher",
) {}

export class CredentialCipherConfig extends Context.Service<
  CredentialCipherConfig,
  CredentialCipherOptions
>()("@sealant/credentials/CredentialCipherConfig") {}

/** Hex SHA-256 digest of a payload string — the `payload_sha256` change-detection column. */
export const sha256Hex = (value: string): string => {
  return createHash("sha256").update(value, "utf8").digest("hex");
};

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

const defaultKeyId = "k1";
const ivByteLength = 12;
const authTagByteLength = 16;

const mapCredentialCipherError = (
  operation: CredentialCipherOperation,
  cause: unknown,
): CredentialCipherError => {
  if (cause instanceof CredentialCipherError) {
    return cause;
  }

  // Effect.try wraps thrown errors; surface a CredentialCipherError thrown inside the thunk.
  if (cause instanceof Error && cause.cause instanceof CredentialCipherError) {
    return cause.cause;
  }

  return new CredentialCipherError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
  });
};

const withCredentialCipherError = <A>(
  operation: CredentialCipherOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, CredentialCipherError> => {
  return effect.pipe(Effect.mapError((cause) => mapCredentialCipherError(operation, cause)));
};

interface ParsedSealedCredential {
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly ciphertext: Buffer;
}

const parseSealedCredential = (sealed: string, expectedKeyId: string): ParsedSealedCredential => {
  const segments = sealed.split(".");
  const [version, keyId, ivSegment, authTagSegment, ciphertextSegment] = segments;

  if (
    segments.length !== 5 ||
    version === undefined ||
    keyId === undefined ||
    ivSegment === undefined ||
    authTagSegment === undefined ||
    ciphertextSegment === undefined ||
    ciphertextSegment.length === 0
  ) {
    throw new CredentialCipherError({
      operation: "decrypt",
      message:
        "Sealed credential must have the format v1.<keyId>.<iv>.<authTag>.<ciphertext> (base64url segments).",
    });
  }

  if (version !== SEALED_CREDENTIAL_VERSION) {
    throw new CredentialCipherError({
      operation: "decrypt",
      message: `Unsupported sealed credential version "${version}" (expected "${SEALED_CREDENTIAL_VERSION}").`,
    });
  }

  if (keyId !== expectedKeyId) {
    throw new CredentialCipherError({
      operation: "decrypt",
      message: `Sealed credential key id "${keyId}" does not match the configured key id "${expectedKeyId}".`,
    });
  }

  const iv = Buffer.from(ivSegment, "base64url");
  const authTag = Buffer.from(authTagSegment, "base64url");

  if (iv.byteLength !== ivByteLength || authTag.byteLength !== authTagByteLength) {
    throw new CredentialCipherError({
      operation: "decrypt",
      message: "Sealed credential IV or auth tag has an invalid length.",
    });
  }

  return { iv, authTag, ciphertext: Buffer.from(ciphertextSegment, "base64url") };
};

const makeCredentialCipher = (key: Buffer, keyId: string): CredentialCipherService => {
  return {
    encrypt: (plaintext) =>
      withCredentialCipherError(
        "encrypt",
        Effect.try(() => {
          const iv = randomBytes(ivByteLength);
          const cipher = createCipheriv("aes-256-gcm", key, iv);
          const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
          const authTag = cipher.getAuthTag();
          const sealed = [
            SEALED_CREDENTIAL_VERSION,
            keyId,
            iv.toString("base64url"),
            authTag.toString("base64url"),
            ciphertext.toString("base64url"),
          ].join(".");

          return { sealed, keyId };
        }),
      ),

    decrypt: (sealed) =>
      withCredentialCipherError(
        "decrypt",
        Effect.try(() => {
          const parsed = parseSealedCredential(sealed, keyId);
          const decipher = createDecipheriv("aes-256-gcm", key, parsed.iv);

          decipher.setAuthTag(parsed.authTag);

          try {
            return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString(
              "utf8",
            );
          } catch {
            // GCM authentication failed. The keyId matched but the actual key bytes did not (or the
            // ciphertext was tampered). The most common cause in a self-host is SEALANT_CREDENTIALS_KEY
            // differing between the process that sealed this (the API) and this one (the worker).
            throw new CredentialCipherError({
              operation: "decrypt",
              message:
                "Failed to authenticate the sealed credential. The SEALANT_CREDENTIALS_KEY used to decrypt does not match the one it was encrypted with (verify the API and worker share the same key), or the stored value was corrupted.",
            });
          }
        }),
      ),
  };
};

export const CredentialCipherLive = Layer.effect(
  CredentialCipher,
  Effect.gen(function* () {
    const options = yield* CredentialCipherConfig;
    const key = Buffer.from(options.key, "base64");

    if (key.byteLength !== 32) {
      return yield* new CredentialCipherError({
        operation: "configure",
        message: "Credential cipher key must be base64 that decodes to exactly 32 bytes.",
      });
    }

    return makeCredentialCipher(key, options.keyId ?? defaultKeyId);
  }),
);

export const credentialCipherLayer = (options: CredentialCipherOptions) => {
  const configLayer = Layer.succeed(CredentialCipherConfig, options);

  return CredentialCipherLive.pipe(Layer.provide(configLayer));
};
