#!/usr/bin/env node
// The bind exchange of the Boat host mode: `sudo -n node boat-bind.mjs '<json>'`, run by Core over
// Boat exec once per boot, in place of the Python guest's `guest_boot.py bind`. The wire is the
// same (`sealant-bootstrap-v1` in, `sealant-bootstrap-reply-v1` out) so Core's
// `execution.exchange` parses the reply unchanged: the bearer it decrypts is the one the agent
// arms itself with (`boat-host.mjs`), and it is both the launch secret and the control token.
//
// Rules, as the Python guest had them: the request must name THIS boot and THIS image's manifest
// digest; the same exchange again on the same boot re-encrypts the SAME bearer (Core may retry);
// a different operation or key on the same boot is refused; a new boot binds afresh, but only for
// the identity the disk was first bound to. The bearer is written to tmpfs only (`arm.json`,
// 0600); the disk gets a public record (`bind.json`) and never the bearer.
//
// A refusal is one reason code on stderr and a non-zero exit; stdout then holds nothing.
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

import {
  ARM_RECORD_FORMAT,
  BIND_RECORD_FORMAT,
  IDENTITY_KEYS,
  NAME_PATTERN,
  UUID_PATTERN,
  boatPaths,
  isIdentity,
  parkedOnBoot,
  readBootId,
  readRecord,
  sameJson,
  sha256,
  writeAtomic,
} from "./boat-host.mjs";

const REQUEST_FORMAT = "sealant-bootstrap-v1";
const REPLY_FORMAT = "sealant-bootstrap-reply-v1";
const REQUEST_KEYS = [
  "format",
  "identity",
  "boot_id",
  "manifest_digest",
  "operation_id",
  "public_key",
];

class Refusal extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const refuse = (reason) => {
  throw new Refusal(reason);
};

const parseRequest = (argv) => {
  const raw = argv[2];
  if (argv.length !== 3 || typeof raw !== "string" || raw.length > 8192) {
    refuse("bind-invalid-request");
  }
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    refuse("bind-invalid-request");
  }
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request) ||
    Object.keys(request).length !== REQUEST_KEYS.length ||
    !REQUEST_KEYS.every((key) => Object.hasOwn(request, key)) ||
    request.format !== REQUEST_FORMAT ||
    !isIdentity(request.identity) ||
    typeof request.boot_id !== "string" ||
    !UUID_PATTERN.test(request.boot_id) ||
    typeof request.manifest_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.manifest_digest) ||
    typeof request.operation_id !== "string" ||
    !NAME_PATTERN.test(request.operation_id) ||
    typeof request.public_key !== "string" ||
    request.public_key.length > 4096
  ) {
    refuse("bind-invalid-request");
  }
  return request;
};

/** The bearer under RSA-OAEP (SHA-256) with the exchange as the label, as bootstrap-crypto.mjs. */
const encrypt = (request, key, bearer) => {
  const label = Buffer.from(
    JSON.stringify([
      request.format,
      request.identity.deployment_id,
      request.identity.instance_id,
      request.identity.disk_lineage,
      request.boot_id,
      request.operation_id,
      request.manifest_digest,
    ]),
  );
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: label },
    Buffer.from(bearer),
  ).toString("base64");
};

const main = async () => {
  const paths = boatPaths();
  const request = parseRequest(process.argv);
  let bootId;
  try {
    bootId = readBootId(paths.bootIdFile);
  } catch {
    refuse("bind-state-unknown");
  }
  if (request.boot_id !== bootId) refuse("bind-stale-boot");
  const manifest = readRecord(paths.manifestFile);
  if (manifest.kind !== "ok" || manifest.value.digest !== request.manifest_digest) {
    refuse("bind-manifest-mismatch");
  }
  let key;
  try {
    key = createPublicKey(request.public_key);
    if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 3072) {
      refuse("bind-invalid-public-key");
    }
    // The key must take the exchange before any state is written.
    encrypt(request, key, "0".repeat(64));
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse("bind-invalid-public-key");
  }
  const publicKeySha256 = sha256(request.public_key);

  const existing = readRecord(paths.bindFile);
  if (existing.kind === "unreadable") refuse("bind-state-unknown");
  let bearer = null;
  if (existing.kind === "ok") {
    const record = existing.value;
    if (record.format !== BIND_RECORD_FORMAT || !isIdentity(record.identity)) {
      refuse("bind-state-unknown");
    }
    // A disk is bound to one VM identity. The exception is a parked one: its workspace was closed
    // on the earlier boot before Boat saved it, and the VM restored from that snapshot is a new
    // instance of the same deployment, bound once on its own boot.
    if (
      !sameJson(record.identity, request.identity) &&
      (record.boot_id === bootId ||
        record.identity.deployment_id !== request.identity.deployment_id ||
        !parkedOnBoot(paths, record.boot_id))
    ) {
      refuse("bind-identity-conflict");
    }
    if (record.boot_id === bootId) {
      // Same boot: the same exchange, or none.
      if (
        record.operation_id !== request.operation_id ||
        record.public_key_sha256 !== publicKeySha256
      ) {
        refuse("bind-exchange-conflict");
      }
      const arm = readRecord(paths.armFile);
      if (
        arm.kind !== "ok" ||
        arm.value.format !== ARM_RECORD_FORMAT ||
        arm.value.boot_id !== bootId ||
        typeof arm.value.bearer !== "string" ||
        !/^[a-f0-9]{64}$/.test(arm.value.bearer)
      ) {
        refuse("bind-state-unknown");
      }
      bearer = arm.value.bearer;
    }
    // Another boot's bind of the same identity is replaced: a new boot is a fresh bind.
  }
  if (bearer === null) {
    bearer = randomBytes(32).toString("hex");
    // The bearer first (tmpfs, private), then the record that says it is there.
    await writeAtomic(
      paths.armFile,
      `${JSON.stringify({ format: ARM_RECORD_FORMAT, boot_id: bootId, bearer })}\n`,
      0o600,
    );
    const identity = Object.fromEntries(
      IDENTITY_KEYS.map((name) => [name, request.identity[name]]),
    );
    await writeAtomic(
      paths.bindFile,
      `${JSON.stringify({
        format: BIND_RECORD_FORMAT,
        boot_id: bootId,
        identity,
        operation_id: request.operation_id,
        public_key_sha256: publicKeySha256,
        // Only a digest: after a reboot the bearer is gone from tmpfs, and this lets the agent
        // recognise the earlier boot's bearer to refuse its recovery as a new boot.
        bearer_sha256: sha256(bearer),
      })}\n`,
      0o644,
    );
  }
  const reply = {
    admission: "held",
    boot: { status: "compatible" },
    boot_id: bootId,
    ciphertext: encrypt(request, key, bearer),
    format: REPLY_FORMAT,
    identity: Object.fromEntries(IDENTITY_KEYS.map((name) => [name, request.identity[name]])),
    operation_id: request.operation_id,
  };
  process.stdout.write(`${JSON.stringify(reply)}\n`);
};

main().catch((error) => {
  // One reason code and nothing else leaves: no path, no exception text, never the bearer.
  process.stderr.write(`${error instanceof Refusal ? error.reason : "bind-state-unknown"}\n`);
  process.exitCode = 2;
});
