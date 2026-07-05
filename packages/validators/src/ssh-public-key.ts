import { createHash } from "node:crypto";

/*
Shared SSH public key normalization + fingerprinting.

This module is the single source of truth for how Sealant identifies an SSH public key:
- the API computes fingerprints at registration time (ssh_keys.fingerprint),
- the gateway recomputes them from the key a client offers at auth time,
- the dev seed registers the local dev key with the same format.

The fingerprint format is OpenSSH's: `SHA256:<base64(sha256(blob))>` with trailing `=` padding
stripped — byte-identical to what `ssh-keygen -lf` prints. Any drift here silently breaks gateway
auth, so both sides must import from this file (Node-only subpath export: it uses node:crypto).
*/

export const SSH_PUBLIC_KEY_ALGORITHMS = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
] as const;

export type SshPublicKeyAlgorithm = (typeof SSH_PUBLIC_KEY_ALGORITHMS)[number];

export interface ParsedSshPublicKey {
  readonly algorithm: SshPublicKeyAlgorithm;
  /** Canonical base64 of the decoded wire blob (re-encoded, so padding/whitespace variants converge). */
  readonly keyBase64: string;
  /** Decoded SSH wire-format blob. */
  readonly blob: Buffer;
  /** OpenSSH-format fingerprint: `SHA256:<unpadded base64>`. */
  readonly fingerprint: string;
  /** Canonical single-line form `<algorithm> <keyBase64>` — comment stripped. */
  readonly normalized: string;
  /** Trailing comment from the input line, if any (display metadata only). */
  readonly comment?: string;
}

export const computeSshPublicKeyFingerprint = (blob: Uint8Array): string => {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "")}`;
};

const isAllowedAlgorithm = (value: string): value is SshPublicKeyAlgorithm => {
  return (SSH_PUBLIC_KEY_ALGORITHMS as readonly string[]).includes(value);
};

/** Read the algorithm name embedded in the SSH wire blob (uint32 BE length + ASCII string). */
const readEmbeddedAlgorithm = (blob: Buffer): string | undefined => {
  if (blob.length < 4) {
    return undefined;
  }

  const nameLength = blob.readUInt32BE(0);

  // Algorithm identifiers are short ASCII tokens; a huge/overrunning length means garbage input.
  if (nameLength === 0 || nameLength > 64 || 4 + nameLength > blob.length) {
    return undefined;
  }

  return blob.subarray(4, 4 + nameLength).toString("ascii");
};

/**
 * Parse and canonicalize one `<algorithm> <base64> [comment...]` public key line.
 * Throws on anything structurally invalid — callers map that to their own error shape.
 */
export const parseSshPublicKey = (line: string): ParsedSshPublicKey => {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    throw new Error("SSH public key is empty.");
  }

  const parts = trimmed.split(/\s+/u);
  const [algorithm, encoded] = parts;
  const comment = parts.slice(2).join(" ").trim();

  if (algorithm === undefined || encoded === undefined) {
    throw new Error("SSH public key must be in '<algorithm> <base64> [comment]' form.");
  }

  if (!isAllowedAlgorithm(algorithm)) {
    throw new Error(`Unsupported SSH public key algorithm '${algorithm}'.`);
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error("SSH public key payload is not valid base64.");
  }

  const blob = Buffer.from(encoded, "base64");

  // Structural check: the wire blob embeds its own algorithm name; a mismatch means the base64
  // does not actually encode a key of the declared type.
  if (readEmbeddedAlgorithm(blob) !== algorithm) {
    throw new Error("SSH public key payload does not match its declared algorithm.");
  }

  const keyBase64 = blob.toString("base64");

  return {
    algorithm,
    keyBase64,
    blob,
    fingerprint: computeSshPublicKeyFingerprint(blob),
    normalized: `${algorithm} ${keyBase64}`,
    ...(comment.length > 0 ? { comment } : {}),
  };
};
