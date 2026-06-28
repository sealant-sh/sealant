import { describe, expect, it } from "vitest";

import { opencode } from "../harness.js";
import { buildCreateSandboxRequest } from "./blueprint.js";
import type { SealantInternalConfig } from "./config.js";

const config: SealantInternalConfig = {
  baseUrl: "http://localhost:4000",
  apiKey: undefined,
  fetch: undefined,
  hostLocal: { ownerUserId: "usr_local", registryId: "default", databaseUrl: "postgres://x" },
};

interface SpecShape {
  readonly sources: { readonly sandbox: { readonly url: string; readonly ref: string } };
  readonly harness: { readonly id: string };
  readonly customization: { readonly enableSealantd: boolean };
  readonly target: { readonly runtime: { readonly family: string } };
}

describe("buildCreateSandboxRequest", () => {
  it("lowers {repository, harness} onto the create contract", () => {
    const { payload } = buildCreateSandboxRequest(
      { repository: "github.com/acme/billing-service", harness: opencode() },
      config,
    );
    expect(payload.ownerUserId).toBe("usr_local");
    expect(payload.registryId).toBe("default");
    expect(payload.repository).toBe("billing-service"); // sanitized source tail
    expect(payload.tag).toMatch(/^sdk-/);

    const spec = payload.spec as unknown as SpecShape;
    expect(spec.sources.sandbox.url).toBe("https://github.com/acme/billing-service.git");
    expect(spec.sources.sandbox.ref).toBe("main");
    expect(spec.harness.id).toBe("opencode");
    expect(spec.customization.enableSealantd).toBe(true);
    expect(spec.target.runtime.family).toBe("docker");
  });

  it("passes through full git urls and honors an explicit ref", () => {
    const { payload } = buildCreateSandboxRequest(
      { repository: "https://gitlab.com/x/y.git", ref: "master", harness: opencode() },
      config,
    );
    const spec = payload.spec as unknown as SpecShape;
    expect(spec.sources.sandbox.url).toBe("https://gitlab.com/x/y.git");
    expect(spec.sources.sandbox.ref).toBe("master");
  });
});
