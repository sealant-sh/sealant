import { bridgeLaunchRequestSchema } from "@sealant/workspaces/cloudflare/bridge-contract";
import { describe, expect, it } from "vitest";

import { bearerMatches, bootEnvForLaunch, sandboxNameForRun } from "./plan.js";

const request = bridgeLaunchRequestSchema.parse({
  version: 1,
  runId: "run_ABC.123",
  source: {
    url: "https://github.com/example/repo.git",
    ref: "main",
    auth: { username: "x-access-token", token: "ghs_secret" },
  },
  image: {
    repository: "sealant/workspaces/demo",
    tag: "opencode",
    reference: "registry.example.com/demo:opencode",
    digestReference: "registry.example.com/demo@sha256:test",
    digest: "sha256:test",
  },
  env: { NODE_ENV: "development" },
  secretEnv: { API_KEY: "secret" },
});

describe("sandboxNameForRun", () => {
  it("is deterministic and survives sanitization without collisions", () => {
    expect(sandboxNameForRun("run_ABC.123")).toBe(sandboxNameForRun("run_ABC.123"));
    // Distinct raw ids that sanitize identically still differ via the hash suffix.
    expect(sandboxNameForRun("run_a.b")).not.toBe(sandboxNameForRun("run_a_b"));
    expect(sandboxNameForRun("run_ABC.123")).toMatch(/^ws-[a-z0-9-]+-[0-9a-f]{8}$/);
  });
});

describe("bootEnvForLaunch", () => {
  it("assembles the sealantd boot contract plus the launch env", () => {
    const env = bootEnvForLaunch(request);
    expect(env).toMatchObject({
      SEALANT_CONTROL_SOCKET: "/run/sealant/control.sock",
      SEALANT_WORKSPACE_SOURCE: "git",
      SEALANT_WORKSPACE_REPO_URL: "https://github.com/example/repo.git",
      SEALANT_WORKSPACE_REPO_REF: "main",
      SEALANT_WORKSPACE_HTTP_USERNAME: "x-access-token",
      SEALANT_WORKSPACE_HTTP_TOKEN: "ghs_secret",
      SEALANT_SECRET_ENV_FILE: "/run/sealant/secrets/env.json",
      NODE_ENV: "development",
    });
    expect(env["SEALANT_DOTFILES_ARCHIVE_DIR"]).toBeUndefined();
  });

  it("omits auth and secret markers when the request carries none", () => {
    const bare = bridgeLaunchRequestSchema.parse({
      ...request,
      source: { url: request.source.url },
      secretEnv: undefined,
    });
    const env = bootEnvForLaunch(bare);
    expect(env["SEALANT_WORKSPACE_HTTP_TOKEN"]).toBeUndefined();
    expect(env["SEALANT_SECRET_ENV_FILE"]).toBeUndefined();
    expect(env["SEALANT_WORKSPACE_REPO_REF"]).toBeUndefined();
  });
});

describe("bearerMatches", () => {
  it("accepts only the exact bearer for a non-empty expectation", () => {
    expect(bearerMatches("Bearer token-1", "token-1")).toBe(true);
    expect(bearerMatches("Bearer token-2", "token-1")).toBe(false);
    expect(bearerMatches("token-1", "token-1")).toBe(false);
    expect(bearerMatches(null, "token-1")).toBe(false);
  });

  it("never accepts anything when the expected token is unset", () => {
    expect(bearerMatches("Bearer ", "")).toBe(false);
  });
});
