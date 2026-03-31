import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const bootstrapDirectory = mkdtempSync(join(tmpdir(), "sealant-ssh-gateway-bootstrap-"));
const bootstrapHostKeyPath = join(bootstrapDirectory, "ssh_gateway_host_key");
const bootstrapAllowedKeysPath = join(bootstrapDirectory, "authorized_keys");
const bootstrapUpstreamPrivateKeyPath = join(bootstrapDirectory, "id_ed25519");

writeFileSync(bootstrapHostKeyPath, "bootstrap-host-key\n", "utf8");
writeFileSync(bootstrapAllowedKeysPath, "bootstrap-allowed-key\n", "utf8");
writeFileSync(bootstrapUpstreamPrivateKeyPath, "bootstrap-upstream-key\n", "utf8");

const previousBootstrapEnv = {
  SANDBOX_SSH_GATEWAY_TOKEN: process.env.SANDBOX_SSH_GATEWAY_TOKEN,
  SSH_GATEWAY_HOST_KEY_PATH: process.env.SSH_GATEWAY_HOST_KEY_PATH,
  SSH_GATEWAY_ALLOWED_KEYS_FILE: process.env.SSH_GATEWAY_ALLOWED_KEYS_FILE,
  SSH_UPSTREAM_PRIVATE_KEY_PATH: process.env.SSH_UPSTREAM_PRIVATE_KEY_PATH,
};

process.env.SANDBOX_SSH_GATEWAY_TOKEN = process.env.SANDBOX_SSH_GATEWAY_TOKEN ?? "bootstrap-token";
process.env.SSH_GATEWAY_HOST_KEY_PATH =
  process.env.SSH_GATEWAY_HOST_KEY_PATH ?? bootstrapHostKeyPath;
process.env.SSH_GATEWAY_ALLOWED_KEYS_FILE =
  process.env.SSH_GATEWAY_ALLOWED_KEYS_FILE ?? bootstrapAllowedKeysPath;
process.env.SSH_UPSTREAM_PRIVATE_KEY_PATH =
  process.env.SSH_UPSTREAM_PRIVATE_KEY_PATH ?? bootstrapUpstreamPrivateKeyPath;

const { parseSshGatewayEnv } = await import("./env.js");

afterAll(() => {
  if (previousBootstrapEnv.SANDBOX_SSH_GATEWAY_TOKEN === undefined) {
    delete process.env.SANDBOX_SSH_GATEWAY_TOKEN;
  } else {
    process.env.SANDBOX_SSH_GATEWAY_TOKEN = previousBootstrapEnv.SANDBOX_SSH_GATEWAY_TOKEN;
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

  if (previousBootstrapEnv.SSH_UPSTREAM_PRIVATE_KEY_PATH === undefined) {
    delete process.env.SSH_UPSTREAM_PRIVATE_KEY_PATH;
  } else {
    process.env.SSH_UPSTREAM_PRIVATE_KEY_PATH = previousBootstrapEnv.SSH_UPSTREAM_PRIVATE_KEY_PATH;
  }

  rmSync(bootstrapDirectory, { force: true, recursive: true });
});

describe("parseSshGatewayEnv", () => {
  it("hydrates key files into memory", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "sealant-ssh-gateway-keys-"));
    const hostKeyPath = join(tempDirectory, "ssh_gateway_host_key");
    const allowedKeysPath = join(tempDirectory, "authorized_keys");
    const upstreamPrivateKeyPath = join(tempDirectory, "id_ed25519");

    try {
      writeFileSync(hostKeyPath, "host-key\n", "utf8");
      writeFileSync(allowedKeysPath, "allowed-key\n", "utf8");
      writeFileSync(upstreamPrivateKeyPath, "upstream-private-key\n", "utf8");

      const env = parseSshGatewayEnv({
        SANDBOX_SSH_GATEWAY_TOKEN: "token",
        SSH_GATEWAY_HOST_KEY_PATH: hostKeyPath,
        SSH_GATEWAY_ALLOWED_KEYS_FILE: allowedKeysPath,
        SSH_UPSTREAM_PRIVATE_KEY_PATH: upstreamPrivateKeyPath,
      });

      expect(env.SSH_GATEWAY_HOST_KEY_PATH).toBe(hostKeyPath);
      expect(env.SSH_GATEWAY_ALLOWED_KEYS_FILE).toBe(allowedKeysPath);
      expect(env.SSH_UPSTREAM_PRIVATE_KEY_PATH).toBe(upstreamPrivateKeyPath);
      expect(env.SSH_GATEWAY_HOST_KEY).toBe("host-key\n");
      expect(env.SSH_GATEWAY_ALLOWED_KEYS).toBe("allowed-key\n");
      expect(env.SSH_UPSTREAM_PRIVATE_KEY).toBe("upstream-private-key\n");
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });
});
