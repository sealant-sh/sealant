import { describe, expect, it, vi } from "vitest";

import {
  isRemovalPending,
  isRemovalRefusal,
  parseRuntimeAdapterSupport,
  parseRuntimeAdapterSupportInput,
  removalPending,
  removalRefused,
  selectRuntimeAdapter,
  type RuntimeAdapter,
} from "./runtime-adapter.js";

/** The parts of a blueprint a test changes; each nested object merges over the base's. */
interface BlueprintOverrides {
  readonly sources?: {
    readonly workspace?: Record<string, unknown>;
    readonly inputs?: unknown;
    readonly [key: string]: unknown;
  };
  readonly access?: { readonly ssh?: Record<string, unknown>; readonly [key: string]: unknown };
  readonly runtime?: {
    readonly env?: Record<string, string>;
    readonly network?: Record<string, unknown>;
    readonly [key: string]: unknown;
  };
  readonly target?: {
    readonly os?: Record<string, unknown>;
    readonly runtime?: Record<string, unknown>;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

const createBlueprint = (overrides: BlueprintOverrides = {}) => {
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
  const override = overrides;

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

describe("selectRuntimeAdapter", () => {
  const brokered = {
    networkPolicy: { mode: "standard", policyHash: "h" },
    brokeredSecrets: [
      {
        secretId: "psec_1",
        name: "VERCEL_TOKEN",
        placeholder: "mend_sec_0123456789abcdef",
        secretRef: "ref-1",
        headerName: "Authorization",
        bindHosts: ["api.vercel.com"],
      },
    ],
  };

  it("never hands a brokered secret to a runtime with no egress proxy, whatever its adapter says", () => {
    const supports = vi.fn(() => ({ supported: true as const }));
    expect(() =>
      selectRuntimeAdapter({
        blueprint: createBlueprint({
          ...brokered,
          target: { runtime: { family: "k8s", mode: "require" } },
        }),
        adapters: [createAdapter("k8s", supports)],
        defaultAdapterId: "k8s",
      }),
    ).toThrow(/cannot broker secrets/);
    expect(supports).not.toHaveBeenCalled();
  });

  it("falls back from a preferred runtime that cannot enforce the policy to one that can", () => {
    const selection = selectRuntimeAdapter({
      blueprint: createBlueprint({
        ...brokered,
        target: { runtime: { family: "boat", mode: "prefer" } },
      }),
      adapters: [
        createAdapter("boat", () => ({ supported: true })),
        createAdapter("docker", () => ({ supported: true })),
      ],
      defaultAdapterId: "docker",
    });
    expect(selection.adapterId).toBe("docker");
  });

  it("hands a launch that names a control scope only to a runtime that gives its executors one", () => {
    const k8sSupports = vi.fn(() => ({ supported: true as const }));
    const scoped = (id: RuntimeAdapter["id"]): RuntimeAdapter => ({
      ...createAdapter(id, () => ({ supported: true })),
      hasControlScopes: true,
    });
    // Preferred and willing, but the caller's sockets in the scope would never be reached there.
    const selection = selectRuntimeAdapter({
      blueprint: createBlueprint({ target: { runtime: { family: "k8s", mode: "prefer" } } }),
      adapters: [createAdapter("k8s", k8sSupports), scoped("docker")],
      defaultAdapterId: "docker",
      controlScope: "mend-exec-1",
    });
    expect(selection.adapterId).toBe("docker");
    expect(k8sSupports).not.toHaveBeenCalled();

    expect(() =>
      selectRuntimeAdapter({
        blueprint: createBlueprint({
          runtime: { executorSockets: { capture: true, session: false } },
          target: { runtime: { family: "boat", mode: "require" } },
        }),
        adapters: [createAdapter("boat", () => ({ supported: true }))],
        defaultAdapterId: "boat",
      }),
    ).toThrow(/no control scope at \/run\/sealant, so it cannot take runtime\.executorSockets/);
  });

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

describe("what a removal's failure says of the runtime", () => {
  it("tells a removal the provider accepted and has not finished from a refusal and from an unknown outcome, through any chain of causes", () => {
    const pending = removalPending(new Error("the provider is still deleting it"));
    const refused = removalRefused(new Error("the provider did not act"));
    const unknown = new Error("socket hang up");
    expect([isRemovalPending(pending), isRemovalRefusal(pending)]).toEqual([true, false]);
    expect([isRemovalPending(refused), isRemovalRefusal(refused)]).toEqual([false, true]);
    expect([isRemovalPending(unknown), isRemovalRefusal(unknown)]).toEqual([false, false]);
    // As the stop paths wrap it.
    const wrapped = new Error("removing the runtime failed", {
      cause: new Error("stop failed", { cause: pending }),
    });
    expect(isRemovalPending(wrapped)).toBe(true);
    expect(isRemovalRefusal(wrapped)).toBe(false);
    for (const other of [undefined, null, "close-pending", { removalPending: "true" }])
      expect(isRemovalPending(other)).toBe(false);
  });
});
