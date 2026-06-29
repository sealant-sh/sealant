import { describe, expect, it } from "vitest";

import { opencode } from "../harness.js";
import { buildCreateSandboxRequest } from "./blueprint.js";
import type { SealantInternalConfig } from "./config.js";

const config: SealantInternalConfig = {
  baseUrl: "http://localhost:4000",
  apiKey: undefined,
  fetch: undefined,
  hostLocal: { ownerUserId: "usr_local", registryId: "default" },
};

interface SpecShape {
  readonly sources: { readonly sandbox: { readonly url: string; readonly ref: string } };
  readonly harness: { readonly id: string };
  readonly customization: { readonly enableSealantd: boolean };
  readonly target: { readonly runtime: { readonly family: string } };
  readonly runtime?: { readonly env?: Readonly<Record<string, string>> };
  readonly lifecycle?: { readonly setup?: ReadonlyArray<{ readonly run: string }> };
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

  it("omits spec.runtime and lifecycle.setup when nothing is forwarded", () => {
    const { payload } = buildCreateSandboxRequest(
      { repository: "github.com/acme/x", harness: opencode() },
      config,
    );
    const spec = payload.spec as unknown as SpecShape;
    expect(spec.runtime).toBeUndefined();
    expect(spec.lifecycle?.setup).toBeUndefined();
  });

  it("lowers forwarded env + boot steps onto spec.runtime.env and spec.lifecycle.setup", () => {
    const { payload } = buildCreateSandboxRequest(
      { repository: "github.com/acme/x", harness: opencode() },
      config,
      {
        env: { GH_TOKEN: "ghp_x", SEALANT_FWD_CODEX_0: "YmFzZTY0" },
        setupSteps: [{ run: 'printf %s "$SEALANT_FWD_CODEX_0" | base64 -d > /root/.codex/auth.json', shell: "bash" }],
      },
    );
    const spec = payload.spec as unknown as SpecShape;
    expect(spec.runtime?.env).toEqual({ GH_TOKEN: "ghp_x", SEALANT_FWD_CODEX_0: "YmFzZTY0" });
    expect(spec.lifecycle?.setup?.[0]?.run).toMatch(/base64 -d > \/root\/\.codex\/auth\.json/);
  });
});
