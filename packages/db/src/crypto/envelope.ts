/**
 * AES-256-GCM envelope encryption for stored credentials — `node:crypto` only, no dependency.
 *
 * Layout per value: a fresh 32-byte DEK encrypts the plaintext (GCM, with the caller's `aad` bound in
 * so a stolen ciphertext can't be replayed under another row); the DEK is then wrapped by the
 * `KeyProvider` (the master key). The whole thing serializes to one self-describing JSON string stored
 * in `principal_credential_versions.envelope`. `kekId` records which master key wrapped the DEK so a
 * master-key rotation is a background re-wrap, not a re-encrypt of every value.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { KeyProvider, WrappedKey } from "./key-provider.js";

const VALUE_IV_BYTES = 12;
const ENVELOPE_VERSION = 1 as const;

interface Envelope {
  /** Format version, for forward-compatible changes. */
  readonly v: typeof ENVELOPE_VERSION;
  /** Which master key wrapped the DEK (`KeyProvider.id`). */
  readonly kekId: string;
  /** Value ciphertext + GCM nonce/tag (base64). */
  readonly valCt: string;
  readonly valIv: string;
  readonly valTag: string;
  /** The DEK, wrapped by the master key. */
  readonly key: WrappedKey;
}

/** SHA-256 of a value as lowercase hex — for integrity checks / idempotent re-writes, not reversible. */
export const valueSha256 = (plaintext: string | Buffer): string =>
  createHash("sha256").update(plaintext).digest("hex");

/**
 * Encrypt `plaintext` into a self-contained envelope string. `aad` (additional authenticated data,
 * e.g. `"<ownerUserId>:<credentialId>"`) is authenticated but not stored — the decrypter must supply
 * the same value, binding the ciphertext to its owning row.
 */
export const encryptEnvelope = (
  plaintext: string | Buffer,
  aad: string,
  keyProvider: KeyProvider,
): string => {
  const dek = randomBytes(32);
  const iv = randomBytes(VALUE_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([
    cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext),
    cipher.final(),
  ]);
  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    kekId: keyProvider.id,
    valCt: ct.toString("base64"),
    valIv: iv.toString("base64"),
    valTag: cipher.getAuthTag().toString("base64"),
    key: keyProvider.wrapDek(dek),
  };
  return JSON.stringify(envelope);
};

/**
 * Decrypt an envelope produced by {@link encryptEnvelope}, returning the plaintext bytes. The same
 * `aad` and a `keyProvider` whose `id` matches the envelope's `kekId` are required; any mismatch or
 * tampering throws (GCM authentication failure or a key-id mismatch).
 */
export const decryptEnvelope = (
  envelopeJson: string,
  aad: string,
  keyProvider: KeyProvider,
): Buffer => {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(envelopeJson) as Envelope;
  } catch {
    throw new Error("credential envelope is not valid JSON");
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`unsupported credential envelope version ${String(envelope.v)}`);
  }
  if (envelope.kekId !== keyProvider.id) {
    // The value was wrapped by a different master key than the one provided (rotation, or a
    // misconfigured SEALANT_SECRETS_KEY). Fail loudly rather than emit garbage.
    throw new Error(
      `credential envelope was wrapped by key "${envelope.kekId}" but provider is "${keyProvider.id}"`,
    );
  }
  const dek = keyProvider.unwrapDek(envelope.key);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    dek,
    Buffer.from(envelope.valIv, "base64"),
  );
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.valTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.valCt, "base64")),
    decipher.final(),
  ]);
};

/** Decrypt and decode as UTF-8 text (the common case for token/JSON credential payloads). */
export const decryptEnvelopeText = (
  envelopeJson: string,
  aad: string,
  keyProvider: KeyProvider,
): string => decryptEnvelope(envelopeJson, aad, keyProvider).toString("utf8");
