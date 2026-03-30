import { describe, expect, it } from "vitest";

import { K8sRuntimeAdapter } from "./k8s-runtime-adapter.js";

describe("K8sRuntimeAdapter", () => {
  it("returns adapter-unavailable support state", () => {
    const adapter = new K8sRuntimeAdapter();
    const support = adapter.supports({
      blueprint: {
        sources: {
          workspace: {
            url: "https://github.com/example/repo.git",
            ref: "main",
          },
        },
        access: {
          ssh: {
            enabled: false,
          },
        },
        runtime: {
          env: {},
          workingDirectory: "/workspace/repo",
          persistence: "ephemeral",
          ociRuntime: "runc",
          network: {
            outbound: true,
          },
        },
        target: {
          runtime: {
            family: "k8s",
            mode: "require",
          },
        },
      },
    });

    expect(support).toEqual({
      supported: false,
      reason: "adapter-unavailable",
      message: "The Kubernetes runtime adapter launch path is not implemented yet.",
    });
  });
});
