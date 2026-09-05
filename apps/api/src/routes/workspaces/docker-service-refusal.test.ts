import { describe, expect, it } from "vitest";

import { dockerServiceRefusal } from "./workspaces.module.js";

/**
 * The create-time gate for `tooling.services.docker`: refuse synchronously on an install whose
 * workspace runtime cannot serve it, naming the operator knob, and never on one that can.
 */
const spec = (input: { readonly docker?: boolean; readonly family?: string }) => ({
  tooling: {
    services: input.docker === undefined ? undefined : { docker: { enabled: input.docker } },
  },
  target: { runtime: { family: input.family ?? "auto" } },
});

describe("dockerServiceRefusal", () => {
  it("passes a request that does not ask for Docker, on any install", () => {
    const off = { defaultAdapterFamily: "k8s", kubernetesDockerEnabled: false };
    expect(dockerServiceRefusal(spec({}), off)).toBeNull();
    expect(dockerServiceRefusal(spec({ docker: false }), off)).toBeNull();
    expect(dockerServiceRefusal(spec({ family: "cloudflare" }), off)).toBeNull();
  });

  it("passes Docker on the Docker runtime and on Kubernetes once the operator enabled it", () => {
    expect(
      dockerServiceRefusal(spec({ docker: true }), {
        defaultAdapterFamily: "docker",
        kubernetesDockerEnabled: false,
      }),
    ).toBeNull();
    expect(
      dockerServiceRefusal(spec({ docker: true, family: "docker" }), {
        defaultAdapterFamily: "k8s",
        kubernetesDockerEnabled: false,
      }),
    ).toBeNull();
    expect(
      dockerServiceRefusal(spec({ docker: true }), {
        defaultAdapterFamily: "k8s",
        kubernetesDockerEnabled: true,
      }),
    ).toBeNull();
    expect(
      dockerServiceRefusal(spec({ docker: true, family: "k3s" }), {
        defaultAdapterFamily: "docker",
        kubernetesDockerEnabled: true,
      }),
    ).toBeNull();
  });

  it("refuses Docker on a Kubernetes install that has not enabled it, naming the knob", () => {
    const refusal = dockerServiceRefusal(spec({ docker: true }), {
      defaultAdapterFamily: "k8s",
      kubernetesDockerEnabled: false,
    });
    expect(refusal).toContain("SEALANT_K8S_DOCKER_ENABLED");
    expect(refusal).toContain("workspaces.docker.enabled");
  });

  it("refuses Docker on a runtime family that has no Docker service at all", () => {
    expect(
      dockerServiceRefusal(spec({ docker: true, family: "cloudflare" }), {
        defaultAdapterFamily: "docker",
        kubernetesDockerEnabled: true,
      }),
    ).toContain("'cloudflare'");
  });
});
