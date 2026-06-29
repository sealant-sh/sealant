import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decryptEnvelopeText, encryptEnvelope, valueSha256 } from "./envelope.js";
import { EnvKeyProvider, makeEnvKeyProvider } from "./key-provider.js";

const kp = new EnvKeyProvider(randomBytes(32));
const AAD = "usr_alice:pcred_123";

describe("envelope encryption", () => {
  it("round-trips a value under the matching aad + key", () => {
    const secret = JSON.stringify({ accessToken: "sk-ant-oat01-abc", refreshToken: "r" });
    const env = encryptEnvelope(secret, AAD, kp);
    expect(env).not.toContain("sk-ant-oat01-abc"); // ciphertext, not plaintext
    expect(decryptEnvelopeText(env, AAD, kp)).toBe(secret);
  });

  it("produces a fresh nonce/ciphertext each call (no deterministic leak)", () => {
    const a = encryptEnvelope("same", AAD, kp);
    const b = encryptEnvelope("same", AAD, kp);
    expect(a).not.toBe(b);
    expect(decryptEnvelopeText(a, AAD, kp)).toBe("same");
    expect(decryptEnvelopeText(b, AAD, kp)).toBe("same");
  });

  it("fails authentication under a different aad (ciphertext bound to its row)", () => {
    const env = encryptEnvelope("v", AAD, kp);
    expect(() => decryptEnvelopeText(env, "usr_mallory:pcred_999", kp)).toThrow();
  });

  it("fails under a different master key", () => {
    const env = encryptEnvelope("v", AAD, kp);
    const other = new EnvKeyProvider(randomBytes(32));
    expect(() => decryptEnvelopeText(env, AAD, other)).toThrow(/wrapped by key/);
  });

  it("rejects tampered ciphertext", () => {
    const env = JSON.parse(encryptEnvelope("v", AAD, kp)) as { valCt: string };
    env.valCt = Buffer.from("tampered").toString("base64");
    expect(() => decryptEnvelopeText(JSON.stringify(env), AAD, kp)).toThrow();
  });
});

describe("EnvKeyProvider", () => {
  it("derives a stable, key-dependent id and never exposes the key", () => {
    const key = randomBytes(32);
    expect(new EnvKeyProvider(key).id).toBe(new EnvKeyProvider(key).id);
    expect(new EnvKeyProvider(randomBytes(32)).id).not.toBe(new EnvKeyProvider(key).id);
    expect(new EnvKeyProvider(key).id).toMatch(/^env:[0-9a-f]{12}$/);
  });

  it("rejects a wrong-length key", () => {
    expect(() => new EnvKeyProvider(randomBytes(16))).toThrow(/32 bytes/);
  });

  it("makeEnvKeyProvider requires the env value", () => {
    expect(() => makeEnvKeyProvider(undefined)).toThrow(/SEALANT_SECRETS_KEY/);
    expect(() => makeEnvKeyProvider("")).toThrow(/SEALANT_SECRETS_KEY/);
    const b64 = randomBytes(32).toString("base64");
    expect(makeEnvKeyProvider(b64).id).toMatch(/^env:/);
  });
});

describe("valueSha256", () => {
  it("is stable and hex", () => {
    expect(valueSha256("x")).toBe(valueSha256(Buffer.from("x")));
    expect(valueSha256("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
