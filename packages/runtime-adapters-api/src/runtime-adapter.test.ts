import { describe, expect, it } from "vitest";

import {
  parseRuntimeAdapterSupport,
  selectRuntimeAdapter,
  type RuntimeAdapter,
} from "./runtime-adapter.js";

const createBlueprint = (overrides: Record<string, unknown> = {}) => {
  return {
    access: {
      ssh: {
        enabled: false,
      },
    },
    runtime: {
      env: {},
      workingDirectory: "/workspace/repo",
      persistence: "ephemeral",
      network: {
        outbound: true,
      },
    },
    target: {
      runtime: {
        family: "auto",
        mode: "prefer",
      },
    },
    ...overrides,
  };
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
  };
};

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
