import { describe, expect, it } from "vitest";

import { K8sRuntimeAdapter } from "./k8s-runtime-adapter.js";

describe("K8sRuntimeAdapter", () => {
  it("returns adapter-unavailable support state", () => {
    const adapter = new K8sRuntimeAdapter();
    const support = adapter.supports({
      blueprint: {
        version: "1",
        sources: {
          sandbox: {
            kind: "git",
            provider: "generic",
            url: "https://github.com/example/repo.git",
            ref: "main",
          },
          inputs: [],
        },
        harness: {
          id: "opencode",
        },
        access: {
          ssh: {
            enabled: false,
            listenPort: 2222,
          },
        },
        tooling: {
          packages: [],
        },
        customization: {
          defaultShell: "bash",
          dotfilesManager: "auto",
          dotfilesTarget: "home",
          applyDotfiles: true,
          dotfilesBootstrap: true,
        },
        lifecycle: {
          setup: [],
          startup: {
            steps: [],
            foreground: {
              kind: "harness",
            },
          },
        },
        runtime: {
          env: {},
          credentialRefs: [],
          sandboxRoot: "/sandbox",
          workingDirectory: "/sandbox/repo",
          persistence: "ephemeral",
          ociRuntime: "runc",
          network: {
            outbound: true,
          },
        },
        target: {
          os: {
            family: "nix",
            mode: "prefer",
          },
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
