import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseWorkerEnv } from "@sealant/validators/env";
import { describe, expect, it } from "vitest";

describe("parseWorkerEnv", () => {
  it("keeps legacy bind mode when Compose interpolates an unset mapping as empty", () => {
    const env = parseWorkerEnv({ SEALANT_DOCKER_VOLUME_MAPPINGS: "" });

    expect(env.SEALANT_DOCKER_VOLUME_MAPPINGS).toBeUndefined();
  });

  it("preserves strict Docker volume mappings for semantic parsing at worker startup", () => {
    const mappings = JSON.stringify([
      { logicalRoot: "/var/lib/mend/store", volumeName: "mend-store" },
      { logicalRoot: "/run/sealant/sockets", volumeName: "sealant-sockets" },
    ]);

    const env = parseWorkerEnv({ SEALANT_DOCKER_VOLUME_MAPPINGS: mappings });

    expect(env.SEALANT_DOCKER_VOLUME_MAPPINGS).toBe(mappings);
  });

  it("treats an empty workspace network as unset and keeps a named one", () => {
    expect(
      parseWorkerEnv({ SEALANT_DOCKER_WORKSPACE_NETWORK: "" }).SEALANT_DOCKER_WORKSPACE_NETWORK,
    ).toBeUndefined();
    expect(
      parseWorkerEnv({ SEALANT_DOCKER_WORKSPACE_NETWORK: "mend_default" })
        .SEALANT_DOCKER_WORKSPACE_NETWORK,
    ).toBe("mend_default");
  });

  it("refuses a retired one-image MicroVM setting instead of ignoring it", () => {
    expect(() =>
      parseWorkerEnv({
        SEALANT_MICROVM_IMAGE_ARN: "arn:aws:lambda:eu-central-1:123456789012:microvm-image:base",
      }),
    ).toThrow(/SEALANT_MICROVM_IMAGE_ARN is retired/);
  });

  it("needs the build role where MicroVM is the default runtime", () => {
    expect(() => parseWorkerEnv({ DEFAULT_RUNTIME_ADAPTER: "microvm" })).toThrow(
      /SEALANT_MICROVM_BUILD_ROLE_ARN/,
    );
    expect(
      parseWorkerEnv({
        DEFAULT_RUNTIME_ADAPTER: "microvm",
        SEALANT_MICROVM_BUILD_ROLE_ARN: "arn:aws:iam::123456789012:role/sealant-microvm-build",
        SEALANT_MICROVM_MEMORY_MIB: "8192",
      }),
    ).toMatchObject({ SEALANT_MICROVM_MEMORY_MIB: 8192 });
  });

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
