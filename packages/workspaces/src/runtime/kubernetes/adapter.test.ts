/**
 * Adapter lifecycle against an in-memory Kubernetes API: create, adopt on redelivery, replace a
 * dead Pod, readiness through the control channel, credential files over that channel, idempotent
 * stop, and readable failures. No cluster, no network.
 */
import type { V1Pod, V1Secret, V1Service } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";

import { cases } from "../docker-runtime-adapter.golden-fixture.js";
import type { RuntimeAdapterLaunchInput } from "../runtime-adapter.js";
import { KubernetesRuntimeAdapter, supportForKubernetes, type ControlChannel } from "./adapter.js";
import type { CreateOutcome, DeleteOutcome, KubernetesApi } from "./api.js";
import { kubernetesRuntimeConfigSchema, type KubernetesRuntimeConfig } from "./config.js";
import type { CertificateObject } from "./manifests.js";
import { workspaceResourceNames } from "./names.js";

const config: KubernetesRuntimeConfig = kubernetesRuntimeConfigSchema.parse({
  namespace: "ns",
  volumeMappings: [
    { logicalRoot: "/var/lib/mend/store", claimName: "mend-store" },
    { logicalRoot: "/run/sealant/sockets/_dotfiles", claimName: "sealant-staging" },
  ],
  resources: { requests: { cpu: "1", memory: "1Gi" }, limits: { cpu: "2", memory: "2Gi" } },
  certManagerIssuer: { name: "issuer" },
  readinessTimeoutMs: 2000,
  gvisorRuntimeClass: "gvisor",
});

const clientTls = { caPath: "/tls/ca.crt", certPath: "/tls/tls.crt", keyPath: "/tls/tls.key" };

interface FakeCluster extends KubernetesApi {
  readonly pods: Map<string, V1Pod>;
  readonly services: Map<string, V1Service>;
  readonly secrets: Map<string, V1Secret>;
  readonly certificates: Map<string, CertificateObject>;
  /** Make newly created pods reach this phase on the next read. */
  nextPhase: string;
  readonly log: string[];
}

const fakeCluster = (): FakeCluster => {
  const pods = new Map<string, V1Pod>();
  const services = new Map<string, V1Service>();
  const secrets = new Map<string, V1Secret>();
  const certificates = new Map<string, CertificateObject>();
  const log: string[] = [];
  const create = <T extends { metadata?: { name?: string | undefined } | undefined }>(
    store: Map<string, T>,
    kind: string,
    object: T,
  ): CreateOutcome<T> => {
    const name = object.metadata?.name ?? "";
    log.push(`create ${kind} ${name}`);
    if (store.has(name)) {
      return { outcome: "conflict" };
    }
    store.set(name, object);
    return { outcome: "created", object };
  };
  const del = (store: Map<string, unknown>, kind: string, name: string): DeleteOutcome => {
    log.push(`delete ${kind} ${name}`);
    return store.delete(name) ? "deleted" : "not-found";
  };
  const cluster: FakeCluster = {
    namespace: "ns",
    pods,
    services,
    secrets,
    certificates,
    nextPhase: "Running",
    log,
    createPod: async (pod) => create(pods, "pod", pod),
    getPod: async (name) => {
      const pod = pods.get(name);
      if (pod === undefined) {
        return undefined;
      }
      return { ...pod, status: pod.status ?? { phase: cluster.nextPhase } };
    },
    deletePod: async (name) => del(pods, "pod", name),
    listPods: async () => [...pods.values()],
    createService: async (service) => create(services, "service", service),
    getService: async (name) => services.get(name),
    deleteService: async (name) => del(services, "service", name),
    listServices: async () => [...services.values()],
    createSecret: async (secret) => create(secrets, "secret", secret),
    replaceSecret: async (secret) => {
      log.push(`replace secret ${secret.metadata?.name ?? ""}`);
      secrets.set(secret.metadata?.name ?? "", secret);
      return secret;
    },
    getSecret: async (name) => secrets.get(name),
    deleteSecret: async (name) => del(secrets, "secret", name),
    listSecrets: async () => [...secrets.values()],
    createCertificate: async (certificate) => create(certificates, "certificate", certificate),
    getCertificate: async (name) => certificates.get(name),
    deleteCertificate: async (name) => del(certificates, "certificate", name),
    listCertificates: async () => [...certificates.values()],
  };
  return cluster;
};

const controlChannel = (): ControlChannel & {
  health: ReturnType<typeof vi.fn>;
  writeCredentialFiles: ReturnType<typeof vi.fn>;
} => ({
  health: vi.fn(async () => undefined),
  writeCredentialFiles: vi.fn(async () => undefined),
});

const adapterFor = (
  cluster: FakeCluster,
  channel: ControlChannel,
  overrides: Partial<KubernetesRuntimeConfig> = {},
) =>
  new KubernetesRuntimeAdapter({
    id: "k8s",
    config: { ...config, ...overrides },
    api: cluster,
    clientTls,
    controlChannel: channel,
    pollIntervalMs: 1,
  });

const launchInput: RuntimeAdapterLaunchInput = {
  ...cases.mendMount,
  dotfilesArchiveDir: undefined,
  secretEnvDir: undefined,
  secretEnv: { OPENAI_API_KEY: "sk" },
  credentialFiles: [{ path: "$HOME/.codex/auth.json", contentBase64: "e30=", mode: "600" }],
  workspaceId: "ws_1",
};

describe("KubernetesRuntimeAdapter", () => {
  it("refuses unsupported requirements with readable reasons", () => {
    const adapter = adapterFor(fakeCluster(), controlChannel(), { gvisorRuntimeClass: undefined });
    expect(adapter.supports({ blueprint: cases.dind.blueprint })).toMatchObject({
      supported: false,
      reason: "unsupported-runtime-requirement",
    });
    expect(adapter.supports({ blueprint: cases.mendMount.blueprint })).toMatchObject({
      supported: false,
      message: expect.stringContaining("runsc"),
    });
    expect(
      adapter.supports({
        blueprint: {
          ...cases.gitSource.blueprint,
          target: {
            ...cases.gitSource.blueprint.target,
            runtime: { family: "docker", mode: "require" },
          },
        },
      }),
    ).toMatchObject({ supported: false, reason: "unsupported-runtime" });
    expect(adapter.supports({ blueprint: cases.gitSource.blueprint })).toEqual({ supported: true });
  });

  it("creates every object, waits for Running + health, writes credential files, reports ready", async () => {
    const cluster = fakeCluster();
    const channel = controlChannel();
    const adapter = adapterFor(cluster, channel);

    const result = await adapter.launch(launchInput);

    const names = workspaceResourceNames("run-golden-2");
    expect(result).toEqual({
      adapter: "k8s",
      resourceId: names.pod,
      reference: names.pod,
      status: "ready",
      endpoint: `wss://${names.service}.ns.svc:7443/control`,
    });
    expect([...cluster.pods.keys()]).toEqual([names.pod]);
    expect([...cluster.services.keys()]).toEqual([names.service]);
    expect([...cluster.certificates.keys()]).toEqual([names.certificate]);
    // The launch Secret is deleted once the daemon is up; the env Secret is absent (no secret env vars).
    expect([...cluster.secrets.keys()]).toEqual([]);
    expect(cluster.log).toContain(`delete secret ${names.launchSecret}`);
    expect(channel.health).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "websocket",
        url: `wss://${names.service}.ns.svc:7443/control`,
        tls: { ...clientTls, servername: `${names.service}.ns.svc` },
      }),
    );
    expect(channel.writeCredentialFiles).toHaveBeenCalledTimes(1);
    const pod = cluster.pods.get(names.pod);
    expect(JSON.stringify(pod)).not.toContain("sk");
    expect(pod?.spec?.runtimeClassName).toBe("gvisor");
  });

  it("adopts existing objects on a redelivered launch instead of duplicating them", async () => {
    const cluster = fakeCluster();
    const adapter = adapterFor(cluster, controlChannel());
    await adapter.launch(launchInput);
    const before = cluster.log.length;

    const again = await adapter.launch(launchInput);

    expect(again.status).toBe("ready");
    expect(cluster.log.slice(before)).toContain(`create pod ${again.resourceId}`);
    expect(cluster.pods.size).toBe(1);
    expect(cluster.services.size).toBe(1);
  });

  it("refuses to adopt an object that carries another run's labels", async () => {
    const cluster = fakeCluster();
    const names = workspaceResourceNames("run-golden-2");
    cluster.pods.set(names.pod, {
      metadata: { name: names.pod, labels: { "sealant.sh/run-id": "someone-else" } },
      status: { phase: "Running" },
    });
    const adapter = adapterFor(cluster, controlChannel());
    await expect(adapter.launch(launchInput)).rejects.toThrow(/refusing to adopt/);
  });

  it("replaces a dead Pod from an earlier attempt at the same run", async () => {
    const cluster = fakeCluster();
    const names = workspaceResourceNames("run-golden-2");
    const adapter = adapterFor(cluster, controlChannel());
    await adapter.launch(launchInput);
    const dead = cluster.pods.get(names.pod);
    cluster.pods.set(names.pod, { ...dead, status: { phase: "Failed" } });

    const result = await adapter.launch(launchInput);

    expect(result.status).toBe("ready");
    expect(cluster.log.filter((line) => line === `delete pod ${names.pod}`).length).toBe(1);
    expect(cluster.pods.get(names.pod)?.status).toBeUndefined();
  });

  it("fails readably when the Pod dies before readiness and cleans up", async () => {
    const cluster = fakeCluster();
    cluster.nextPhase = "Failed";
    const adapter = adapterFor(cluster, controlChannel());
    await expect(adapter.launch(launchInput)).rejects.toThrow(/ended before it became ready/);
    expect(cluster.pods.size).toBe(0);
    expect(cluster.services.size).toBe(0);
    expect(cluster.certificates.size).toBe(0);
  });

  it("fails readably when the control channel never answers", async () => {
    const cluster = fakeCluster();
    const channel = controlChannel();
    channel.health.mockRejectedValue(new Error("ECONNREFUSED"));
    const adapter = adapterFor(cluster, channel, { readinessTimeoutMs: 1000 });
    await expect(adapter.launch(launchInput)).rejects.toThrow(/did not answer over wss:/);
    expect(cluster.pods.size).toBe(0);
  });

  it("refuses launch material that exceeds the Secret budget when nothing is staged", async () => {
    const cluster = fakeCluster();
    const adapter = adapterFor(cluster, controlChannel(), { launchSecretBudgetBytes: 64 * 1024 });
    const big = Buffer.alloc(70 * 1024, 1).toString("base64");
    const input: RuntimeAdapterLaunchInput = {
      ...launchInput,
      blueprint: {
        ...launchInput.blueprint,
        runtime: {
          ...launchInput.blueprint.runtime,
          dotfilesArchives: [{ data: big, bootstrap: true }],
        },
      },
    };
    await expect(adapter.launch(input)).rejects.toMatchObject({
      code: "launch-material-too-large",
    });
  });

  it("mounts staged dotfiles from the staging claim when the stager placed them there", async () => {
    const cluster = fakeCluster();
    const adapter = adapterFor(cluster, controlChannel());
    await adapter.launch({
      ...launchInput,
      dotfilesArchiveDir: "/run/sealant/sockets/_dotfiles/sealant-dotfiles-run-golden-2",
    });
    const pod = [...cluster.pods.values()][0];
    const mount = pod?.spec?.containers[0]?.volumeMounts?.find(
      (m) => m.mountPath === "/run/sealant/dotfiles",
    );
    // Launch material is the first intent, so the staging claim is the first volume.
    expect(mount).toEqual({
      name: "store-0",
      mountPath: "/run/sealant/dotfiles",
      subPath: "sealant-dotfiles-run-golden-2",
      readOnly: true,
    });
    const env = pod?.spec?.containers[0]?.env?.find(
      (e) => e.name === "SEALANT_DOTFILES_ARCHIVE_DIR",
    );
    expect(env?.value).toBe("/run/sealant/dotfiles");
  });

  it("rejects a mount outside the configured roots with the adapter error code", async () => {
    const cluster = fakeCluster();
    const adapter = adapterFor(cluster, controlChannel());
    const input: RuntimeAdapterLaunchInput = {
      ...launchInput,
      blueprint: {
        ...launchInput.blueprint,
        sources: {
          ...launchInput.blueprint.sources,
          mounts: [{ hostPath: "/etc", mountPath: "/mnt/etc", readOnly: true }],
        },
      },
    };
    await expect(adapter.launch(input)).rejects.toMatchObject({
      code: "unsupported-runtime-requirement",
    });
    expect(cluster.pods.size).toBe(0);
  });

  it("stops idempotently: every object deleted, not-found the second time", async () => {
    const cluster = fakeCluster();
    const adapter = adapterFor(cluster, controlChannel());
    const launched = await adapter.launch(launchInput);

    const first = await adapter.stop({ resourceId: launched.resourceId });
    expect(first).toEqual({ adapter: "k8s", resourceId: launched.resourceId, outcome: "stopped" });

    // A Pod mid-termination (deletionTimestamp set, still visible) already counts as gone: the
    // stop that INITIATED teardown was the one that reports "stopped".
    cluster.pods.set(launched.resourceId, {
      metadata: { name: launched.resourceId, deletionTimestamp: new Date() },
    });
    const during = await adapter.stop({ resourceId: launched.resourceId });
    expect(during.outcome).toBe("not-found");
    cluster.pods.delete(launched.resourceId);
    expect(
      cluster.pods.size + cluster.services.size + cluster.secrets.size + cluster.certificates.size,
    ).toBe(0);

    const second = await adapter.stop({ resourceId: launched.resourceId });
    expect(second.outcome).toBe("not-found");
  });

  it("needs a run id for deterministic names", async () => {
    const adapter = adapterFor(fakeCluster(), controlChannel());
    await expect(adapter.launch({ ...launchInput, runId: undefined })).rejects.toThrow(/run id/);
  });
});

describe("cluster env references belt (until worker-side resolution ships)", () => {
  it("refuses runtime.envFrom and kubernetes.serviceAccountName with an honest message", () => {
    const withEnvFrom = {
      ...cases.gitSource.blueprint,
      runtime: {
        ...cases.gitSource.blueprint.runtime,
        envFrom: [{ kind: "secret" as const, name: "app-env" }],
      },
    };
    expect(supportForKubernetes("k8s", config, { blueprint: withEnvFrom })).toMatchObject({
      supported: false,
      reason: "unsupported-runtime-requirement",
    });
    const withServiceAccount = {
      ...cases.gitSource.blueprint,
      runtime: {
        ...cases.gitSource.blueprint.runtime,
        kubernetes: { serviceAccountName: "dev-sa" },
      },
    };
    expect(supportForKubernetes("k8s", config, { blueprint: withServiceAccount })).toMatchObject({
      supported: false,
      reason: "unsupported-runtime-requirement",
    });
  });
});
