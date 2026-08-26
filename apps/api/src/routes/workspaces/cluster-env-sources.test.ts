import { parseWorkspaceBlueprint } from "@sealant/validators";
import { describe, expect, it } from "vitest";

import { runtimeEnvReferencesRefusal } from "./workspaces.module.js";

/**
 * Shape pins for `runtime.envFrom` + `runtime.kubernetes` (cluster env sources) and the
 * create-time gate: Kubernetes-only inputs refuse synchronously on any other runtime family,
 * naming every unresolvable input — never a build-job failure minutes later.
 */
const baseSpec = {
  sources: { workspace: { kind: "git", url: "https://github.com/acme/app.git" } },
  harness: { id: "claude-code" },
};

describe("blueprint runtime.envFrom / runtime.kubernetes", () => {
  it("decodes a pre-feature spec (no fields) to empty defaults", () => {
    const blueprint = parseWorkspaceBlueprint(baseSpec);
    expect(blueprint.runtime.envFrom).toEqual([]);
    expect(blueprint.runtime.kubernetes).toEqual({});
  });

  it("keeps a valid ordered source list and service account verbatim", () => {
    const blueprint = parseWorkspaceBlueprint({
      ...baseSpec,
      runtime: {
        envFrom: [
          { kind: "secret", name: "app-env" },
          { kind: "configmap", name: "app.config" },
        ],
        kubernetes: { serviceAccountName: "mend-workspaces" },
      },
    });
    expect(blueprint.runtime.envFrom).toEqual([
      { kind: "secret", name: "app-env" },
      { kind: "configmap", name: "app.config" },
    ]);
    expect(blueprint.runtime.kubernetes.serviceAccountName).toBe("mend-workspaces");
  });

  it.each([
    [{ kind: "volume", name: "app-env" }, /kind/],
    [{ kind: "secret", name: "App-Env" }, /DNS-1123/],
    [{ kind: "secret", name: "-leading" }, /DNS-1123/],
    [{ kind: "secret", name: "a".repeat(254) }, /253/],
  ])("rejects the invalid source %j", (source, message) => {
    expect(() => parseWorkspaceBlueprint({ ...baseSpec, runtime: { envFrom: [source] } })).toThrow(
      message,
    );
  });

  it("rejects a non-DNS service account name", () => {
    expect(() =>
      parseWorkspaceBlueprint({
        ...baseSpec,
        runtime: { kubernetes: { serviceAccountName: "Not Valid" } },
      }),
    ).toThrow(/DNS-1123/);
  });
});

const spec = (overrides: {
  envFrom?: readonly { kind: string; name: string }[];
  serviceAccountName?: string;
  family?: string;
}) => ({
  runtime: {
    envFrom: overrides.envFrom ?? [],
    kubernetes:
      overrides.serviceAccountName === undefined
        ? {}
        : { serviceAccountName: overrides.serviceAccountName },
  },
  target: { runtime: { family: overrides.family ?? "auto" } },
});

describe("runtimeEnvReferencesRefusal", () => {
  it("passes a request with no cluster references on any family", () => {
    expect(runtimeEnvReferencesRefusal(spec({}), "docker")).toBeNull();
    expect(runtimeEnvReferencesRefusal(spec({ family: "cloudflare" }), "docker")).toBeNull();
  });

  it("passes cluster references when the effective family is Kubernetes", () => {
    expect(
      runtimeEnvReferencesRefusal(
        spec({ envFrom: [{ kind: "secret", name: "app-env" }], family: "k8s" }),
        "docker",
      ),
    ).toBeNull();
    // auto resolves to the install default.
    expect(
      runtimeEnvReferencesRefusal(spec({ envFrom: [{ kind: "secret", name: "app-env" }] }), "k3s"),
    ).toBeNull();
    expect(runtimeEnvReferencesRefusal(spec({ serviceAccountName: "dev-sa" }), "k8s")).toBeNull();
  });

  it("refuses on a non-Kubernetes effective family, naming every unresolvable input", () => {
    const refusal = runtimeEnvReferencesRefusal(
      spec({
        envFrom: [
          { kind: "secret", name: "app-env" },
          { kind: "configmap", name: "app-config" },
        ],
        serviceAccountName: "dev-sa",
      }),
      "docker",
    );
    expect(refusal).toContain("secret/app-env");
    expect(refusal).toContain("configmap/app-config");
    expect(refusal).toContain("serviceAccount dev-sa");
    expect(refusal).toContain("'docker'");
  });

  it("refuses an explicit non-Kubernetes family even on a Kubernetes install", () => {
    expect(
      runtimeEnvReferencesRefusal(
        spec({ envFrom: [{ kind: "secret", name: "app-env" }], family: "cloudflare" }),
        "k8s",
      ),
    ).not.toBeNull();
  });
});
