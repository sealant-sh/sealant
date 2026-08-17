import { parseWorkspaceBlueprint } from "@sealant/validators";
import { describe, expect, it } from "vitest";

/**
 * Shape pins for `runtime.userEnv` — the caller-owned, policy-validated workspace environment —
 * and compatibility pins for the LEGACY `runtime.env`, whose unrestricted semantics stored specs
 * still rely on. Every create/worker/restart read funnels through this same schema, so these pins
 * cover all three paths.
 */
const baseSpec = {
  sources: { workspace: { kind: "git", url: "https://github.com/acme/app.git" } },
  harness: { id: "claude-code" },
};

describe("blueprint runtime.userEnv", () => {
  it("decodes a pre-feature spec (no field) to an empty map", () => {
    const blueprint = parseWorkspaceBlueprint(baseSpec);
    expect(blueprint.runtime.userEnv).toEqual({});
    expect(blueprint.runtime.env).toEqual({});
  });

  it("keeps a valid caller map verbatim", () => {
    const blueprint = parseWorkspaceBlueprint({
      ...baseSpec,
      runtime: { userEnv: { APP_MODE: "review", EMPTY_VALUE: "", MULTILINE: "a\nb" } },
    });
    expect(blueprint.runtime.userEnv).toEqual({
      APP_MODE: "review",
      EMPTY_VALUE: "",
      MULTILINE: "a\nb",
    });
  });

  it.each([
    [{ GITHUB_TOKEN: "x" }, /reserved/],
    [{ SEALANT_WORKSPACE_ROOT: "/elsewhere" }, /reserved/],
    [{ DB_PASSWORD: "x" }, /reserved/],
    [{ http_proxy: "http://127.0.0.1:8080" }, /reserved/],
    [{ "BAD NAME": "x" }, /A-Za-z_/],
  ])("rejects the invalid map %j on every parse", (userEnv, message) => {
    expect(() => parseWorkspaceBlueprint({ ...baseSpec, runtime: { userEnv } })).toThrow(message);
  });

  it("never echoes a value in the rejection", () => {
    let thrown: unknown;
    try {
      parseWorkspaceBlueprint({
        ...baseSpec,
        runtime: { userEnv: { GITHUB_TOKEN: "ghp_super_sensitive" } },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(String(thrown)).not.toContain("ghp_super_sensitive");
  });

  it("leaves LEGACY runtime.env unrestricted for stored-spec compatibility", () => {
    // Pre-feature specs may carry entries the new policy would refuse — including platform
    // overrides. They must keep parsing (and restarting) with their previous semantics.
    const blueprint = parseWorkspaceBlueprint({
      ...baseSpec,
      runtime: {
        env: {
          GITHUB_TOKEN: "stored-before-the-policy-existed",
          SEALANT_HARNESS_BANNER: "legacy override",
          "not a valid name either": "kept",
        },
      },
    });
    expect(blueprint.runtime.env).toEqual({
      GITHUB_TOKEN: "stored-before-the-policy-existed",
      SEALANT_HARNESS_BANNER: "legacy override",
      "not a valid name either": "kept",
    });
    expect(blueprint.runtime.userEnv).toEqual({});
  });
});
