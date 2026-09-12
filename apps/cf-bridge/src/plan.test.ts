import { bridgeLaunchRequestSchema } from "@sealant/workspaces/cloudflare/bridge-contract";
import { describe, expect, it } from "vitest";

import {
  bearerMatches,
  bootEnvForLaunch,
  sandboxNameForRun,
  sandboxOptionsForLaunch,
  stopModeFromUrl,
} from "./plan.js";

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
      source: { url: "https://github.com/example/repo.git" },
      secretEnv: undefined,
    });
    const env = bootEnvForLaunch(bare);
    expect(env["SEALANT_WORKSPACE_HTTP_TOKEN"]).toBeUndefined();
    expect(env["SEALANT_SECRET_ENV_FILE"]).toBeUndefined();
    expect(env["SEALANT_WORKSPACE_REPO_REF"]).toBeUndefined();
  });
});

const captureRequest = bridgeLaunchRequestSchema.parse({
  ...request,
  source: { kind: "capture", endpoint: "https://mend.example.com/session/s1", worktreeId: "wt_1" },
  env: { MEND_SESSION_ID: "1" },
  secretEnv: { MEND_SESSION_TOKEN: "mst", SEALANT_CAPTURE_TOKEN: "mst" },
});

describe("bootEnvForLaunch (capture source)", () => {
  it("names the channel and the worktree, mounts nothing, keeps the token in the secret file", () => {
    const env = bootEnvForLaunch(captureRequest);
    expect(env).toMatchObject({
      SEALANT_WORKSPACE_SOURCE: "capture",
      SEALANT_CAPTURE_ENDPOINT: "https://mend.example.com/session/s1",
      SEALANT_CAPTURE_WORKTREE_ID: "wt_1",
      SEALANT_SECRET_ENV_FILE: "/run/sealant/secrets/env.json",
      MEND_SESSION_ID: "1",
    });
    expect(env["SEALANT_WORKSPACE_REPO_URL"]).toBeUndefined();
    expect(env["SEALANT_WORKSPACE_HTTP_TOKEN"]).toBeUndefined();
    expect(env["SEALANT_CAPTURE_TOKEN"]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("mst");
  });
});

describe("sandboxOptionsForLaunch", () => {
  it("keeps a capture executor alive and leaves git launches on the SDK default", () => {
    expect(sandboxOptionsForLaunch(captureRequest)).toEqual({ keepAlive: true });
    expect(sandboxOptionsForLaunch(request)).toEqual({});
  });
});

describe("stopModeFromUrl", () => {
  it("defaults to a planned stop, names fence explicitly, and refuses anything else", () => {
    expect(stopModeFromUrl(new URL("https://b/v1/workspaces/x"))).toBe("planned");
    expect(stopModeFromUrl(new URL("https://b/v1/workspaces/x?mode=planned"))).toBe("planned");
    expect(stopModeFromUrl(new URL("https://b/v1/workspaces/x?mode=fence"))).toBe("fence");
    expect(stopModeFromUrl(new URL("https://b/v1/workspaces/x?mode=kill"))).toBeUndefined();
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
