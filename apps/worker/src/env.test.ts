import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseWorkerEnv } from "./env.js";

describe("parseWorkerEnv", () => {
  it("loads the GitHub App private key from GITHUB_APP_PRIVATE_KEY_PATH", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "sealant-worker-github-key-"));
    const privateKeyPath = join(tempDirectory, "github-app.private-key.pem");
    const privateKey = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "test-private-key",
      "-----END RSA PRIVATE KEY-----",
      "",
    ].join("\n");

    try {
      writeFileSync(privateKeyPath, privateKey, "utf8");

      const env = parseWorkerEnv({
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
      });

      expect(env.GITHUB_APP_PRIVATE_KEY_PATH).toBe(privateKeyPath);
      expect(env.GITHUB_APP_PRIVATE_KEY).toBe(privateKey);
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });
});
