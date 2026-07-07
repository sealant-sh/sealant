import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const bootstrapDirectory = mkdtempSync(join(tmpdir(), "sealant-ssh-gateway-bootstrap-"));
const bootstrapHostKeyPath = join(bootstrapDirectory, "ssh_gateway_host_key");
const bootstrapAllowedKeysPath = join(bootstrapDirectory, "authorized_keys");

writeFileSync(bootstrapHostKeyPath, "bootstrap-host-key\n", "utf8");
writeFileSync(bootstrapAllowedKeysPath, "bootstrap-allowed-key\n", "utf8");

const previousBootstrapEnv = {
  WORKSPACE_SSH_GATEWAY_TOKEN: process.env.WORKSPACE_SSH_GATEWAY_TOKEN,
  SSH_GATEWAY_HOST_KEY_PATH: process.env.SSH_GATEWAY_HOST_KEY_PATH,
  SSH_GATEWAY_ALLOWED_KEYS_FILE: process.env.SSH_GATEWAY_ALLOWED_KEYS_FILE,
};

process.env.WORKSPACE_SSH_GATEWAY_TOKEN =
  process.env.WORKSPACE_SSH_GATEWAY_TOKEN ?? "bootstrap-token";
process.env.SSH_GATEWAY_HOST_KEY_PATH =
  process.env.SSH_GATEWAY_HOST_KEY_PATH ?? bootstrapHostKeyPath;
process.env.SSH_GATEWAY_ALLOWED_KEYS_FILE =
  process.env.SSH_GATEWAY_ALLOWED_KEYS_FILE ?? bootstrapAllowedKeysPath;

const { parseSshGatewayEnv } = await import("@sealant/validators/env");

afterAll(() => {
  if (previousBootstrapEnv.WORKSPACE_SSH_GATEWAY_TOKEN === undefined) {
    delete process.env.WORKSPACE_SSH_GATEWAY_TOKEN;
  } else {
    process.env.WORKSPACE_SSH_GATEWAY_TOKEN = previousBootstrapEnv.WORKSPACE_SSH_GATEWAY_TOKEN;
  }

  if (previousBootstrapEnv.SSH_GATEWAY_HOST_KEY_PATH === undefined) {
    delete process.env.SSH_GATEWAY_HOST_KEY_PATH;
  } else {
    process.env.SSH_GATEWAY_HOST_KEY_PATH = previousBootstrapEnv.SSH_GATEWAY_HOST_KEY_PATH;
  }

  if (previousBootstrapEnv.SSH_GATEWAY_ALLOWED_KEYS_FILE === undefined) {
    delete process.env.SSH_GATEWAY_ALLOWED_KEYS_FILE;
  } else {
    process.env.SSH_GATEWAY_ALLOWED_KEYS_FILE = previousBootstrapEnv.SSH_GATEWAY_ALLOWED_KEYS_FILE;
  }

  rmSync(bootstrapDirectory, { force: true, recursive: true });
});

describe("parseSshGatewayEnv", () => {
  it("hydrates key files into memory", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "sealant-ssh-gateway-keys-"));
    const hostKeyPath = join(tempDirectory, "ssh_gateway_host_key");
    const allowedKeysPath = join(tempDirectory, "authorized_keys");

    try {
      writeFileSync(hostKeyPath, "host-key\n", "utf8");
      writeFileSync(allowedKeysPath, "allowed-key\n", "utf8");

      const env = parseSshGatewayEnv({
        WORKSPACE_SSH_GATEWAY_TOKEN: "token",
        SSH_GATEWAY_HOST_KEY_PATH: hostKeyPath,
        SSH_GATEWAY_ALLOWED_KEYS_FILE: allowedKeysPath,
      });

      expect(env.SSH_GATEWAY_HOST_KEY_PATH).toBe(hostKeyPath);
      expect(env.SSH_GATEWAY_ALLOWED_KEYS_FILE).toBe(allowedKeysPath);
      expect(env.SSH_GATEWAY_HOST_KEY).toBe("host-key\n");
      expect(env.SSH_GATEWAY_ALLOWED_KEYS).toBe("allowed-key\n");
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it("tolerates a missing allowlist file (API key lookup is the primary path)", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "sealant-ssh-gateway-keys-"));
    const hostKeyPath = join(tempDirectory, "ssh_gateway_host_key");

    try {
      writeFileSync(hostKeyPath, "host-key\n", "utf8");

      const env = parseSshGatewayEnv({
        WORKSPACE_SSH_GATEWAY_TOKEN: "token",
        SSH_GATEWAY_HOST_KEY_PATH: hostKeyPath,
        SSH_GATEWAY_ALLOWED_KEYS_FILE: join(tempDirectory, "does_not_exist"),
      });

      expect(env.SSH_GATEWAY_ALLOWED_KEYS).toBe("");
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it("accepts the sandbox-era names a pre-rename compose still passes", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "sealant-ssh-gateway-keys-"));
    const hostKeyPath = join(tempDirectory, "ssh_gateway_host_key");

    try {
      writeFileSync(hostKeyPath, "host-key\n", "utf8");

      const env = parseSshGatewayEnv({
        SANDBOX_SSH_GATEWAY_TOKEN: "legacy-token",
        SSH_GATEWAY_SANDBOX_USERNAME_PREFIX: "sbx",
        SSH_GATEWAY_HOST_KEY_PATH: hostKeyPath,
        SSH_GATEWAY_ALLOWED_KEYS_FILE: join(tempDirectory, "does_not_exist"),
      });

      expect(env.WORKSPACE_SSH_GATEWAY_TOKEN).toBe("legacy-token");
      expect(env.SSH_GATEWAY_WORKSPACE_USERNAME_PREFIX).toBe("sbx");
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it("prefers the workspace-era name when both are set", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "sealant-ssh-gateway-keys-"));
    const hostKeyPath = join(tempDirectory, "ssh_gateway_host_key");

    try {
      writeFileSync(hostKeyPath, "host-key\n", "utf8");

      const env = parseSshGatewayEnv({
        SANDBOX_SSH_GATEWAY_TOKEN: "legacy-token",
        WORKSPACE_SSH_GATEWAY_TOKEN: "current-token",
        SSH_GATEWAY_HOST_KEY_PATH: hostKeyPath,
        SSH_GATEWAY_ALLOWED_KEYS_FILE: join(tempDirectory, "does_not_exist"),
      });

      expect(env.WORKSPACE_SSH_GATEWAY_TOKEN).toBe("current-token");
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it("still requires the host key file", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "sealant-ssh-gateway-keys-"));

    try {
      expect(() =>
        parseSshGatewayEnv({
          WORKSPACE_SSH_GATEWAY_TOKEN: "token",
          SSH_GATEWAY_HOST_KEY_PATH: join(tempDirectory, "does_not_exist"),
          SSH_GATEWAY_ALLOWED_KEYS_FILE: join(tempDirectory, "also_missing"),
        }),
      ).toThrow();
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });
});
