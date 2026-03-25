import { describe, expect, it } from "vitest";

import { K3sRuntimeAdapter } from "./k3s-runtime-adapter.js";

describe("K3sRuntimeAdapter", () => {
  it("returns adapter-unavailable support state", () => {
    const adapter = new K3sRuntimeAdapter();
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
            family: "k3s",
            mode: "require",
          },
        },
      },
    });

    expect(support).toEqual({
      supported: false,
      reason: "adapter-unavailable",
      message: "The K3s runtime adapter launch path is not implemented yet.",
    });
  });
});
