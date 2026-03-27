import { describe, expect, it } from "vitest";

import { parseSshEndpoint, parseSandboxIdFromUsername } from "./sandbox-target.js";

describe("parseSandboxIdFromUsername", () => {
  it("extracts sandbox id from prefixed usernames", () => {
    expect(parseSandboxIdFromUsername("sbx-sandbox_123", "sbx")).toBe("sandbox_123");
  });

  it("rejects usernames that do not match the configured prefix", () => {
    expect(parseSandboxIdFromUsername("sandbox_123", "sbx")).toBeUndefined();
  });

  it("rejects invalid sandbox identifiers", () => {
    expect(parseSandboxIdFromUsername("sbx-../../etc/passwd", "sbx")).toBeUndefined();
  });
});

describe("parseSshEndpoint", () => {
  it("parses explicit ssh URIs", () => {
    expect(parseSshEndpoint("ssh://root@172.18.0.10:2222")).toEqual({
      user: "root",
      host: "172.18.0.10",
      port: 2222,
    });
  });

  it("defaults to root and port 22", () => {
    expect(parseSshEndpoint("ssh://10.0.0.5")).toEqual({
      user: "root",
      host: "10.0.0.5",
      port: 22,
    });
  });

  it("throws on non-ssh URIs", () => {
    expect(() => parseSshEndpoint("http://localhost:2222")).toThrow("Expected ssh:// URI.");
  });
});
