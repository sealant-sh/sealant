/**
 * Kubernetes image builder: one rootless BuildKit Job per build, pushing straight to the
 * registry (design §D7). No Docker socket anywhere.
 *
 *   1. Plan with the shared compiler (`planWorkspaceImageBuild`): same Containerfile, same plan
 *      hash as the Docker path.
 *   2. Job name = `build-<hash(planHash + repository + tag)>`, so a redelivered build job adopts
 *      the running Job instead of starting a second one.
 *   3. Build context (Containerfile + plan JSON) goes in a ConfigMap; build secrets (ssh keys the
 *      compiler references by worker path) and the registry docker-config go in Secrets; none of
 *      them appear in the Job spec.
 *   4. `buildctl-daemonless.sh build … --output type=image,name=<ref>,push=true`.
 *   5. Wait for the Job to succeed (or fail with the log tail in the error), then resolve the
 *      pushed digest with the registry client's `headManifest` — the registry is the source of
 *      truth, not the Job's stdout.
 *   6. Delete the ConfigMap and Secrets; the Job stays for `ttlSecondsAfterFinished` so the log
 *      can still be read, then Kubernetes reaps it.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { V1ConfigMap, V1Job, V1Secret } from "@kubernetes/client-node";
import type { NewWorkspace, WorkspaceBuild } from "@sealant/validators";

import { planWorkspaceImageBuild, type PlannedWorkspaceImageBuild } from "../../buildkit/index.js";
import { buildRegistryImageReference, type RegistryClient } from "../../registry/index.js";
import { LABEL_COMPONENT, LABEL_MANAGED_BY } from "../../runtime/kubernetes/config.js";
import type {
  BuildAndPublishInput,
  BuildAndPublishResult,
  WorkspaceImageBuilder,
} from "../image-builder.js";
import type { KubernetesBuildApi } from "./api.js";
import type { KubernetesBuildConfig } from "./config.js";

export const COMPONENT_BUILD = "image-build";
export const LABEL_PLAN_HASH = "sealant.sh/plan-hash";
export const LABEL_BUILD_ID = "sealant.sh/build-id";

const CONTEXT_MOUNT = "/workspace";
const BUILDKITD_CONFIG_MOUNT = "/home/user/.config/buildkit";
const BUILD_SECRETS_MOUNT = "/run/secrets/build";
const DOCKER_CONFIG_MOUNT = "/run/secrets/docker";
const CONTAINER_NAME = "buildkit";
const POLL_INTERVAL_MS = 2000;
const LOG_TAIL_LINES = 60;

export interface KubernetesWorkspaceImageBuilderOptions {
  readonly config: KubernetesBuildConfig;
  readonly api: KubernetesBuildApi;
  readonly registryClient: RegistryClient;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  /** Test seam: read a build secret file from the worker. */
  readonly readSecretFile?: (path: string) => Promise<Buffer>;
}

export class KubernetesImageBuildError extends Error {
  override readonly name = "KubernetesImageBuildError";
  readonly code = "buildkit-command-failed" as const;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `build-<12 hex>`: deterministic for (plan hash, repository, tag). */
export const buildJobName = (planHash: string, repository: string, tag: string): string =>
  `build-${createHash("sha256").update(`${planHash}\n${repository}\n${tag}`).digest("hex").slice(0, 12)}`;

export const buildLabels = (
  config: Pick<KubernetesBuildConfig, "managedBy">,
  planHash: string,
  buildId: string | undefined,
): Record<string, string> => ({
  [LABEL_MANAGED_BY]: config.managedBy,
  [LABEL_COMPONENT]: COMPONENT_BUILD,
  [LABEL_PLAN_HASH]: planHash.slice(0, 63),
  ...(buildId === undefined
    ? {}
    : { [LABEL_BUILD_ID]: buildId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 63) }),
});

export const buildSelector = (config: Pick<KubernetesBuildConfig, "managedBy">): string =>
  `${LABEL_MANAGED_BY}=${config.managedBy},${LABEL_COMPONENT}=${COMPONENT_BUILD}`;

export interface BuildManifestsInput {
  readonly name: string;
  readonly config: KubernetesBuildConfig;
  readonly labels: Record<string, string>;
  readonly planned: PlannedWorkspaceImageBuild;
  readonly imageReference: string;
  /** Build secret ids the Containerfile mounts; contents live in the build Secret. */
  readonly secretIds: readonly string[];
  readonly hasDockerConfig: boolean;
}

/**
 * The ConfigMap carrying the build context; small by construction (text only). When the registry
 * is plain HTTP it also carries `buildkitd.toml` — the daemon config is what makes PULLS from the
 * registry (the `COPY --from=<sealantd>` base) use HTTP; `registry.insecure=true` on the output
 * only covers the push.
 */
export const buildContextConfigMap = (input: BuildManifestsInput): V1ConfigMap => ({
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: {
    name: `${input.name}-context`,
    namespace: input.config.namespace,
    labels: input.labels,
  },
  data: {
    Containerfile: input.planned.containerfile,
    "resolved-image-plan.json": `${JSON.stringify(input.planned.imagePlan, null, 2)}\n`,
    ...(input.config.registryInsecure
      ? {
          "buildkitd.toml": `[registry."${input.config.pushRegistry}"]\n  http = true\n`,
        }
      : {}),
  },
});

/** The exact buildctl invocation. Pure, so tests can pin it. */
export const buildctlArgs = (input: BuildManifestsInput): readonly string[] => {
  const output = [
    "type=image",
    `name=${input.imageReference}`,
    "push=true",
    ...(input.config.registryInsecure ? ["registry.insecure=true"] : []),
  ].join(",");
  return [
    "build",
    "--frontend",
    "dockerfile.v0",
    "--local",
    `context=${CONTEXT_MOUNT}`,
    "--local",
    `dockerfile=${CONTEXT_MOUNT}`,
    "--opt",
    "filename=Containerfile",
    ...(input.planned.osFamily === "arch" ? ["--opt", "platform=linux/amd64"] : []),
    ...input.secretIds.flatMap((id) => ["--secret", `id=${id},src=${BUILD_SECRETS_MOUNT}/${id}`]),
    "--output",
    output,
  ];
};

export const buildJob = (input: BuildManifestsInput): V1Job => ({
  apiVersion: "batch/v1",
  kind: "Job",
  metadata: { name: input.name, namespace: input.config.namespace, labels: input.labels },
  spec: {
    backoffLimit: 0,
    ttlSecondsAfterFinished: input.config.ttlSecondsAfterFinished,
    activeDeadlineSeconds: Math.ceil(input.config.timeoutMs / 1000),
    template: {
      metadata: {
        labels: input.labels,
        annotations: {
          // Rootless BuildKit needs unconfined seccomp/AppArmor to set up its user namespace.
          // Both the field (K8s ≥ 1.30) and the legacy annotation are set for older clusters.
          [`container.apparmor.security.beta.kubernetes.io/${CONTAINER_NAME}`]: "unconfined",
        },
      },
      spec: {
        restartPolicy: "Never",
        serviceAccountName: input.config.serviceAccount,
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        ...(input.config.imagePullSecret === undefined
          ? {}
          : { imagePullSecrets: [{ name: input.config.imagePullSecret }] }),
        securityContext: {
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: "Unconfined" },
          appArmorProfile: { type: "Unconfined" },
        },
        volumes: [
          { name: "context", configMap: { name: `${input.name}-context` } },
          { name: "buildkit", emptyDir: {} },
          ...(input.config.registryInsecure
            ? [
                {
                  name: "buildkitd-config",
                  configMap: {
                    name: `${input.name}-context`,
                    items: [{ key: "buildkitd.toml", path: "buildkitd.toml" }],
                  },
                },
              ]
            : []),
          ...(input.secretIds.length === 0
            ? []
            : [
                {
                  name: "build-secrets",
                  secret: { secretName: `${input.name}-secrets`, defaultMode: 0o400 },
                },
              ]),
          ...(input.hasDockerConfig
            ? [
                {
                  name: "docker-config",
                  secret: { secretName: `${input.name}-registry`, defaultMode: 0o400 },
                },
              ]
            : []),
        ],
        containers: [
          {
            name: CONTAINER_NAME,
            image: input.config.buildkitImage,
            command: ["buildctl-daemonless.sh"],
            args: [...buildctlArgs(input)],
            env: [
              { name: "BUILDKITD_FLAGS", value: "--oci-worker-no-process-sandbox" },
              ...(input.hasDockerConfig
                ? [{ name: "DOCKER_CONFIG", value: DOCKER_CONFIG_MOUNT }]
                : []),
            ],
            securityContext: {
              privileged: false,
              // Rootless BuildKit sets up its user namespace through newuidmap/newgidmap, which
              // are file-capability binaries — blocking privilege escalation breaks them
              // ("newuidmap: Could not set caps"). Escalation stays bounded to those setuid maps;
              // the container itself is still unprivileged.
              allowPrivilegeEscalation: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              seccompProfile: { type: "Unconfined" },
              appArmorProfile: { type: "Unconfined" },
            },
            resources: {
              requests: { ...input.config.resources.requests },
              limits: { ...input.config.resources.limits },
            },
            volumeMounts: [
              { name: "context", mountPath: CONTEXT_MOUNT, readOnly: true },
              { name: "buildkit", mountPath: "/home/user/.local/share/buildkit" },
              ...(input.config.registryInsecure
                ? [{ name: "buildkitd-config", mountPath: BUILDKITD_CONFIG_MOUNT, readOnly: true }]
                : []),
              ...(input.secretIds.length === 0
                ? []
                : [{ name: "build-secrets", mountPath: BUILD_SECRETS_MOUNT, readOnly: true }]),
              ...(input.hasDockerConfig
                ? [{ name: "docker-config", mountPath: DOCKER_CONFIG_MOUNT, readOnly: true }]
                : []),
            ],
          },
        ],
      },
    },
  },
});

const b64 = (value: string | Buffer): string => Buffer.from(value).toString("base64");

export const dockerConfigJson = (
  pushRegistry: string,
  credentials: { readonly username: string; readonly password: string },
): string =>
  JSON.stringify({
    auths: { [pushRegistry]: { auth: b64(`${credentials.username}:${credentials.password}`) } },
  });

const jobStatus = (job: V1Job | undefined): "succeeded" | "failed" | "running" | "missing" => {
  if (job === undefined) {
    return "missing";
  }
  if ((job.status?.succeeded ?? 0) > 0) {
    return "succeeded";
  }
  if ((job.status?.failed ?? 0) > 0) {
    return "failed";
  }
  if (job.status?.conditions?.some((c) => c.type === "Failed" && c.status === "True")) {
    return "failed";
  }
  return "running";
};

export class KubernetesWorkspaceImageBuilder implements WorkspaceImageBuilder {
  readonly #config: KubernetesBuildConfig;
  readonly #api: KubernetesBuildApi;
  readonly #registry: RegistryClient;
  readonly #pollIntervalMs: number;
  readonly #now: () => number;
  readonly #readSecretFile: (path: string) => Promise<Buffer>;

  constructor(options: KubernetesWorkspaceImageBuilderOptions) {
    this.#config = options.config;
    this.#api = options.api;
    this.#registry = options.registryClient;
    this.#pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#readSecretFile = options.readSecretFile ?? ((path) => readFile(path));
  }

  readonly plan = (spec: NewWorkspace): PlannedWorkspaceImageBuild =>
    planWorkspaceImageBuild({ blueprint: spec });

  async buildAndPublish(input: BuildAndPublishInput): Promise<BuildAndPublishResult> {
    const config = this.#config;
    const planned = this.plan(input.spec);
    const name = buildJobName(planned.planHash, input.repository, input.tag);
    const labels = buildLabels(config, planned.planHash, input.buildId);
    const imageReference = buildRegistryImageReference(
      config.pushRegistry,
      input.repository,
      input.tag,
    );

    // Build secrets: the compiler references worker-local files; read them now and project them.
    const secretData: Record<string, string> = {};
    for (const secret of planned.imagePlan.buildSecrets) {
      secretData[secret.id] = b64(await this.#readSecretFile(secret.sourceRef));
    }
    const secretIds = Object.keys(secretData);
    const hasDockerConfig = config.registryCredentials !== undefined;

    const manifests: BuildManifestsInput = {
      name,
      config,
      labels,
      planned,
      imageReference,
      secretIds,
      hasDockerConfig,
    };

    const cleanupInputs = async (): Promise<void> => {
      await this.#api.deleteConfigMap(`${name}-context`);
      await this.#api.deleteSecret(`${name}-secrets`);
      await this.#api.deleteSecret(`${name}-registry`);
    };

    // Inputs first (create-or-keep: a redelivery reuses identical content), then the Job.
    await this.#api.createConfigMap(buildContextConfigMap(manifests));
    if (secretIds.length > 0) {
      const secret: V1Secret = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: `${name}-secrets`, namespace: config.namespace, labels },
        type: "Opaque",
        data: secretData,
      };
      await this.#api.createSecret(secret);
    }
    if (hasDockerConfig && config.registryCredentials !== undefined) {
      const secret: V1Secret = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: `${name}-registry`, namespace: config.namespace, labels },
        type: "Opaque",
        data: {
          "config.json": b64(dockerConfigJson(config.pushRegistry, config.registryCredentials)),
        },
      };
      await this.#api.createSecret(secret);
    }

    const created = await this.#api.createJob(buildJob(manifests));
    if (created.outcome === "conflict") {
      const existing = await this.#api.getJob(name);
      if (existing?.metadata?.labels?.[LABEL_PLAN_HASH] !== labels[LABEL_PLAN_HASH]) {
        await cleanupInputs();
        throw new KubernetesImageBuildError(
          `A build Job named ${name} exists but is not labelled for this plan; refusing to adopt it.`,
        );
      }
      if (jobStatus(existing) === "failed") {
        // A previous attempt at this exact plan failed; retry with a fresh Job.
        await this.#api.deleteJob(name);
        await this.#awaitJobGone(name);
        const recreated = await this.#api.createJob(buildJob(manifests));
        if (recreated.outcome === "conflict") {
          await cleanupInputs();
          throw new KubernetesImageBuildError(
            `Build Job ${name} could not be recreated after deletion.`,
          );
        }
      }
    }

    try {
      await this.#awaitJob(name);
    } catch (error) {
      await cleanupInputs();
      throw error;
    }
    await cleanupInputs();

    const repository =
      imageReference.slice(config.pushRegistry.length + 1).split(":")[0] ?? input.repository;
    const digest = await this.#registry.headManifest(repository, input.tag);
    if (digest === null) {
      throw new KubernetesImageBuildError(
        `Build Job ${name} succeeded but the registry reports no manifest for ${imageReference}.`,
      );
    }
    const publishedImage = {
      repository,
      tag: input.tag,
      reference: imageReference,
      digestReference: `${config.pushRegistry}/${repository}@${digest}`,
      digest,
    };
    const build: WorkspaceBuild = {
      builder: { id: planned.osFamily, osFamily: planned.osFamily },
      artifacts: [
        {
          kind: "oci-image",
          name: `${repository}:${input.tag}`,
          reference: imageReference,
          loader: "registry",
        },
      ],
      metadata: {
        defaultArtifactName: `${repository}:${input.tag}`,
        notes: [`Built by BuildKit Job ${name} in namespace ${config.namespace}.`],
        planHash: planned.planHash,
      },
    };
    return { publishedImage, build };
  }

  /** Every build Job this worker owns (for reconciliation / cleanup policy). */
  async listManagedJobs(): Promise<readonly V1Job[]> {
    return this.#api.listJobs(buildSelector(this.#config));
  }

  async #awaitJobGone(name: string): Promise<void> {
    const deadline = this.#now() + this.#config.timeoutMs;
    while ((await this.#api.getJob(name)) !== undefined) {
      if (this.#now() > deadline) {
        throw new KubernetesImageBuildError(`Build Job ${name} did not terminate in time.`);
      }
      await sleep(this.#pollIntervalMs);
    }
  }

  async #awaitJob(name: string): Promise<void> {
    const deadline = this.#now() + this.#config.timeoutMs;
    for (;;) {
      const job = await this.#api.getJob(name);
      const status = jobStatus(job);
      if (status === "succeeded") {
        return;
      }
      if (status === "missing") {
        throw new KubernetesImageBuildError(`Build Job ${name} disappeared before completing.`);
      }
      if (status === "failed" || this.#now() > deadline) {
        const tail = await this.#logTail(name);
        throw new KubernetesImageBuildError(
          `${status === "failed" ? `Build Job ${name} failed` : `Build Job ${name} exceeded ${String(this.#config.timeoutMs)} ms`}.${
            tail.length === 0 ? "" : `\n--- buildkit log tail ---\n${tail}`
          }`,
        );
      }
      await sleep(this.#pollIntervalMs);
    }
  }

  async #logTail(jobName: string): Promise<string> {
    const pods = await this.#api.listPods(`job-name=${jobName}`);
    const pod = pods[pods.length - 1];
    const podName = pod?.metadata?.name;
    if (podName === undefined) {
      return "";
    }
    return (await this.#api.readPodLogTail(podName, CONTAINER_NAME, LOG_TAIL_LINES)).trim();
  }
}
