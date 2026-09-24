/**
 * Adapter lifecycle against an in-memory Kubernetes API: create, adopt on redelivery, replace a
 * dead Pod, readiness through the control channel, credential files over that channel, idempotent
 * stop, and readable failures. No cluster, no network.
 */
import type { V1Pod, V1PodStatus } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";

import { cases } from "../docker-runtime-adapter.golden-fixture.js";
import type { RuntimeAdapterLaunchInput } from "../runtime-adapter.js";
import { KubernetesRuntimeAdapter, supportForKubernetes, type ControlChannel } from "./adapter.js";
import { kubernetesRuntimeConfigSchema, type KubernetesRuntimeConfig } from "./config.js";
import { fakeCluster, type FakeCluster } from "./fake-cluster.fixture.js";
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
      message: expect.stringContaining("SEALANT_K8S_DOCKER_ENABLED"),
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

  it("serves the Docker service as a sidecar in a user-namespaced Pod once the operator enables it", async () => {
    const dockerLaunch: RuntimeAdapterLaunchInput = {
      ...cases.dind,
      dotfilesArchiveDir: undefined,
      secretEnvDir: undefined,
      workspaceId: "ws_dind",
    };
    // Default deployment: refused at launch, nothing created.
    const refused = fakeCluster();
    await expect(adapterFor(refused, controlChannel()).launch(dockerLaunch)).rejects.toMatchObject({
      code: "unsupported-runtime-requirement",
    });
    expect(refused.pods.size).toBe(0);

    const cluster = fakeCluster();
    const adapter = adapterFor(cluster, controlChannel(), {
      docker: { ...config.docker, enabled: true },
    });
    expect(adapter.supports({ blueprint: cases.dind.blueprint })).toEqual({ supported: true });
    const result = await adapter.launch(dockerLaunch);
    expect(result.status).toBe("ready");
    const pod = cluster.pods.get(result.resourceId);
    expect(pod?.spec?.hostUsers).toBe(false);
    expect(pod?.spec?.initContainers?.map((c) => c.name)).toEqual(["docker"]);
    expect(pod?.spec?.initContainers?.[0]?.securityContext?.privileged).toBe(true);
    expect(pod?.spec?.containers[0]?.securityContext?.privileged).toBe(false);
    expect(pod?.spec?.containers[0]?.env).toContainEqual({
      name: "DOCKER_HOST",
      value: "unix:///run/docker/docker.sock",
    });
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

  it("launches a capture source on an emptyDir with the token only in the launch Secret", async () => {
    const cluster = fakeCluster();
    const channel = controlChannel();
    const adapter = adapterFor(cluster, channel);
    expect(adapter.supports({ blueprint: cases.capture.blueprint })).toEqual({ supported: true });

    const result = await adapter.launch({ ...cases.capture, secretEnvDir: undefined });

    const names = workspaceResourceNames("run-golden-4");
    expect(result.status).toBe("ready");
    const pod = cluster.pods.get(names.pod);
    expect(pod?.spec?.volumes?.map((volume) => volume.name)).toEqual([
      "run-sealant",
      "tls",
      "workspace",
      "launch",
    ]);
    expect(pod?.spec?.volumes?.find((volume) => volume.name === "workspace")).toEqual({
      name: "workspace",
      emptyDir: {},
    });
    expect(pod?.spec?.containers[0]?.volumeMounts).toContainEqual({
      name: "workspace",
      mountPath: "/workspace",
    });
    expect(pod?.spec?.volumes?.some((volume) => volume.persistentVolumeClaim !== undefined)).toBe(
      false,
    );
    const env = Object.fromEntries(
      (pod?.spec?.containers[0]?.env ?? []).map((entry) => [entry.name, entry.value]),
    );
    expect(env["SEALANT_WORKSPACE_SOURCE"]).toBe("capture");
    expect(env["SEALANT_CAPTURE_ENDPOINT"]).toBe("https://mend.example.com/session/s1");
    expect(env["SEALANT_CAPTURE_WORKTREE_ID"]).toBe("wt_1");
    expect(env["SEALANT_SECRET_ENV_FILE"]).toBe("/run/sealant/launch/env.json");
    expect(JSON.stringify(pod)).not.toContain("mst_secret");
    expect(JSON.stringify(pod)).not.toContain("SEALANT_CAPTURE_TOKEN");
    // The launch Secret carried env.json and was deleted once the daemon answered.
    expect(cluster.log).toContain(`create secret ${names.launchSecret}`);
    expect(cluster.log).toContain(`delete secret ${names.launchSecret}`);
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

  it("names the container that will not start and quotes its log tail", async () => {
    const cluster = fakeCluster();
    // A crash-looping Docker sidecar: the Pod stays Pending, the container is `waiting` with its
    // last exit in `lastState`, and the kubelet still serves what it printed.
    cluster.nextStatus = {
      phase: "Pending",
      initContainerStatuses: [
        {
          name: "docker",
          image: "docker:28.5.2-dind-rootless",
          imageID: "",
          ready: false,
          restartCount: 3,
          state: { waiting: { reason: "CrashLoopBackOff" } },
          lastState: { terminated: { exitCode: 1, reason: "Error" } },
        },
      ],
    };
    const names = workspaceResourceNames("run-golden-3");
    cluster.logTails.set(`${names.pod}/docker`, "sh: can't create /etc/subuid: Permission denied");
    const adapter = adapterFor(cluster, controlChannel(), {
      docker: { ...config.docker, enabled: true },
      readinessTimeoutMs: 1000,
    });
    await expect(
      adapter.launch({ ...cases.dind, dotfilesArchiveDir: undefined, secretEnvDir: undefined }),
    ).rejects.toThrow(
      /container 'docker' CrashLoopBackOff[\s\S]*--- docker log tail ---[\s\S]*Permission denied/,
    );
    expect(cluster.pods.size).toBe(0);
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
          mounts: [{ hostPath: "/etc", mountPath: "/mnt/etc", readOnly: true, bindable: false }],
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

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

/** A bindable object: opted in with the workspace-env label, not platform-managed. */
const optIn = { "sealant.sh/workspace-env": "true" };

const withRuntime = (
  overrides: Partial<RuntimeAdapterLaunchInput["blueprint"]["runtime"]>,
): RuntimeAdapterLaunchInput => ({
  ...launchInput,
  blueprint: {
    ...launchInput.blueprint,
    runtime: { ...launchInput.blueprint.runtime, ...overrides },
  },
});

describe("cluster env sources (worker-side resolution)", () => {
  it("gates an explicit ServiceAccount on the allowlist; envFrom itself is supported", () => {
    const withEnvFrom = {
      ...cases.gitSource.blueprint,
      runtime: {
        ...cases.gitSource.blueprint.runtime,
        envFrom: [{ kind: "secret" as const, name: "app-env" }],
      },
    };
    expect(supportForKubernetes("k8s", config, { blueprint: withEnvFrom })).toEqual({
      supported: true,
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
      message: expect.stringContaining("SEALANT_K8S_ALLOWED_WORKSPACE_SERVICE_ACCOUNTS"),
    });
    expect(
      supportForKubernetes(
        "k8s",
        { ...config, allowedWorkspaceServiceAccounts: ["dev-sa"] },
        { blueprint: withServiceAccount },
      ),
    ).toEqual({ supported: true });
  });

  it("resolves both kinds with bound keys as the weakest layer on both lanes", async () => {
    const cluster = fakeCluster();
    cluster.secrets.set("app-env", {
      metadata: { name: "app-env", labels: optIn },
      data: { APP_TOKEN: b64("s3cret"), OPENAI_API_KEY: b64("bound-must-lose") },
    });
    cluster.configmaps.set("app-config", {
      metadata: { name: "app-config", labels: optIn },
      data: { APP_MODE: "staging", APP_REGION: "eu-1" },
    });
    const channel = controlChannel();
    // The launch Secret is deleted once the daemon is ready; capture it at readiness time.
    let envJson: string | undefined;
    channel.health.mockImplementation(async () => {
      const names = workspaceResourceNames("run-golden-2");
      const data = cluster.secrets.get(names.launchSecret)?.data?.["env.json"];
      envJson = data === undefined ? undefined : Buffer.from(data, "base64").toString("utf8");
    });
    const adapter = adapterFor(cluster, channel);

    await adapter.launch(
      withRuntime({
        envFrom: [
          { kind: "secret", name: "app-env" },
          { kind: "configmap", name: "app-config" },
        ],
        env: { APP_MODE: "prod" },
      }),
    );

    // Secret lane: bound keys merge under the caller's secret env — OPENAI_API_KEY stays "sk".
    expect(envJson).toBeDefined();
    expect(JSON.parse(envJson ?? "{}")).toEqual({ APP_TOKEN: "s3cret", OPENAI_API_KEY: "sk" });
    // Plain lane: bound ConfigMap keys are present but shadowed by explicit caller env.
    const pod = [...cluster.pods.values()][0];
    const env = pod?.spec?.containers[0]?.env ?? [];
    expect(env.filter((entry) => entry.name === "APP_MODE")).toEqual([
      { name: "APP_MODE", value: "prod" },
    ]);
    expect(env).toContainEqual({ name: "APP_REGION", value: "eu-1" });
    // No bound secret value ever lands in the Pod spec.
    expect(JSON.stringify(pod)).not.toContain("s3cret");
  });

  it("fails readably, naming the binding, when a bound object is missing or not opted in", async () => {
    const cluster = fakeCluster();
    const adapter = adapterFor(cluster, controlChannel());
    await expect(
      adapter.launch(withRuntime({ envFrom: [{ kind: "secret", name: "absent" }] })),
    ).rejects.toMatchObject({
      code: "env-source-unresolvable",
      message: expect.stringContaining("secret/absent"),
    });

    cluster.secrets.set("unlabeled", { metadata: { name: "unlabeled" }, data: {} });
    await expect(
      adapter.launch(withRuntime({ envFrom: [{ kind: "secret", name: "unlabeled" }] })),
    ).rejects.toThrow(/not opted in/);
    expect(cluster.pods.size).toBe(0);
  });

  it("refuses platform-managed objects even when they carry the opt-in label", async () => {
    const cluster = fakeCluster();
    cluster.secrets.set("smuggled", {
      metadata: {
        name: "smuggled",
        labels: { ...optIn, "app.kubernetes.io/managed-by": "sealant" },
      },
      data: { X: b64("y") },
    });
    const adapter = adapterFor(cluster, controlChannel());
    await expect(
      adapter.launch(withRuntime({ envFrom: [{ kind: "secret", name: "smuggled" }] })),
    ).rejects.toThrow(/managed by the platform/);
  });

  it("runs the Pod under an allowlisted explicit ServiceAccount, token still unmounted", async () => {
    const cluster = fakeCluster();
    const adapter = adapterFor(cluster, controlChannel(), {
      allowedWorkspaceServiceAccounts: ["irsa-agents"],
    });
    await adapter.launch(withRuntime({ kubernetes: { serviceAccountName: "irsa-agents" } }));
    const pod = [...cluster.pods.values()][0];
    expect(pod?.spec?.serviceAccountName).toBe("irsa-agents");
    expect(pod?.spec?.automountServiceAccountToken).toBe(false);
  });
});

const podWith = (
  name: string,
  status: V1PodStatus,
  metadata: Partial<NonNullable<V1Pod["metadata"]>> = {},
): V1Pod => ({ metadata: { name, ...metadata }, status });

const terminatedWorkspace = (exitCode: number, reason?: string) => ({
  name: "workspace",
  image: "image",
  imageID: "image-id",
  ready: false,
  restartCount: 0,
  state: { terminated: { exitCode, ...(reason === undefined ? {} : { reason }) } },
});

describe("KubernetesRuntimeAdapter.inspect", () => {
  it("maps each Pod state: running, pending, exited with exit code and log tail, terminating, stuck, missing", async () => {
    const cluster = fakeCluster();
    const now = Date.parse("2026-09-14T12:00:00.000Z");
    const adapter = new KubernetesRuntimeAdapter({
      id: "k8s",
      config,
      api: cluster,
      clientTls,
      controlChannel: controlChannel(),
      pollIntervalMs: 1,
      now: () => now,
      listCoalesceMs: 0,
    });
    cluster.pods.set("pod-live", podWith("pod-live", { phase: "Running" }));
    cluster.pods.set("pod-pending", podWith("pod-pending", { phase: "Pending" }));
    cluster.pods.set(
      "pod-dead",
      podWith("pod-dead", {
        phase: "Failed",
        containerStatuses: [terminatedWorkspace(137, "OOMKilled")],
      }),
    );
    cluster.logTails.set("pod-dead/workspace", "last words");
    cluster.pods.set("pod-done", podWith("pod-done", { phase: "Succeeded" }));
    // The main container died while the Pod still reports Running (a sidecar keeps it up).
    cluster.pods.set(
      "pod-half-dead",
      podWith("pod-half-dead", { phase: "Running", containerStatuses: [terminatedWorkspace(1)] }),
    );
    // Deleted 10 s ago with a 30 s grace: the stop that asked for it settles the row.
    cluster.pods.set(
      "pod-stopping",
      podWith(
        "pod-stopping",
        { phase: "Running" },
        { deletionTimestamp: new Date(now - 10_000), deletionGracePeriodSeconds: 30 },
      ),
    );
    // Deleted 60 s ago with a 30 s grace and still listed: the node stopped answering.
    cluster.pods.set(
      "pod-stuck",
      podWith(
        "pod-stuck",
        { phase: "Running" },
        { deletionTimestamp: new Date(now - 60_000), deletionGracePeriodSeconds: 30 },
      ),
    );

    await expect(adapter.inspect({ resourceId: "pod-live" })).resolves.toEqual({
      state: "running",
      platformState: "Running",
    });
    await expect(adapter.inspect({ resourceId: "pod-pending" })).resolves.toEqual({
      state: "running",
      platformState: "Pending",
    });
    await expect(adapter.inspect({ resourceId: "pod-dead" })).resolves.toEqual({
      state: "exited",
      exitCode: 137,
      detail:
        "container 'workspace' exited with 137 (OOMKilled)\n--- workspace log tail ---\nlast words",
    });
    await expect(adapter.inspect({ resourceId: "pod-done" })).resolves.toEqual({
      state: "exited",
      detail: "phase Succeeded",
    });
    await expect(adapter.inspect({ resourceId: "pod-half-dead" })).resolves.toEqual({
      state: "exited",
      exitCode: 1,
      detail: "container 'workspace' exited with 1",
    });
    await expect(adapter.inspect({ resourceId: "pod-stopping" })).resolves.toEqual({
      state: "running",
      platformState: "Running",
    });
    await expect(adapter.inspect({ resourceId: "pod-stuck" })).resolves.toEqual({
      state: "exited",
      detail: expect.stringMatching(
        /^Pod has been Terminating since 2026-09-14T11:59:00\.000Z; its 30 s grace period passed/,
      ),
    });
    await expect(adapter.inspect({ resourceId: "pod-gone" })).resolves.toEqual({
      state: "missing",
    });
  });

  it("answers a burst of inspects from one LIST of the managed selector", async () => {
    const cluster = fakeCluster();
    const adapter = adapterFor(cluster, controlChannel());
    cluster.pods.set("pod-a", podWith("pod-a", { phase: "Running" }));
    cluster.pods.set("pod-b", podWith("pod-b", { phase: "Failed" }));

    const results = await Promise.all(
      ["pod-a", "pod-b", "pod-c"].map((resourceId) => adapter.inspect({ resourceId })),
    );

    expect(results.map((result) => result.state)).toEqual(["running", "exited", "missing"]);
    expect(cluster.log.filter((line) => line === "list pods")).toHaveLength(1);
  });

  it("does not hand a failed LIST to the next inspect", async () => {
    const cluster = fakeCluster();
    const adapter = adapterFor(cluster, controlChannel());
    const listPods = vi
      .spyOn(cluster, "listPods")
      .mockRejectedValueOnce(new Error("apiserver unavailable"));
    cluster.pods.set("pod-a", podWith("pod-a", { phase: "Running" }));

    await expect(adapter.inspect({ resourceId: "pod-a" })).rejects.toThrow(/apiserver unavailable/);
    await expect(adapter.inspect({ resourceId: "pod-a" })).resolves.toMatchObject({
      state: "running",
    });
    expect(listPods).toHaveBeenCalledTimes(2);
  });
});

describe("KubernetesRuntimeAdapter.watchExits", () => {
  it("reports a terminal phase, a dead workspace container and a deletion once each, and honours the id filter", () => {
    const cluster = fakeCluster();
    const adapter = adapterFor(cluster, controlChannel());
    const onExit = vi.fn();
    const watch = adapter.watchExits({ onExit, resourceIds: ["pod-a", "pod-b", "pod-c"] });

    expect(cluster.watches).toHaveLength(1);
    const stream = cluster.watches[0];
    expect(stream?.selector).toBe(
      "app.kubernetes.io/managed-by=sealant,app.kubernetes.io/component=workspace",
    );

    // The replayed current state: nothing has ended.
    stream?.handlers.onEvent("ADDED", podWith("pod-a", { phase: "Running" }));
    stream?.handlers.onEvent("ADDED", podWith("pod-b", { phase: "Pending" }));
    stream?.handlers.onEvent("BOOKMARK", podWith("pod-a", {}));
    expect(onExit).not.toHaveBeenCalled();

    // A Pod being deleted within its grace is not an exit.
    stream?.handlers.onEvent(
      "MODIFIED",
      podWith("pod-a", { phase: "Running" }, { deletionTimestamp: new Date() }),
    );
    expect(onExit).not.toHaveBeenCalled();

    stream?.handlers.onEvent(
      "MODIFIED",
      podWith("pod-b", { phase: "Failed", containerStatuses: [terminatedWorkspace(137, "Error")] }),
    );
    // The same Pod again (a status refresh, then its deletion): reported once.
    stream?.handlers.onEvent(
      "MODIFIED",
      podWith("pod-b", { phase: "Failed", containerStatuses: [terminatedWorkspace(137, "Error")] }),
    );
    stream?.handlers.onEvent("DELETED", podWith("pod-b", { phase: "Failed" }));
    // A forced delete: the Pod vanishes while Running.
    stream?.handlers.onEvent("DELETED", podWith("pod-a", { phase: "Running" }));
    // Not watched.
    stream?.handlers.onEvent("DELETED", podWith("pod-other", { phase: "Running" }));
    // A relaunch reused pod-b's name and died again: reported again.
    stream?.handlers.onEvent(
      "MODIFIED",
      podWith("pod-b", { phase: "Running", containerStatuses: [terminatedWorkspace(2)] }),
    );

    expect(onExit.mock.calls).toEqual([
      [
        {
          resourceId: "pod-b",
          result: {
            state: "exited",
            exitCode: 137,
            detail: "container 'workspace' exited with 137 (Error)",
          },
        },
      ],
      [{ resourceId: "pod-a", result: { state: "missing" } }],
      [
        {
          resourceId: "pod-b",
          result: { state: "exited", exitCode: 2, detail: "container 'workspace' exited with 2" },
        },
      ],
    ]);

    watch.close();
    expect(stream?.closed).toBe(true);
  });

  it("reopens a watch that ended cleanly at once, a failed one after backoff, and never after close", async () => {
    vi.useFakeTimers();
    try {
      const cluster = fakeCluster();
      const adapter = adapterFor(cluster, controlChannel());
      const onExit = vi.fn();
      const onError = vi.fn();
      const watch = adapter.watchExits({ onExit, onError });

      // The apiserver's own timeout: a clean end, reopened after the minimum delay, no error.
      cluster.watches[0]?.handlers.onEnd(undefined);
      expect(cluster.watches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cluster.watches).toHaveLength(2);
      expect(onError).not.toHaveBeenCalled();

      // A failure: reported, reopened after 1 s, then 2 s.
      cluster.watches[1]?.handlers.onEnd(new Error("connection reset"));
      expect(onError).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cluster.watches).toHaveLength(3);
      cluster.watches[2]?.handlers.onEnd(new Error("connection reset"));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(cluster.watches).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(cluster.watches).toHaveLength(4);

      // An event proves health: the next drop retries promptly again.
      cluster.watches[3]?.handlers.onEvent("ADDED", podWith("pod-a", { phase: "Running" }));
      cluster.watches[3]?.handlers.onEnd(new Error("connection reset"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cluster.watches).toHaveLength(5);

      watch.close();
      expect(cluster.watches[4]?.closed).toBe(true);
      cluster.watches[4]?.handlers.onEnd(undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(cluster.watches).toHaveLength(5);
      expect(onExit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("KubernetesRuntimeAdapter.stop", () => {
  it("returns at once for a Pod the apiserver no longer has, still clearing its siblings", async () => {
    const cluster = fakeCluster();
    const adapter = adapterFor(cluster, controlChannel());
    const launched = await adapter.launch(launchInput);
    cluster.log.length = 0;
    // A forced delete (`kubectl delete --force --grace-period=0`) removed the Pod already.
    cluster.pods.delete(launched.resourceId);

    const result = await adapter.stop({ resourceId: launched.resourceId, fence: true });

    expect(result.outcome).toBe("not-found");
    expect(cluster.log.filter((line) => line.startsWith("delete pod"))).toEqual([]);
    expect(cluster.services.size + cluster.secrets.size + cluster.certificates.size).toBe(0);
  });

  it("waits for the Pod to leave the apiserver, no longer than its grace plus the margin", async () => {
    const cluster = fakeCluster();
    cluster.deletesLinger = true;
    let now = 0;
    const adapter = new KubernetesRuntimeAdapter({
      id: "k8s",
      config,
      api: cluster,
      clientTls,
      controlChannel: controlChannel(),
      pollIntervalMs: 1,
      stopTerminationMarginMs: 10_000,
      now: () => now,
    });
    const launched = await adapter.launch(launchInput);
    const polls: number[] = [];
    const getPod = cluster.getPod;
    vi.spyOn(cluster, "getPod").mockImplementation(async (name) => {
      polls.push(now);
      if (polls.length === 4) {
        cluster.pods.delete(name);
      }
      now += 1_000;
      return getPod(name);
    });

    const result = await adapter.stop({ resourceId: launched.resourceId });

    expect(result.outcome).toBe("stopped");
    // The pre-delete read, then three polls before the Pod was gone.
    expect(polls).toEqual([0, 1_000, 2_000, 3_000]);
    expect(cluster.log.filter((line) => line.startsWith("delete pod"))).toEqual([
      `delete pod ${launched.resourceId}`,
    ]);
  });

  it("fences with a one-second grace and fails readably when the Pod never leaves", async () => {
    const cluster = fakeCluster();
    cluster.deletesLinger = true;
    let now = 0;
    const adapter = new KubernetesRuntimeAdapter({
      id: "k8s",
      config,
      api: cluster,
      clientTls,
      controlChannel: controlChannel(),
      pollIntervalMs: 1,
      stopTerminationMarginMs: 4_000,
      now: () => now,
    });
    const launched = await adapter.launch(launchInput);
    const getPod = cluster.getPod;
    vi.spyOn(cluster, "getPod").mockImplementation(async (name) => {
      now += 1_000;
      return getPod(name);
    });

    await expect(adapter.stop({ resourceId: launched.resourceId, fence: true })).rejects.toThrow(
      /still Terminating 5000 ms after its delete/,
    );
    expect(cluster.log.filter((line) => line.startsWith("delete pod"))).toEqual([
      `delete pod ${launched.resourceId} grace=1`,
    ]);
    // The row is not settled by a stop that could not confirm: the Pod is still listed.
    expect(cluster.pods.has(launched.resourceId)).toBe(true);
  });
});
