import { randomBytes } from "node:crypto";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  CredentialCipher,
  CredentialCipherError,
  credentialCipherLayer,
  sha256Hex,
  type CredentialCipherOptions,
  type CredentialCipherService,
} from "./cipher.js";

const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");

const withCipher = <A, E>(
  options: CredentialCipherOptions,
  use: (cipher: CredentialCipherService) => Effect.Effect<A, E>,
): Promise<A> => {
  return Effect.runPromise(
    Effect.gen(function* () {
      const cipher = yield* CredentialCipher;

      return yield* use(cipher);
    }).pipe(Effect.provide(credentialCipherLayer(options))),
  );
};

const flipLastCharacter = (value: string): string => {
  const last = value.at(-1);
  const replacement = last === "A" ? "B" : "A";

  return `${value.slice(0, -1)}${replacement}`;
};

describe("CredentialCipher", () => {
  it("round-trips plaintext through encrypt/decrypt", async () => {
    const plaintext = JSON.stringify({ token: "sk-ant-oat01-example" });
    const result = await withCipher({ key: keyA }, (cipher) =>
      Effect.gen(function* () {
        const sealed = yield* cipher.encrypt(plaintext);
        const decrypted = yield* cipher.decrypt(sealed.sealed);

        return { sealed, decrypted };
      }),
    );

    expect(result.decrypted).toBe(plaintext);
    expect(result.sealed.keyId).toBe("k1");
    expect(result.sealed.sealed.startsWith("v1.k1.")).toBe(true);
    expect(result.sealed.sealed.split(".")).toHaveLength(5);
  });

  it("uses the configured key id", async () => {
    const sealed = await withCipher({ key: keyA, keyId: "k2" }, (cipher) =>
      cipher.encrypt("payload"),
    );

    expect(sealed.keyId).toBe("k2");
    expect(sealed.sealed.startsWith("v1.k2.")).toBe(true);
  });

  it("produces distinct sealed strings for the same plaintext (random IV)", async () => {
    const [first, second] = await withCipher({ key: keyA }, (cipher) =>
      Effect.all([cipher.encrypt("same"), cipher.encrypt("same")]),
    );

    expect(first.sealed).not.toBe(second.sealed);
  });

  it("detects ciphertext tampering", async () => {
    const error = await withCipher({ key: keyA }, (cipher) =>
      Effect.gen(function* () {
        const sealed = yield* cipher.encrypt("secret payload");

        return yield* cipher.decrypt(flipLastCharacter(sealed.sealed)).pipe(Effect.flip);
      }),
    );

    expect(error).toBeInstanceOf(CredentialCipherError);
    expect(error.operation).toBe("decrypt");
  });

  it("fails to decrypt with a different key", async () => {
    const sealed = await withCipher({ key: keyA }, (cipher) => cipher.encrypt("secret payload"));
    const error = await withCipher({ key: keyB }, (cipher) =>
      cipher.decrypt(sealed.sealed).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(CredentialCipherError);
    expect(error.operation).toBe("decrypt");
  });

  it("rejects a sealed payload with a mismatched key id", async () => {
    const sealed = await withCipher({ key: keyA, keyId: "k1" }, (cipher) =>
      cipher.encrypt("secret payload"),
    );
    const error = await withCipher({ key: keyA, keyId: "k2" }, (cipher) =>
      cipher.decrypt(sealed.sealed).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(CredentialCipherError);
    expect(error.message).toContain('key id "k1"');
  });

  it("rejects malformed sealed strings", async () => {
    const error = await withCipher({ key: keyA }, (cipher) =>
      cipher.decrypt("not-a-sealed-credential").pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(CredentialCipherError);
    expect(error.message).toContain("v1.<keyId>.<iv>.<authTag>.<ciphertext>");
  });

  it("fails layer construction when the key is not 32 bytes of base64", async () => {
    await expect(
      withCipher({ key: Buffer.from("too short").toString("base64") }, (cipher) =>
        cipher.encrypt("payload"),
      ),
    ).rejects.toThrow(/32 bytes/);
  });
});

describe("sha256Hex", () => {
  it("computes the hex sha-256 digest", () => {
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
