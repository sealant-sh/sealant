import { describe, expect, it } from "vitest";

import {
  isDnsLabel,
  workspaceControlEndpoint,
  workspaceResourceName,
  workspaceResourceNames,
  workspaceServiceDnsName,
} from "./names.js";

describe("workspace resource names", () => {
  it("is deterministic and DNS-safe for ordinary run ids", () => {
    const a = workspaceResourceName("run_01J7ABCDEF");
    expect(a).toBe(workspaceResourceName("run_01J7ABCDEF"));
    expect(a.startsWith("ws-run-01j7abcdef-")).toBe(true);
    expect(isDnsLabel(a)).toBe(true);
  });

  it("keeps distinct run ids distinct even when they sanitize identically", () => {
    expect(workspaceResourceName("Run-1")).not.toBe(workspaceResourceName("run_1"));
    expect(isDnsLabel(workspaceResourceName("Run-1"))).toBe(true);
  });

  it("bounds very long ids and strips illegal characters", () => {
    const name = workspaceResourceName(`${"x".repeat(200)}/!!@@`);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(isDnsLabel(name)).toBe(true);
  });

  it("rejects empty ids and falls back for ids with no usable characters", () => {
    expect(() => workspaceResourceName("   ")).toThrow();
    expect(workspaceResourceName("!!!").startsWith("ws-run-")).toBe(true);
  });

  it("derives every sibling name, the Service DNS name and the endpoint", () => {
    const names = workspaceResourceNames("run-1");
    expect(names.service).toBe(names.pod);
    expect(names.launchSecret).toBe(`${names.pod}-launch`);
    expect(names.envSecret).toBe(`${names.pod}-env`);
    expect(names.tlsSecret).toBe(`${names.pod}-tls`);
    expect(names.certificate).toBe(names.pod);
    expect(workspaceServiceDnsName(names.service, "ns")).toBe(`${names.pod}.ns.svc`);
    expect(workspaceControlEndpoint(names.service, "ns", 7443)).toBe(
      `wss://${names.pod}.ns.svc:7443/control`,
    );
    for (const value of Object.values(names)) {
      expect(value.length).toBeLessThanOrEqual(63);
    }
  });
});
