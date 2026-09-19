import { describe, expect, it } from "vitest";

import {
  parseRuntimeAdapterSupport,
  parseRuntimeAdapterSupportInput,
  requirePublishedImage,
  selectRuntimeAdapter,
  type RuntimeAdapter,
} from "./runtime-adapter.js";

const createBlueprint = (overrides: Record<string, unknown> = {}) => {
  const base = {
    version: "1",
    sources: {
      workspace: {
        kind: "git" as const,
        provider: "generic" as const,
        url: "https://github.com/example/repo.git",
        ref: "main",
      },
      inputs: [] as const,
    },
    harness: {
      id: "opencode" as const,
    },
    access: {
      ssh: {
        enabled: false,
        listenPort: 2222,
      },
    },
    tooling: {
      packages: [] as const,
    },
    customization: {
      defaultShell: "bash" as const,
      dotfilesManager: "auto" as const,
      dotfilesTarget: "home" as const,
      applyDotfiles: true,
      dotfilesBootstrap: true,
    },
    lifecycle: {
      setup: [] as const,
      startup: {
        steps: [] as const,
        foreground: {
          kind: "harness" as const,
        },
      },
    },
    runtime: {
      env: {} as Record<string, string>,
      workspaceRoot: "/workspace",
      workingDirectory: "/workspace/repo",
      persistence: "ephemeral" as const,
      ociRuntime: "runc" as const,
      network: {
        outbound: true,
      },
    },
    target: {
      os: {
        family: "nix" as const,
        mode: "prefer" as const,
      },
      runtime: {
        family: "auto" as const,
        mode: "prefer" as const,
      },
    },
  };
  const override = overrides as any;

  return parseRuntimeAdapterSupportInput({
    blueprint: {
      ...base,
      ...override,
      sources: {
        ...base.sources,
        ...override.sources,
        workspace: {
          ...base.sources.workspace,
          ...override.sources?.workspace,
        },
        inputs: override.sources?.inputs ?? base.sources.inputs,
      },
      access: {
        ...base.access,
        ...override.access,
        ssh: {
          ...base.access.ssh,
          ...override.access?.ssh,
        },
      },
      runtime: {
        ...base.runtime,
        ...override.runtime,
        env: {
          ...base.runtime.env,
          ...override.runtime?.env,
        },
        network: {
          ...base.runtime.network,
          ...override.runtime?.network,
        },
      },
      target: {
        ...base.target,
        ...override.target,
        os: {
          ...base.target.os,
          ...override.target?.os,
        },
        runtime: {
          ...base.target.runtime,
          ...override.target?.runtime,
        },
      },
    },
  }).blueprint;
};

const createAdapter = (
  id: RuntimeAdapter["id"],
  supports: RuntimeAdapter["supports"],
): RuntimeAdapter => {
  return {
    id,
    supports,
    launch: async () => {
      throw new Error("not used in selector tests");
    },
    stop: async () => {
      throw new Error("not used in selector tests");
    },
  };
};

describe("requirePublishedImage", () => {
  const image = {
    repository: "sealant/workspaces/demo",
    tag: "plan-abc",
    reference: "127.0.0.1:5000/sealant/workspaces/demo:plan-abc",
    digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:abc",
    digest: "sha256:abc",
  };

  it("hands an adapter that runs the built image that image", () => {
    expect(requirePublishedImage({ publishedImage: image }, "docker")).toBe(image);
  });

  it("refuses, naming the adapter, when the worker built none", () => {
    // Only a runtime that declares `builtImage: "unused"` is launched without one. Reaching an
    // adapter that runs the image with none is a miswired pipeline, never a silent empty image.
    expect(() => requirePublishedImage({}, "k8s")).toThrowError(
      expect.objectContaining({
        code: "published-image-required",
        message: expect.stringContaining("k8s adapter"),
      }),
    );
  });
});

describe("selectRuntimeAdapter", () => {
  it("uses the default adapter when runtime target is auto", () => {
    const blueprint = createBlueprint();
    const selection = selectRuntimeAdapter({
      blueprint,
      adapters: [
        createAdapter("docker", () => ({ supported: true })),
        createAdapter("k8s", () => ({ supported: true })),
      ],
      defaultAdapterId: "docker",
    });

    expect(selection.adapterId).toBe("docker");
  });

  it("falls back to the default adapter when preferred runtime is unavailable", () => {
    const blueprint = createBlueprint({
      target: {
        runtime: {
          family: "k3s",
          mode: "prefer",
        },
      },
    });

    const selection = selectRuntimeAdapter({
      blueprint,
      adapters: [createAdapter("docker", () => ({ supported: true }))],
      defaultAdapterId: "docker",
    });

    expect(selection.adapterId).toBe("docker");
  });

  it("throws when required runtime is unavailable", () => {
    const blueprint = createBlueprint({
      target: {
        runtime: {
          family: "k8s",
          mode: "require",
        },
      },
    });

    expect(() =>
      selectRuntimeAdapter({
        blueprint,
        adapters: [createAdapter("docker", () => ({ supported: true }))],
        defaultAdapterId: "docker",
      }),
    ).toThrow("No runtime adapter is registered for target.runtime.family 'k8s'.");
  });

  it("propagates support failures from the selected adapter", () => {
    const blueprint = createBlueprint({
      target: {
        runtime: {
          family: "docker",
          mode: "prefer",
        },
      },
    });

    expect(() =>
      selectRuntimeAdapter({
        blueprint,
        adapters: [
          createAdapter("docker", () =>
            parseRuntimeAdapterSupport({
              supported: false,
              reason: "unsupported-access-mode",
              message: "SSH is not supported by this adapter.",
            }),
          ),
        ],
        defaultAdapterId: "docker",
      }),
    ).toThrow("SSH is not supported by this adapter.");
  });
});
