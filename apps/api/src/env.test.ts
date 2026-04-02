import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAppEnv } from "@sealant/validators/env";
import { describe, expect, it } from "vitest";

const createBaseEnv = () => {
  return {
    DATABASE_FILE_PATH: ":memory:",
    DATABASE_BUSY_TIMEOUT_MS: "5000",
    RABBITMQ_URL: "amqp://sealant:sealant@127.0.0.1:5673",
    PORT: "4000",
    SANDBOX_BUILD_QUEUE_PREFETCH: "1",
  } satisfies NodeJS.ProcessEnv;
};

describe("parseAppEnv", () => {
  it("loads the GitHub App private key from GITHUB_APP_PRIVATE_KEY_PATH", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "sealant-github-key-"));
    const privateKeyPath = join(tempDirectory, "github-app.private-key.pem");
    const privateKey = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "test-private-key",
      "-----END RSA PRIVATE KEY-----",
      "",
    ].join("\n");

    try {
      writeFileSync(privateKeyPath, privateKey, "utf8");

      const env = parseAppEnv({
        ...createBaseEnv(),
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
        GITHUB_APP_WEBHOOK_SECRET: "secret",
      });

      expect(env.GITHUB_APP_PRIVATE_KEY_PATH).toBe(privateKeyPath);
      expect(env.GITHUB_APP_PRIVATE_KEY).toBe(privateKey);
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it("rejects GitHub App configuration when neither key input is provided", () => {
    expect(() => {
      parseAppEnv({
        ...createBaseEnv(),
        GITHUB_APP_ID: "123456",
      });
    }).toThrowError(/GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH/);
  });
});
