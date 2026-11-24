import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { inspect } from "node:util";

import { Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { EXECUTOR_CA_VALIDITY_MS, executorCaMatches, generateExecutorCa } from "./executor-ca.js";

describe("the per-executor CA", () => {
  const now = new Date("2026-11-24T00:00:00Z");
  const ca = generateExecutorCa({ executor: "sealant-run_123", now });
  const cert = new X509Certificate(ca.certPem);

  it("is a self-signed CA over a P-256 key that signs only leaves", () => {
    expect(cert.ca).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(cert.subject).toContain("CN=sealant executor CA sealant-run_123");
  });

  it("names the executor and is valid from just before it was minted for the executor's life", () => {
    expect(new Date(cert.validFrom).getTime()).toBeLessThan(now.getTime());
    expect(new Date(cert.validTo).getTime()).toBe(
      Math.floor((now.getTime() + EXECUTOR_CA_VALIDITY_MS) / 1000) * 1000,
    );
    expect(ca.notAfter.getTime()).toBe(now.getTime() + EXECUTOR_CA_VALIDITY_MS);
  });

  it("hands over a PKCS#8 key that is the certificate's, and never prints it", () => {
    const key = createPrivateKey(Redacted.value(ca.keyPem));
    expect(Redacted.value(ca.keyPem)).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(cert.checkPrivateKey(key)).toBe(true);
    expect(createPublicKey(key).export({ format: "jwk" })).toEqual(
      cert.publicKey.export({ format: "jwk" }),
    );
    expect(inspect(ca.keyPem)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(ca)).not.toContain("PRIVATE KEY");
  });

  it("is new for every executor attempt", () => {
    const other = generateExecutorCa({ executor: "sealant-run_123", now });
    expect(other.certPem).not.toBe(ca.certPem);
    expect(executorCaMatches(ca.certPem, other.keyPem)).toBe(false);
    expect(executorCaMatches(ca.certPem, ca.keyPem)).toBe(true);
  });
});
