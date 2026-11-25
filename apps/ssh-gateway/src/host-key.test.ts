import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ssh2 from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureSshGatewayHostKey, generateEd25519KeyPair } from "./host-key.js";

const tempDirs: Array<string> = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sealant-host-key-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const parses = (key: string | Buffer): boolean => !(ssh2.utils.parseKey(key) instanceof Error);

/**
 * A key ssh2 1.17.0 wrote and cannot parse, as a stuck install has on disk: about 1 key in 256 has
 * its public key's leading zero byte dropped. 20,000 tries miss one with odds of about e^-78.
 */
const findUnparseableSsh2Key = (): string => {
  for (let attempt = 0; attempt < 20_000; attempt += 1) {
    const keyPair = ssh2.utils.generateKeyPairSync("ed25519");
    if (!parses(keyPair.private)) return keyPair.private;
  }
  throw new Error("ssh2 generated no unparseable ed25519 key in 20,000 tries");
};

const autogenerate = (hostKeyPath: string): void =>
  ensureSshGatewayHostKey({
    SSH_GATEWAY_HOST_KEY_PATH: hostKeyPath,
    SSH_GATEWAY_HOST_KEY_AUTOGENERATE: "true",
  });

describe("generateEd25519KeyPair", () => {
  it("only returns keys ssh2 can parse", () => {
    // ssh2's raw generator fails 1 in 256; 3,000 raw keys all parsing has odds of about e^-11.7.
    for (let index = 0; index < 3_000; index += 1) {
      expect(parses(generateEd25519KeyPair().private)).toBe(true);
    }
  });
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

    autogenerate(hostKeyPath);

    expect(parses(readFileSync(hostKeyPath, "utf8"))).toBe(true);
    expect(readFileSync(`${hostKeyPath}.pub`, "utf8")).toMatch(/^ssh-ed25519 /);
    // Private key must not be group/world readable — sshd-style hygiene.
    expect(statSync(hostKeyPath).mode & 0o777).toBe(0o600);
  });

  it("replaces a host key file ssh2 cannot parse, and says so once", () => {
    const dir = makeTempDir();
    const hostKeyPath = join(dir, "host_key");
    const unparseable = findUnparseableSsh2Key();
    writeFileSync(hostKeyPath, unparseable, { mode: 0o600 });
    writeFileSync(`${hostKeyPath}.pub`, "ssh-ed25519 stale\n", { mode: 0o644 });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    autogenerate(hostKeyPath);

    const replacement = readFileSync(hostKeyPath, "utf8");
    expect(replacement).not.toBe(unparseable);
    expect(parses(replacement)).toBe(true);
    const parsed = ssh2.utils.parseKey(replacement);
    const publicLine = readFileSync(`${hostKeyPath}.pub`, "utf8");
    if (parsed instanceof Error) throw parsed;
    expect(publicLine).toBe(`${parsed.type} ${parsed.getPublicSSH().toString("base64")}\n`);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain(`replaced host key at ${hostKeyPath}`);
  });

  it("keeps an existing host key that parses", () => {
    const dir = makeTempDir();
    const hostKeyPath = join(dir, "host_key");
    const existing = generateEd25519KeyPair().private;
    writeFileSync(hostKeyPath, existing, { mode: 0o600 });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    autogenerate(hostKeyPath);

    expect(readFileSync(hostKeyPath, "utf8")).toBe(existing);
    expect(existsSync(`${hostKeyPath}.pub`)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});
