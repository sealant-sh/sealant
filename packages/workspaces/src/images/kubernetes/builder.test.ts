/**
 * BuildKit-Job builder against an in-memory API: pinned manifests, the exact buildctl argv, the
 * lifecycle (create → wait → digest → cleanup), adoption/retry of a previous Job, readable failures
 * carrying the log tail, and a registry that never reports the manifest.
 */
import type { V1ConfigMap, V1Job, V1Pod, V1Secret } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";

import type { RegistryClient } from "../../registry/index.js";
import { cases } from "../../runtime/docker-runtime-adapter.golden-fixture.js";
import type { CreateOutcome, DeleteOutcome } from "../../runtime/kubernetes/api.js";
import type { KubernetesBuildApi } from "./api.js";
import {
  buildctlArgs,
  buildJob,
  buildJobName,
  dockerConfigJson,
  KubernetesImageBuildError,
  KubernetesWorkspaceImageBuilder,
  LABEL_PLAN_HASH,
} from "./builder.js";
import { kubernetesBuildConfigSchema, type KubernetesBuildConfig } from "./config.js";

const config: KubernetesBuildConfig = kubernetesBuildConfigSchema.parse({
  namespace: "sealant-builds",
  pushRegistry: "zot.sealant.svc:5000",
  registryInsecure: true,
  registryCredentials: { username: "u", password: "p" },
  resources: { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "4", memory: "8Gi" } },
  timeoutMs: 60_000,
});

interface Fake extends KubernetesBuildApi {
  readonly jobs: Map<string, V1Job>;
  readonly configMaps: Map<string, V1ConfigMap>;
  readonly secrets: Map<string, V1Secret>;
  readonly log: string[];
  nextStatus: "succeeded" | "failed" | "running";
  podLog: string;
}

const fake = (): Fake => {
  const jobs = new Map<string, V1Job>();
  const configMaps = new Map<string, V1ConfigMap>();
  const secrets = new Map<string, V1Secret>();
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
  const api: Fake = {
    namespace: "sealant-builds",
    jobs,
    configMaps,
    secrets,
    log,
    nextStatus: "succeeded",
    podLog: "",
    createJob: async (job) => create(jobs, "job", job),
    getJob: async (name) => {
      const job = jobs.get(name);
      if (job === undefined) {
        return undefined;
      }
      const status =
        job.status ??
        (api.nextStatus === "succeeded"
          ? { succeeded: 1 }
          : api.nextStatus === "failed"
            ? { failed: 1 }
            : { active: 1 });
      return { ...job, status };
    },
    deleteJob: async (name) => del(jobs, "job", name),
    listJobs: async () => [...jobs.values()],
    createConfigMap: async (cm) => create(configMaps, "configmap", cm),
    deleteConfigMap: async (name) => del(configMaps, "configmap", name),
    createSecret: async (secret) => create(secrets, "secret", secret),
    deleteSecret: async (name) => del(secrets, "secret", name),
    listPods: async (): Promise<V1Pod[]> => [{ metadata: { name: "build-pod-1" } }],
    readPodLogTail: async () => api.podLog,
  };
  return api;
};

const registry = (
  digest: string | null,
): RegistryClient & { headManifest: ReturnType<typeof vi.fn> } =>
  ({
    ping: vi.fn(),
    repositoryExists: vi.fn(),
    listTags: vi.fn(),
    getManifest: vi.fn(),
    headManifest: vi.fn(async () => digest),
    discoverExtensions: vi.fn(),
    publishOciImage: vi.fn(async () => {
      throw new Error("the Kubernetes builder must never call publishOciImage");
    }),
  }) as unknown as RegistryClient & { headManifest: ReturnType<typeof vi.fn> };

const builderFor = (
  api: Fake,
  registryClient: RegistryClient,
  overrides: Partial<KubernetesBuildConfig> = {},
) =>
  new KubernetesWorkspaceImageBuilder({
    config: { ...config, ...overrides },
    api,
    registryClient,
    pollIntervalMs: 1,
    readSecretFile: async (path) => Buffer.from(`key-at-${path}`),
  });

const spec = cases.gitSource.blueprint;

describe("buildctlArgs / buildJob", () => {
  const planned = new KubernetesWorkspaceImageBuilder({
    config,
    api: fake(),
    registryClient: registry("sha256:x"),
  }).plan(spec);

  it("pins the buildctl invocation", () => {
    expect(
      buildctlArgs({
        name: "build-abc",
        config,
        labels: {},
        planned,
        imageReference: "zot.sealant.svc:5000/sealant/ws:tag",
        secretIds: ["dotfiles_git_key"],
        hasDockerConfig: true,
      }),
    ).toEqual([
      "build",
      "--frontend",
      "dockerfile.v0",
      "--local",
      "context=/workspace",
      "--local",
      "dockerfile=/workspace",
      "--opt",
      "filename=Containerfile",
      ...(planned.osFamily === "arch" ? ["--opt", "platform=linux/amd64"] : []),
      "--secret",
      "id=dotfiles_git_key,src=/run/secrets/build/dotfiles_git_key",
      "--output",
      "type=image,name=zot.sealant.svc:5000/sealant/ws:tag,push=true,registry.insecure=true",
    ]);
  });

  it("builds a rootless, non-privileged Job with no SA token and bounded lifetime", () => {
    const job = buildJob({
      name: "build-abc",
      config,
      labels: { a: "b" },
      planned,
      imageReference: "r/x:y",
      secretIds: [],
      hasDockerConfig: true,
    });
    expect(job.spec?.backoffLimit).toBe(0);
    expect(job.spec?.ttlSecondsAfterFinished).toBe(3600);
    expect(job.spec?.activeDeadlineSeconds).toBe(60);
    const pod = job.spec?.template.spec;
    expect(pod?.restartPolicy).toBe("Never");
    expect(pod?.automountServiceAccountToken).toBe(false);
    expect(pod?.serviceAccountName).toBe("sealant-build");
    expect(pod?.securityContext).toEqual({
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: "Unconfined" },
      appArmorProfile: { type: "Unconfined" },
    });
    const container = pod?.containers[0];
    expect(container?.image).toBe("moby/buildkit:v0.20.2-rootless");
    expect(container?.command).toEqual(["buildctl-daemonless.sh"]);
    expect(container?.securityContext?.privileged).toBe(false);
    // newuidmap needs escalation (file caps); privileged stays off.
    expect(container?.securityContext?.allowPrivilegeEscalation).toBe(true);
    expect(container?.env).toEqual([
      { name: "BUILDKITD_FLAGS", value: "--oci-worker-no-process-sandbox" },
      { name: "DOCKER_CONFIG", value: "/run/secrets/docker" },
    ]);
    expect(pod?.volumes?.map((v) => v.name)).toEqual([
      "context",
      "buildkit",
      "buildkitd-config",
      "docker-config",
    ]);
    expect(pod?.containers[0]?.volumeMounts?.map((m) => m.mountPath)).toContain(
      "/home/user/.config/buildkit",
    );
    expect(JSON.stringify(job)).not.toContain("u:p");
  });

  it("names Jobs deterministically from plan hash + repository + tag", () => {
    expect(buildJobName("h", "r", "t")).toBe(buildJobName("h", "r", "t"));
    expect(buildJobName("h", "r", "t")).not.toBe(buildJobName("h2", "r", "t"));
    expect(buildJobName("h", "r", "t")).toMatch(/^build-[0-9a-f]{12}$/);
  });

  it("renders a docker config with basic auth for the push registry", () => {
    expect(JSON.parse(dockerConfigJson("reg:5000", { username: "u", password: "p" }))).toEqual({
      auths: { "reg:5000": { auth: Buffer.from("u:p").toString("base64") } },
    });
  });
});

describe("KubernetesWorkspaceImageBuilder", () => {
  it("creates inputs + Job, waits, resolves the digest from the registry, cleans inputs", async () => {
    const api = fake();
    const reg = registry("sha256:deadbeef");
    const builder = builderFor(api, reg);

    const result = await builder.buildAndPublish({
      spec,
      repository: "sealant/ws",
      tag: "v1",
      buildId: "job_1",
    });

    expect(result.publishedImage).toEqual({
      repository: "sealant/ws",
      tag: "v1",
      reference: "zot.sealant.svc:5000/sealant/ws:v1",
      digestReference: "zot.sealant.svc:5000/sealant/ws@sha256:deadbeef",
      digest: "sha256:deadbeef",
    });
    expect(result.build.artifacts).toEqual([
      {
        kind: "oci-image",
        name: "sealant/ws:v1",
        reference: "zot.sealant.svc:5000/sealant/ws:v1",
        loader: "registry",
      },
    ]);
    expect(result.build.metadata?.planHash).toBe(builder.plan(spec).planHash);
    expect(reg.headManifest).toHaveBeenCalledWith("sealant/ws", "v1");
    expect(api.jobs.size).toBe(1);
    // Inputs are gone; the Job stays for its TTL.
    expect(api.configMaps.size).toBe(0);
    expect(api.secrets.size).toBe(0);
    const job = [...api.jobs.values()][0];
    expect(job?.metadata?.labels?.[LABEL_PLAN_HASH]).toBe(builder.plan(spec).planHash.slice(0, 63));
    expect(job?.metadata?.labels?.["sealant.sh/build-id"]).toBe("job_1");
    const cm = api.log.find((l) => l.startsWith("create configmap"));
    expect(cm).toBeDefined();
  });

  it("adopts a running Job for the same plan on redelivery", async () => {
    const api = fake();
    const builder = builderFor(api, registry("sha256:1"));
    await builder.buildAndPublish({ spec, repository: "r", tag: "t" });
    const creates = api.log.filter((l) => l.startsWith("create job")).length;

    await builder.buildAndPublish({ spec, repository: "r", tag: "t" });

    expect(api.log.filter((l) => l.startsWith("create job")).length).toBe(creates + 1);
    expect(api.log.filter((l) => l.startsWith("delete job")).length).toBe(0);
    expect(api.jobs.size).toBe(1);
  });

  it("replaces a failed Job for the same plan and refuses one with foreign labels", async () => {
    const api = fake();
    const builder = builderFor(api, registry("sha256:1"));
    const name = buildJobName(builder.plan(spec).planHash, "r", "t");
    api.jobs.set(name, {
      metadata: { name, labels: { [LABEL_PLAN_HASH]: builder.plan(spec).planHash.slice(0, 63) } },
      status: { failed: 1 },
    });

    await builder.buildAndPublish({ spec, repository: "r", tag: "t" });
    expect(api.log).toContain(`delete job ${name}`);

    api.jobs.set(name, { metadata: { name, labels: { [LABEL_PLAN_HASH]: "other" } } });
    await expect(builder.buildAndPublish({ spec, repository: "r", tag: "t" })).rejects.toThrow(
      /refusing to adopt/,
    );
  });

  it("fails readably with the log tail when the Job fails, and cleans inputs", async () => {
    const api = fake();
    api.nextStatus = "failed";
    api.podLog = "error: failed to solve: rpc error\n";
    const builder = builderFor(api, registry("sha256:1"));
    await expect(builder.buildAndPublish({ spec, repository: "r", tag: "t" })).rejects.toThrow(
      /Build Job build-[0-9a-f]+ failed\.\n--- buildkit log tail ---\nerror: failed to solve/,
    );
    expect(api.configMaps.size).toBe(0);
  });

  it("fails when the registry never reports the pushed manifest", async () => {
    const api = fake();
    const builder = builderFor(api, registry(null));
    await expect(
      builder.buildAndPublish({ spec, repository: "r", tag: "t" }),
    ).rejects.toBeInstanceOf(KubernetesImageBuildError);
  });

  it("times out a Job that never completes", async () => {
    const api = fake();
    api.nextStatus = "running";
    let now = 0;
    const builder = new KubernetesWorkspaceImageBuilder({
      config: { ...config, timeoutMs: 60_000 },
      api,
      registryClient: registry("sha256:1"),
      pollIntervalMs: 1,
      now: () => (now += 30_000),
    });
    await expect(builder.buildAndPublish({ spec, repository: "r", tag: "t" })).rejects.toThrow(
      /exceeded 60000 ms/,
    );
  });

  it("projects build secrets from worker files into a Secret and mounts them", async () => {
    const api = fake();
    const builder = builderFor(api, registry("sha256:1"));
    const withDotfiles = {
      ...spec,
      sources: {
        ...spec.sources,
        inputs: [
          {
            id: "dotfiles",
            kind: "git" as const,
            purpose: "dotfiles" as const,
            provider: "generic" as const,
            url: "https://github.com/me/dotfiles.git",
            authRef: "/keys/dotfiles_ed25519",
          },
        ],
      },
    };
    const planned = builder.plan(withDotfiles);
    expect(planned.imagePlan.buildSecrets.map((s) => s.id)).toEqual(["dotfiles_git_key"]);
    await builder.buildAndPublish({ spec: withDotfiles, repository: "r", tag: "t" });
    const created = api.log.find((l) => l.startsWith("create secret") && l.endsWith("-secrets"));
    expect(created).toBeDefined();
    const job = [...api.jobs.values()][0];
    expect(job?.spec?.template.spec?.containers[0]?.args).toContain(
      "id=dotfiles_git_key,src=/run/secrets/build/dotfiles_git_key",
    );
    expect(api.secrets.size).toBe(0);
  });
});
