/**
 * The per-executor CA (workspace isolation architecture §7.3): one ECDSA P-256 certificate
 * authority per executor attempt, which the workspace's egress proxy signs the leaves of inspected
 * hosts with. The workspace trusts only the public certificate; the private key is kept sealed by
 * sealant for the executor's life and handed only to the proxy, the same key across proxy restarts
 * so a restarted proxy presents leaves the workspace already trusts.
 *
 * Node can sign but not mint certificates, so the certificate is assembled here in DER: a v3
 * self-signed CA (basic constraints CA with path length 0, key usage keyCertSign and cRLSign, a
 * subject key id), subject `CN=sealant executor CA <executor>, O=sealant`. The proxy (rcgen)
 * reads its subject, subject key id and public key back and checks the key matches.
 */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";

import { Redacted } from "effect";

/** Long enough for an executor kept retained or as a hot standby; never valid much past it. */
export const EXECUTOR_CA_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
/** Clock skew between the host that mints and the clients that verify. */
const NOT_BEFORE_SKEW_MS = 5 * 60 * 1000;

export interface ExecutorCa {
  /** The public certificate: the only part that reaches the workspace. */
  readonly certPem: string;
  /** PKCS#8 PEM of the private key: sealed at rest, handed only to the proxy, never logged. */
  readonly keyPem: Redacted.Redacted;
  readonly notAfter: Date;
}

// --- DER ---------------------------------------------------------------------------------------

const length = (size: number): Buffer => {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, value: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), length(value.length), value]);
const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const explicit = (tag: number, value: Buffer): Buffer => tlv(0xa0 | tag, value);
const octets = (value: Buffer): Buffer => tlv(0x04, value);
const utf8 = (value: string): Buffer => tlv(0x0c, Buffer.from(value, "utf8"));
const bool = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const bits = (value: Buffer, unused = 0): Buffer =>
  tlv(0x03, Buffer.concat([Buffer.from([unused]), value]));
/** A non-negative INTEGER from big-endian bytes (a leading zero keeps it positive). */
const integer = (value: Buffer): Buffer => {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  const first = trimmed[0] ?? 0;
  return tlv(0x02, first >= 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
};
const oid = (dotted: string): Buffer => {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const body: number[] = [first * 40 + second];
  for (const arc of rest) {
    const chunk: number[] = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) {
      chunk.unshift(0x80 | (value & 0x7f));
    }
    body.push(...chunk);
  }
  return tlv(0x06, Buffer.from(body));
};
/** UTCTime through 2049, GeneralizedTime after (RFC 5280 §4.1.2.5). */
const time = (at: Date): Buffer => {
  const iso = at.toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHMMSS
  return at.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii"))
    : tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
};

const ECDSA_WITH_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
  sequence(oid(id), ...(critical ? [bool(true)] : []), octets(value));

const pem = (label: string, der: Buffer): string =>
  `-----BEGIN ${label}-----\n${(der.toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----\n`;

/** The executor in the CA's common name, kept to what a name holds. */
const commonNameOf = (executor: string): string =>
  `sealant executor CA ${executor.replace(/[^A-Za-z0-9_.-]/g, "-")}`.slice(0, 64);

/** The `subjectPublicKey` bits of a DER SubjectPublicKeyInfo: its last element's content. */
const subjectPublicKeyBits = (spki: Buffer): Buffer => {
  // spki = SEQUENCE { AlgorithmIdentifier, BIT STRING }; a P-256 key's BIT STRING is 66 bytes,
  // so its header is 2 bytes, then the unused-bits byte, then the 65-byte point.
  const bitString = spki.subarray(spki.length - 68);
  if (bitString[0] !== 0x03 || bitString[1] !== 0x42) {
    throw new Error("unexpected P-256 SubjectPublicKeyInfo layout");
  }
  return bitString.subarray(3);
};

/**
 * Mint the CA for one executor attempt. `executor` is its name on the runtime (the workspace
 * container), put in the common name so a certificate can be told apart in a trust store.
 */
export const generateExecutorCa = (input: {
  readonly executor: string;
  readonly now?: Date;
  readonly validityMs?: number;
}): ExecutorCa => {
  const now = input.now ?? new Date();
  const notBefore = new Date(now.getTime() - NOT_BEFORE_SKEW_MS);
  const notAfter = new Date(now.getTime() + (input.validityMs ?? EXECUTOR_CA_VALIDITY_MS));
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const keyId = createHash("sha256").update(subjectPublicKeyBits(spki)).digest().subarray(0, 20);
  const name = sequence(
    set(sequence(oid("2.5.4.3"), utf8(commonNameOf(input.executor)))),
    set(sequence(oid("2.5.4.10"), utf8("sealant"))),
  );
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
    ECDSA_WITH_SHA256,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    spki,
    explicit(
      3,
      sequence(
        // CA, and it signs leaves only: no intermediate under it.
        extension("2.5.29.19", true, sequence(bool(true), integer(Buffer.from([0])))),
        // keyCertSign and cRLSign: bits 5 and 6, one unused bit.
        extension("2.5.29.15", true, bits(Buffer.from([0x06]), 1)),
        extension("2.5.29.14", false, octets(keyId)),
      ),
    ),
  );
  const signature = sign("sha256", tbs, privateKey);
  const certificate = sequence(tbs, ECDSA_WITH_SHA256, bits(signature));
  return {
    certPem: pem("CERTIFICATE", certificate),
    keyPem: Redacted.make(exportKey(privateKey)),
    notAfter,
  };
};

const exportKey = (key: KeyObject): string => {
  const exported = key.export({ type: "pkcs8", format: "pem" });
  return typeof exported === "string" ? exported : exported.toString("utf8");
};

/** Whether `keyPem` is the private key of `certPem` (a CA read back from storage). */
export const executorCaMatches = (certPem: string, keyPem: Redacted.Redacted): boolean => {
  try {
    return new X509Certificate(certPem).checkPrivateKey(createPrivateKey(Redacted.value(keyPem)));
  } catch {
    return false;
  }
};

/**
 * The variable the workspace reads the executor CA's public certificate from. Its network gate
 * writes the trust bundle (the image's own roots, then this CA) before the workload starts: the
 * image's roots are only readable inside it.
 */
export const EXECUTOR_CA_ENV = "SEALANT_EXECUTOR_CA_PEM";
