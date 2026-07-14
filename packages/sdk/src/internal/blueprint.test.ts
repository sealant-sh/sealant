import { describe, expect, it } from "vitest";

import { opencode } from "../harness.js";
import { buildCreateWorkspaceRequest } from "./blueprint.js";
import type { SealantInternalConfig } from "./config.js";

const config: SealantInternalConfig = {
  baseUrl: "http://localhost:4000",
  apiKey: undefined,
  fetch: undefined,
  hostLocal: { ownerUserId: "usr_local", registryId: "default" },
};

interface SpecShape {
  readonly sources: { readonly workspace: { readonly url: string; readonly ref: string } };
  readonly harness: { readonly id: string };
  readonly customization: { readonly enableSealantd: boolean };
  readonly target: { readonly runtime: { readonly family: string } };
  readonly credentials?: {
    readonly profileId?: string;
    readonly claude?: string;
    readonly codex?: string;
    readonly github?: string;
  };
}

describe("buildCreateWorkspaceRequest", () => {
  it("lowers {repository, harness} onto the create contract", () => {
    const { payload } = buildCreateWorkspaceRequest(
      { repository: "github.com/acme/billing-service", harness: opencode() },
      config,
    );
    expect(payload.ownerUserId).toBe("usr_local");
    expect(payload.registryId).toBe("default");
    expect(payload.repository).toBe("billing-service"); // sanitized source tail
    expect(payload.tag).toMatch(/^sdk-/);

    const spec = payload.spec as unknown as SpecShape;
    expect(spec.sources.workspace.url).toBe("https://github.com/acme/billing-service.git");
    // No ref requested → none sent; the clone resolves the repository's default branch.
    expect(spec.sources.workspace.ref).toBeUndefined();
    expect(spec.harness.id).toBe("opencode");
    expect(spec.customization.enableSealantd).toBe(true);
    expect(spec.target.runtime.family).toBe("docker");
  });

  it("passes through full git urls and honors an explicit ref", () => {
    const { payload } = buildCreateWorkspaceRequest(
      { repository: "https://gitlab.com/x/y.git", ref: "master", harness: opencode() },
      config,
    );
    const spec = payload.spec as unknown as SpecShape;
    expect(spec.sources.workspace.url).toBe("https://gitlab.com/x/y.git");
    expect(spec.sources.workspace.ref).toBe("master");
  });

  it("omits `spec.credentials` when no credentials were requested", () => {
    const { payload } = buildCreateWorkspaceRequest(
      { repository: "github.com/acme/billing-service", harness: opencode() },
      config,
    );
    const spec = payload.spec as unknown as SpecShape;
    expect(spec.credentials).toBeUndefined();
  });

  it("folds mapped credentials into `spec.credentials`", () => {
    const { payload } = buildCreateWorkspaceRequest(
      {
        repository: "github.com/acme/billing-service",
        harness: opencode(),
        credentials: { profile: "prof_123", claude: true, github: "bot-account" },
      },
      config,
    );
    const spec = payload.spec as unknown as SpecShape;
    expect(spec.credentials).toEqual({
      profileId: "prof_123",
      claude: "default",
      github: "bot-account",
    });
  });
});
