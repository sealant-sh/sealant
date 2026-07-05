import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ssh2 from "ssh2";
import { afterEach, describe, expect, it } from "vitest";

import { ensureSshGatewayHostKey } from "./host-key.js";

const tempDirs: Array<string> = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sealant-host-key-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ensureSshGatewayHostKey", () => {
  it("does nothing when autogeneration is off", () => {
    const dir = makeTempDir();
    const hostKeyPath = join(dir, "keys", "host_key");

    ensureSshGatewayHostKey({ SSH_GATEWAY_HOST_KEY_PATH: hostKeyPath });

    expect(existsSync(hostKeyPath)).toBe(false);
  });

  it("generates a parseable ed25519 host key when the file is missing", () => {
    const dir = makeTempDir();
    const hostKeyPath = join(dir, "keys", "host_key");

    ensureSshGatewayHostKey({
      SSH_GATEWAY_HOST_KEY_PATH: hostKeyPath,
      SSH_GATEWAY_HOST_KEY_AUTOGENERATE: "true",
    });

    const privateKey = readFileSync(hostKeyPath, "utf8");
    const parsed = ssh2.utils.parseKey(privateKey);
    expect(parsed).not.toBeInstanceOf(Error);
    expect(readFileSync(`${hostKeyPath}.pub`, "utf8")).toMatch(/^ssh-ed25519 /);
    // Private key must not be group/world readable — sshd-style hygiene.
    expect(statSync(hostKeyPath).mode & 0o777).toBe(0o600);
  });

  it("never overwrites an existing host key", () => {
    const dir = makeTempDir();
    const hostKeyPath = join(dir, "host_key");
    writeFileSync(hostKeyPath, "existing-key-material", { mode: 0o600 });

    ensureSshGatewayHostKey({
      SSH_GATEWAY_HOST_KEY_PATH: hostKeyPath,
      SSH_GATEWAY_HOST_KEY_AUTOGENERATE: "true",
    });

    expect(readFileSync(hostKeyPath, "utf8")).toBe("existing-key-material");
  });
});
