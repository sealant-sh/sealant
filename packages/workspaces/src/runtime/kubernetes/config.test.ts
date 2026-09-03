import { describe, expect, it } from "vitest";

import {
  KubernetesRuntimeConfigError,
  kubernetesRuntimeConfigFromEnv,
  volumeMappingsSchema,
} from "./config.js";

const base = {
  SEALANT_K8S_NAMESPACE: "sealant-workspaces",
  SEALANT_K8S_VOLUME_MAPPINGS: JSON.stringify([
    { logicalRoot: "/var/lib/mend/store", claimName: "mend-store" },
  ]),
  SEALANT_K8S_CERT_ISSUER_NAME: "sealant-internal",
};

describe("kubernetesRuntimeConfigFromEnv", () => {
  it("is undefined when the namespace is unset (Docker worker)", () => {
    expect(kubernetesRuntimeConfigFromEnv({})).toBeUndefined();
  });

  it("parses a minimal configuration with defaults", () => {
    const config = kubernetesRuntimeConfigFromEnv(base);
    expect(config).toMatchObject({
      namespace: "sealant-workspaces",
      workspaceServiceAccount: "sealant-workspace",
      controlPort: 7443,
      resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "4", memory: "8Gi" } },
      certManagerIssuer: { name: "sealant-internal", kind: "Issuer", group: "cert-manager.io" },
      topologySpread: true,
      managedBy: "sealant",
    });
  });

  it("requires the mappings and the issuer once the namespace is set", () => {
    expect(() => kubernetesRuntimeConfigFromEnv({ SEALANT_K8S_NAMESPACE: "ns" })).toThrow(
      KubernetesRuntimeConfigError,
    );
    expect(() =>
      kubernetesRuntimeConfigFromEnv({ ...base, SEALANT_K8S_CERT_ISSUER_NAME: undefined }),
    ).toThrow(/SEALANT_K8S_CERT_ISSUER_NAME/);
  });

  it("rejects malformed JSON, overlapping roots, whole-root paths and duplicate claims", () => {
    expect(() =>
      kubernetesRuntimeConfigFromEnv({ ...base, SEALANT_K8S_VOLUME_MAPPINGS: "{" }),
    ).toThrow(/not valid JSON/);
    expect(
      volumeMappingsSchema.safeParse([
        { logicalRoot: "/a", claimName: "x" },
        { logicalRoot: "/a/b", claimName: "y" },
      ]).success,
    ).toBe(false);
    expect(
      volumeMappingsSchema.safeParse([
        { logicalRoot: "/a", claimName: "x" },
        { logicalRoot: "/b", claimName: "x" },
      ]).success,
    ).toBe(false);
    expect(volumeMappingsSchema.safeParse([{ logicalRoot: "/", claimName: "x" }]).success).toBe(
      false,
    );
    expect(
      volumeMappingsSchema.safeParse([{ logicalRoot: "/a/../b", claimName: "x" }]).success,
    ).toBe(false);
  });

  it("validates quantities, names and ports", () => {
    expect(() =>
      kubernetesRuntimeConfigFromEnv({ ...base, SEALANT_K8S_DEFAULT_CPU_LIMIT: "lots" }),
    ).toThrow(/quantity/);
    expect(() =>
      kubernetesRuntimeConfigFromEnv({ ...base, SEALANT_K8S_NAMESPACE: "Bad_NS" }),
    ).toThrow(/DNS-1123/);
    expect(() =>
      kubernetesRuntimeConfigFromEnv({ ...base, SEALANT_K8S_CONTROL_PORT: 70000 }),
    ).toThrow(KubernetesRuntimeConfigError);
  });

  it("requires the staging root to be one of the mapped roots", () => {
    expect(() =>
      kubernetesRuntimeConfigFromEnv({
        ...base,
        SEALANT_K8S_STAGING_LOGICAL_ROOT: "/var/lib/sealant/staging",
      }),
    ).toThrow(/must also appear in SEALANT_K8S_VOLUME_MAPPINGS/);
    const config = kubernetesRuntimeConfigFromEnv({
      ...base,
      SEALANT_K8S_VOLUME_MAPPINGS: JSON.stringify([
        { logicalRoot: "/var/lib/mend/store", claimName: "mend-store" },
        { logicalRoot: "/var/lib/sealant/staging", claimName: "sealant-staging" },
      ]),
      SEALANT_K8S_STAGING_LOGICAL_ROOT: "/var/lib/sealant/staging",
      SEALANT_K8S_STAGING_MOUNT_PATH: "/mnt/staging",
    });
    expect(config?.staging).toEqual({
      logicalRoot: "/var/lib/sealant/staging",
      mountPath: "/mnt/staging",
    });
  });

  it("keeps the Docker service off unless the operator enables it, with a pinned image", () => {
    expect(kubernetesRuntimeConfigFromEnv(base)?.docker).toEqual({
      enabled: false,
      image: "docker:28.5.2-dind-rootless",
      graphSize: "20Gi",
      resources: {
        requests: { cpu: "100m", memory: "256Mi" },
        limits: { cpu: "2", memory: "2Gi" },
      },
    });
    expect(
      kubernetesRuntimeConfigFromEnv({
        ...base,
        SEALANT_K8S_DOCKER_ENABLED: true,
        SEALANT_K8S_DOCKER_IMAGE: "docker:29.7.2-dind-rootless",
        SEALANT_K8S_DOCKER_GRAPH_SIZE: "10Gi",
        SEALANT_K8S_DOCKER_MEMORY_LIMIT: "4Gi",
      })?.docker,
    ).toEqual({
      enabled: true,
      image: "docker:29.7.2-dind-rootless",
      graphSize: "10Gi",
      resources: {
        requests: { cpu: "100m", memory: "256Mi" },
        limits: { cpu: "2", memory: "4Gi" },
      },
    });
    expect(() =>
      kubernetesRuntimeConfigFromEnv({ ...base, SEALANT_K8S_DOCKER_GRAPH_SIZE: "big" }),
    ).toThrow(/quantity/);
  });
});
