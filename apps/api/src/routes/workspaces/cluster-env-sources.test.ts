import { parseWorkspaceBlueprint } from "@sealant/validators";
import { describe, expect, it } from "vitest";

/**
 * Shape pins for `runtime.envFrom` + `runtime.kubernetes` (cluster env sources). Their create-time
 * refusal on every runtime but Kubernetes is the runtime table's (`runtime-support.test.ts`).
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
