import { describe, expect, it } from "vitest";

import { bearerSecretOf, makeServicePrincipals, parseServiceKeys } from "./service-principals.js";

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
