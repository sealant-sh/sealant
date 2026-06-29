/**
 * Master-key abstraction for the credential store's envelope encryption.
 *
 * The store uses two-tier (envelope) encryption: a fresh per-version Data Encryption Key (DEK)
 * encrypts the credential value, and a `KeyProvider` wraps that DEK with the master key (the KEK). The
 * provider is the only thing that ever touches the master key, so swapping `EnvKeyProvider` (self-host)
 * for a future `KmsKeyProvider` (hosted) needs no schema or call-site change — the wrapped DEK and
 * `kekId` are stored per version, so rotation is a re-wrap, never a re-encrypt of values.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** A DEK wrapped by the master key — all fields base64. Stored inside the envelope (see `envelope.ts`). */
export interface WrappedKey {
  readonly wrappedDek: string;
  readonly iv: string;
  readonly tag: string;
}

export interface KeyProvider {
  /** Stable id of the master key, stamped onto every version as `kekId` so rotation is detectable. */
  readonly id: string;
  /** Wrap (encrypt) a 32-byte DEK with the master key. */
  wrapDek(dek: Buffer): WrappedKey;
  /** Unwrap (decrypt) a previously wrapped DEK. Throws if the ciphertext/tag fail authentication. */
  unwrapDek(wrapped: WrappedKey): Buffer;
}

const MASTER_KEY_BYTES = 32;
const WRAP_IV_BYTES = 12;

/**
 * Self-host master-key provider: AES-256-GCM wrap/unwrap under a single 32-byte key supplied out of
 * band (e.g. `SEALANT_SECRETS_KEY`). The `id` is derived from a hash of the key so a key swap is
 * visible in stored `kekId`s without ever logging the key itself.
 */
export class EnvKeyProvider implements KeyProvider {
  public readonly id: string;
  readonly #key: Buffer;

  public constructor(masterKey: Buffer) {
    if (masterKey.length !== MASTER_KEY_BYTES) {
      throw new Error(
        `master key must be exactly ${MASTER_KEY_BYTES} bytes, got ${masterKey.length}`,
      );
    }
    this.#key = masterKey;
    this.id = `env:${createHash("sha256").update(masterKey).digest("hex").slice(0, 12)}`;
  }

  public wrapDek(dek: Buffer): WrappedKey {
    const iv = randomBytes(WRAP_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const wrappedDek = Buffer.concat([cipher.update(dek), cipher.final()]);
    return {
      wrappedDek: wrappedDek.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  public unwrapDek(wrapped: WrappedKey): Buffer {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(wrapped.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(wrapped.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(wrapped.wrappedDek, "base64")),
      decipher.final(),
    ]);
  }
}

/**
 * Build an `EnvKeyProvider` from a base64-encoded 32-byte master key (the `SEALANT_SECRETS_KEY` shape).
 * Throws a clear error if the value is absent or not exactly 32 bytes once decoded.
 */
export const makeEnvKeyProvider = (masterKeyBase64: string | undefined): EnvKeyProvider => {
  if (masterKeyBase64 === undefined || masterKeyBase64.trim().length === 0) {
    throw new Error(
      "SEALANT_SECRETS_KEY is required to use the credential store (base64 of 32 random bytes).",
    );
  }
  return new EnvKeyProvider(Buffer.from(masterKeyBase64.trim(), "base64"));
};
