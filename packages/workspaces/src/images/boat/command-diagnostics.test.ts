import { Arbitrary, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { BoatApiError, boatProviderFailureSchema } from "../../runtime/boat/config.js";
import { toWorkspaceBuildJobProcessingError } from "../../worker/errors.js";
import { NativeCatalogError } from "./catalog.js";
import { nativeCommandFailure, nativeCommandFailureSchema } from "./command-diagnostics.js";
import { NativeBuildError } from "./runtime-bundle.js";

const output = (text: string) => ({ stdout: text, stderr: text, exitCode: 42, timedOut: false });

describe("native command failure diagnostics", () => {
  it("redacts authentication, URLs, secret assignments, private keys and supplied values before taking a tail", () => {
    const secrets = [
      "fixture-private-token",
      "fixture-password",
      "fixture-env-secret",
      "private-key-data",
    ];
    const diagnostic = nativeCommandFailure(
      "install-recipe",
      output(
        [
          "\x1b[31mAuthorization: Bearer fixture-private-token\x1b[0m",
          "password='fixture-password' api_key=fixture-private-token",
          "https://user:fixture-password@example.invalid/path?token=fixture-private-token",
          "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-data\n-----END OPENSSH PRIVATE KEY-----",
          "fixture-env-secret".repeat(500),
          "\x00apt: fixture package unavailable\n",
        ].join("\n"),
      ),
      ["fixture-env-secret"],
    );
    const serialized = JSON.stringify(diagnostic);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(diagnostic.stderrTail).toContain("apt: fixture package unavailable");
    expect(diagnostic.stderrTail).not.toContain("\x00");
    expect(Buffer.byteLength(diagnostic.stderrTail)).toBeLessThanOrEqual(4096);
  });

  it("removes secrets from output shorter than the tail bound", () => {
    const diagnostic = nativeCommandFailure(
      "install-recipe",
      output(
        [
          "Bearer fixture-auth-value",
          "https://user:fixture-password@example.invalid/path?token=fixture-token",
          "password='fixture-assignment'",
          "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-private-key\n-----END OPENSSH PRIVATE KEY-----",
          "fixture-env-value",
          "apt: useful failure",
        ].join("\n"),
      ),
      ["fixture-env-value"],
    );
    const serialized = JSON.stringify(diagnostic);
    for (const secret of [
      "fixture-auth-value",
      "fixture-password",
      "fixture-token",
      "fixture-assignment",
      "fixture-private-key",
      "fixture-env-value",
    ])
      expect(serialized).not.toContain(secret);
    expect(diagnostic.stderrTail).toContain("apt: useful failure");
  });

  it("keeps bounded valid UTF-8 through journal reload and worker error translation", async () => {
    const checked = await Effect.runPromise(
      Arbitrary.checkEffect(Arbitrary.schema(Schema.String), (value) => {
        const diagnostic = nativeCommandFailure("install-recipe", output(value.repeat(1000)), []);
        const roundTrip = nativeCommandFailureSchema.parse(JSON.parse(JSON.stringify(diagnostic)));
        for (const tail of [diagnostic.stdoutTail, diagnostic.stderrTail]) {
          expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096);
          expect(Buffer.from(tail).toString("utf8")).toBe(tail);
        }
        expect(roundTrip).toEqual(diagnostic);
        return true;
      }),
    );
    expect(Arbitrary.formatCheckFailure(checked)).toBeUndefined();
    const diagnostic = nativeCommandFailure("install-recipe", output("apt: package refused"), []);
    const build = new NativeBuildError(
      "native-guest-command-failed",
      "/owned/build.json",
      diagnostic,
    );
    const catalog = new NativeCatalogError(
      "mechanism-failed",
      "publication",
      build.code,
      build.commandFailure,
    );
    const worker = toWorkspaceBuildJobProcessingError(catalog);
    expect(worker.message).toContain("apt: package refused");
    expect(worker.message).toContain('"step":"install-recipe"');
    expect(worker.cause).toBe(catalog);
  });
});

describe("native provider failure diagnostics", () => {
  it("keeps only approved cause classes through nested fetch errors and serialization", async () => {
    const checked = await Effect.runPromise(
      Arbitrary.checkEffect(Arbitrary.schema(Schema.String), (privateText) => {
        const error = new BoatApiError("execute", 200, "transport_error", {
          name: "TypeError",
          message: privateText,
          cause: { name: privateText, code: "UND_ERR_BODY_TIMEOUT", message: privateText },
        });
        expect(boatProviderFailureSchema.parse(JSON.parse(JSON.stringify(error)))).toEqual({
          operation: "execute",
          status: 200,
          causeClass: "UND_ERR_BODY_TIMEOUT",
        });
        expect(error.message).toBe(
          "Boat request failed during execute: transport_error (HTTP 200); cause UND_ERR_BODY_TIMEOUT",
        );
        const unknown = new BoatApiError("execute", null, "transport_error", {
          name: privateText,
          code: privateText,
        });
        expect(boatProviderFailureSchema.safeParse(unknown).success).toBe(true);
        expect(Object.hasOwn(unknown, "cause")).toBe(false);
        return true;
      }),
    );
    expect(Arbitrary.formatCheckFailure(checked)).toBeUndefined();
  });
});
