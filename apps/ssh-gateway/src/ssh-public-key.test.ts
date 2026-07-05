import { describe, expect, it } from "vitest";

import {
  computeSshPublicKeyFingerprint,
  parseSshPublicKey,
} from "@sealant/validators/ssh-public-key";

/*
The fingerprint format is the load-bearing contract between key registration (API) and gateway
auth-time resolution: both must byte-match `ssh-keygen -lf`. The expected values below were
produced with ssh-keygen against these exact key lines — they pin the format forever.
*/

const ED25519_LINE =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPj6P2ZZ6BFLdyJqInR2abOeBR3vEYa/2ZY/MVDOO+zQ dev@example";
const ED25519_FINGERPRINT = "SHA256:dqhtI+YHK+V+on+W0rzONwHjBjZBtb06dEiZY4lox2c";

const RSA_LINE =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC9B/Ltc54JsYk9JQzNZiUf/ZaBuBGOVC6Il6h2YeMOhA2GLcFGYzru05Wqd3hFTftc8lJvNSdJhe15dJSCi5+8/bI7ilsVFL58kUoGtZRVa9lzSFMRfu06rOWKtjmKjoQqDjXEowkzprFWTsX+0BrXmW0E3RpVp9GyOxJ6FkmjtyE3XyP+uwkZGTbwFE/yIVYFLXqNx+4YQ4MgX0OON44dtEOs7hVfd2SOCGHD83MI+XO+9DOv/YfVBx5Q2V7fL8RAzb3JVrsRD86Cg52vCxH6jr72VeoqtHDxBIK864QY0TOuQOFr4n9CIj/3i44cHqCbaRfn1jzZl3dq6P394OfT";
const RSA_FINGERPRINT = "SHA256:zjxKsmQStotjsFOfB8UEN1YmIPEbtbfqwi+UXO3nEIE";

describe("parseSshPublicKey", () => {
  it("matches ssh-keygen -lf fingerprints for ed25519", () => {
    const parsed = parseSshPublicKey(ED25519_LINE);

    expect(parsed.algorithm).toBe("ssh-ed25519");
    expect(parsed.fingerprint).toBe(ED25519_FINGERPRINT);
    expect(parsed.comment).toBe("dev@example");
    expect(parsed.normalized).toBe(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPj6P2ZZ6BFLdyJqInR2abOeBR3vEYa/2ZY/MVDOO+zQ",
    );
  });

  it("matches ssh-keygen -lf fingerprints for rsa (no comment)", () => {
    const parsed = parseSshPublicKey(RSA_LINE);

    expect(parsed.algorithm).toBe("ssh-rsa");
    expect(parsed.fingerprint).toBe(RSA_FINGERPRINT);
    expect(parsed.comment).toBeUndefined();
  });

  it("canonicalizes surrounding whitespace and multi-word comments", () => {
    const parsed = parseSshPublicKey(`  ${ED25519_LINE.replace("dev@example", "my laptop key")}\n`);

    expect(parsed.fingerprint).toBe(ED25519_FINGERPRINT);
    expect(parsed.comment).toBe("my laptop key");
  });

  it("rejects an unsupported algorithm", () => {
    expect(() => parseSshPublicKey("ssh-dss AAAA dev@example")).toThrow(/Unsupported/u);
  });

  it("rejects a blob whose embedded algorithm mismatches the declared one", () => {
    const [, blob] = ED25519_LINE.split(" ");
    expect(() => parseSshPublicKey(`ssh-rsa ${blob}`)).toThrow(/does not match/u);
  });

  it("rejects garbage payloads", () => {
    expect(() => parseSshPublicKey("ssh-ed25519 !!!not-base64!!!")).toThrow(/base64/u);
    expect(() => parseSshPublicKey("ssh-ed25519")).toThrow();
    expect(() => parseSshPublicKey("")).toThrow(/empty/u);
  });

  it("computes fingerprints without base64 padding", () => {
    const parsed = parseSshPublicKey(ED25519_LINE);
    const recomputed = computeSshPublicKeyFingerprint(parsed.blob);

    expect(recomputed).toBe(parsed.fingerprint);
    expect(recomputed.endsWith("=")).toBe(false);
  });
});
