import { describe, expect, it } from "vitest";

import {
  bearerSecretOf,
  makeServicePrincipals,
  parseServiceKeys,
  resolveAuthPosture,
} from "./service-principals.js";

describe("service principals", () => {
  it("is disabled without keys and never matches", () => {
    const principals = makeServicePrincipals(undefined);
    expect(principals.enabled).toBe(false);
    expect(principals.matches("anything")).toBe(false);
    expect(makeServicePrincipals(" , ").enabled).toBe(false);
  });

  it("parses comma-separated keys and matches any of them exactly", () => {
    expect(parseServiceKeys(" slt_svc_a, slt_svc_b ,")).toEqual(["slt_svc_a", "slt_svc_b"]);
    const principals = makeServicePrincipals("slt_svc_a,slt_svc_b");
    expect(principals.enabled).toBe(true);
    expect(principals.matches("slt_svc_a")).toBe(true);
    expect(principals.matches("slt_svc_b")).toBe(true);
    expect(principals.matches("slt_svc_")).toBe(false);
    expect(principals.matches("slt_svc_ab")).toBe(false);
    expect(principals.matches("")).toBe(false);
  });

  it("reads the bearer from the header first, then the WebSocket query token", () => {
    expect(bearerSecretOf({ authorization: "Bearer abc ", queryToken: null })).toBe("abc");
    expect(bearerSecretOf({ authorization: "bearer abc", queryToken: "zzz" })).toBe("abc");
    expect(bearerSecretOf({ authorization: undefined, queryToken: "zzz" })).toBe("zzz");
    expect(bearerSecretOf({ authorization: "Basic abc", queryToken: null })).toBeUndefined();
    expect(bearerSecretOf({ authorization: "", queryToken: " " })).toBeUndefined();
  });
});

describe("resolveAuthPosture (CORE-01: fail closed)", () => {
  it("is closed whenever a service key is configured", () => {
    for (const nodeEnv of ["development", "test", "production"] as const) {
      expect(resolveAuthPosture({ serviceKeys: "k", nodeEnv, allowOpenApi: true })).toEqual({
        kind: "closed",
      });
    }
  });

  it("refuses to start without keys, in every environment", () => {
    for (const nodeEnv of ["development", "test", "production"] as const) {
      const posture = resolveAuthPosture({ serviceKeys: undefined, nodeEnv, allowOpenApi: false });
      expect(posture.kind).toBe("refused");
    }
    // Only separators is no key at all.
    expect(
      resolveAuthPosture({ serviceKeys: " , ", nodeEnv: "development", allowOpenApi: false }).kind,
    ).toBe("refused");
  });

  it("opens only on the explicit exception, and never in production", () => {
    expect(
      resolveAuthPosture({ serviceKeys: undefined, nodeEnv: "development", allowOpenApi: true }),
    ).toEqual({ kind: "open" });
    expect(
      resolveAuthPosture({ serviceKeys: undefined, nodeEnv: "test", allowOpenApi: true }),
    ).toEqual({ kind: "open" });
    const production = resolveAuthPosture({
      serviceKeys: undefined,
      nodeEnv: "production",
      allowOpenApi: true,
    });
    expect(production.kind).toBe("refused");
    expect(production.kind === "refused" ? production.message : "").toContain(
      "not honoured with NODE_ENV=production",
    );
  });
});
