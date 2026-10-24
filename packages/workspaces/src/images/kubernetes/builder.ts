/**
 * Kubernetes image builder: one rootless BuildKit Job per build, pushing straight to the
 * registry (design §D7). No Docker socket anywhere.
 *
 *   1. Plan with the shared compiler (`planWorkspaceImageBuild`): same Containerfile, same plan
 *      hash as the Docker path. The plan's platform is the build's (`--opt platform`), and the Job
 *      runs on a node of that architecture, so the build is native.
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
 *   7. Read the image probe back from the pushed digest (`probeJob`); a failed read is a note.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { V1ConfigMap, V1Job, V1Pod, V1Secret } from "@kubernetes/client-node";
import {
  parseWorkspaceImageProbe,
  type NewWorkspace,
  type WorkspaceBuild,
  type WorkspaceImagePlatform,
  type WorkspaceImageProbe,
} from "@sealant/validators";

import {
  ARCHLINUXARM_BUILDER_KEY,
  ARCHLINUXARM_KEY_FILE,
  buildPlatformOf,
  imagePlatformArchitecture,
  planWorkspaceImageBuild,
  usesArchlinuxArm,
  type PlannedWorkspaceImageBuild,
} from "../../buildkit/index.js";
import { IMAGE_PROBE_PATH } from "../../buildkit/person-layout.js";
import { buildRegistryImageReference, type RegistryClient } from "../../registry/index.js";
import {
  LABEL_COMPONENT,
  LABEL_MANAGED_BY,
  NODE_ARCH_LABEL,
} from "../../runtime/kubernetes/config.js";
import type { PublishedImage } from "../../runtime/runtime-adapter.js";
import type {
  BuildAndPublishInput,
  BuildAndPublishResult,
  WorkspaceImageBuilder,
} from "../image-builder.js";
import type { KubernetesBuildApi } from "./api.js";
import type { KubernetesBuildConfig } from "./config.js";

export const COMPONENT_BUILD = "image-build";
export const COMPONENT_IMAGE_PROBE = "image-probe";
export const LABEL_PLAN_HASH = "sealant.sh/plan-hash";
export const LABEL_BUILD_ID = "sealant.sh/build-id";

const CONTEXT_MOUNT = "/workspace";
const BUILDKITD_CONFIG_MOUNT = "/home/user/.config/buildkit";
const BUILD_SECRETS_MOUNT = "/run/secrets/build";
const DOCKER_CONFIG_MOUNT = "/run/secrets/docker";
const CONTAINER_NAME = "buildkit";
const POLL_INTERVAL_MS = 2000;
/**
 * How long a build Pod may stay unschedulable before the build fails. Long enough for a cluster
 * autoscaler to bring up a node of the pool; far shorter than the build's own bound, which a Pod
 * no node can take would otherwise wait out.
 */
const UNSCHEDULABLE_GRACE_MS = 5 * 60_000;
const LOG_TAIL_LINES = 60;
const PROBE_CONTAINER_NAME = "probe";
/** Long enough for a cold image pull, inside the build job's lease (15 min by default). */
const PROBE_DEADLINE_MS = 10 * 60_000;
const PROBE_MAX_BYTES = 64 * 1024;

export interface KubernetesWorkspaceImageBuilderOptions {
  readonly config: KubernetesBuildConfig;
  /** What images are built for: the architecture of the nodes workspaces run on. */
  readonly platform: WorkspaceImagePlatform;
  /** The workspace Pods' node selector: builds run in the same pool. */
  readonly nodeSelector?: Readonly<Record<string, string>>;
  readonly unschedulableGraceMs?: number;
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
  /** The workspace Pods' node selector; the image's architecture is added to it. */
  readonly nodeSelector?: Readonly<Record<string, string>>;
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
    ...(usesArchlinuxArm(input.planned.osFamily, input.planned.platform)
      ? { [ARCHLINUXARM_KEY_FILE]: ARCHLINUXARM_BUILDER_KEY }
      : {}),
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
    // No platform for a custom base: BuildKit follows the platform its manifest offers.
    ...(buildPlatformOf(input.planned) === undefined
      ? []
      : ["--opt", `platform=${input.planned.platform}`]),
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
        // In the workspaces' pool, on a node of the image's architecture: anywhere else BuildKit
        // would emulate every step.
        nodeSelector: buildJobNodeSelector(input.nodeSelector ?? {}, input.planned.platform),
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

const freshProbeJobName = (buildName: string): string =>
  `${buildName}-probe-${randomBytes(4).toString("hex")}`;

const probeDeadlineMs = (config: KubernetesBuildConfig): number =>
  Math.min(PROBE_DEADLINE_MS, config.timeoutMs);

// A namespace under a ResourceQuota admits no Pod without requests.
const PROBE_CONTAINER_RESOURCES = {
  requests: { cpu: "10m", memory: "16Mi" },
  limits: { cpu: "100m", memory: "64Mi" },
};

const said = (
  status: { readonly reason?: string; readonly message?: string } | undefined,
): string | undefined =>
  status === undefined
    ? undefined
    : [status.reason, status.message].filter((part) => part !== undefined).join(": ");

export interface ProbeJobInput {
  readonly name: string;
  readonly config: KubernetesBuildConfig;
  readonly image: PublishedImage;
  readonly platform: WorkspaceImagePlatform;
  readonly nodeSelector?: Readonly<Record<string, string>>;
}

export const probeJob = (input: ProbeJobInput): V1Job => {
  const labels = {
    [LABEL_MANAGED_BY]: input.config.managedBy,
    [LABEL_COMPONENT]: COMPONENT_IMAGE_PROBE,
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: input.name, namespace: input.config.namespace, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: input.config.ttlSecondsAfterFinished,
      activeDeadlineSeconds: Math.ceil(probeDeadlineMs(input.config) / 1000),
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          nodeSelector: buildJobNodeSelector(input.nodeSelector ?? {}, input.platform),
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          ...(input.config.imagePullSecret === undefined
            ? {}
            : { imagePullSecrets: [{ name: input.config.imagePullSecret }] }),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65534,
            runAsGroup: 65534,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: PROBE_CONTAINER_NAME,
              image: input.image.digestReference,
              command: ["/bin/sh", "-c", `cat ${IMAGE_PROBE_PATH}`],
              resources: PROBE_CONTAINER_RESOURCES,
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
        },
      },
    },
  };
};

type ImageProbeReadback =
  | { readonly kind: "read"; readonly probe: WorkspaceImageProbe }
  | { readonly kind: "unread"; readonly note: string };

const b64 = (value: string | Buffer): string => Buffer.from(value).toString("base64");

/** The workspace Pods' node selector, with the image's architecture. */
export const buildJobNodeSelector = (
  nodeSelector: Readonly<Record<string, string>>,
  platform: WorkspaceImagePlatform,
): Record<string, string> => ({
  ...nodeSelector,
  [NODE_ARCH_LABEL]: imagePlatformArchitecture(platform),
});

/** The scheduler's word when no Pod of the Job can be placed; undefined while one can. */
const unschedulableCondition = (pods: readonly V1Pod[]): string | undefined => {
  const condition = pods
    .flatMap((pod) => pod.status?.conditions ?? [])
    .find(
      (candidate) =>
        candidate.type === "PodScheduled" &&
        candidate.status === "False" &&
        candidate.reason === "Unschedulable",
    );
  return condition === undefined ? undefined : (condition.message ?? "Unschedulable");
};

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
  readonly #platform: WorkspaceImagePlatform;
  readonly #nodeSelector: Readonly<Record<string, string>>;
  readonly #unschedulableGraceMs: number;
  readonly #api: KubernetesBuildApi;
  readonly #registry: RegistryClient;
  readonly #pollIntervalMs: number;
  readonly #now: () => number;
  readonly #readSecretFile: (path: string) => Promise<Buffer>;

  constructor(options: KubernetesWorkspaceImageBuilderOptions) {
    this.#config = options.config;
    this.#platform = options.platform;
    this.#nodeSelector = options.nodeSelector ?? {};
    this.#unschedulableGraceMs = options.unschedulableGraceMs ?? UNSCHEDULABLE_GRACE_MS;
    this.#api = options.api;
    this.#registry = options.registryClient;
    this.#pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#readSecretFile = options.readSecretFile ?? ((path) => readFile(path));
  }

  // A rootless BuildKit Job in its own namespace, with a service account of its own: recipe steps
  // run in a Pod, never on the worker.
  readonly isolation = "isolated" as const;

  readonly plan = (spec: NewWorkspace): PlannedWorkspaceImageBuild =>
    planWorkspaceImageBuild({ blueprint: spec, platform: this.#platform });

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
      nodeSelector: this.#nodeSelector,
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
    const readback = await this.#readImageProbe(name, publishedImage, planned.platform);
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
        notes: [
          `Built by BuildKit Job ${name} in namespace ${config.namespace}.`,
          ...(readback.kind === "unread" ? [readback.note] : []),
        ],
        planHash: planned.planHash,
        ...(readback.kind === "read" ? { imageProbe: readback.probe } : {}),
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
    let unschedulableSince: number | undefined;
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
      const unschedulable = unschedulableCondition(await this.#api.listPods(`job-name=${name}`));
      if (unschedulable === undefined) {
        unschedulableSince = undefined;
      } else {
        unschedulableSince ??= this.#now();
        if (this.#now() - unschedulableSince >= this.#unschedulableGraceMs) {
          await this.#api.deleteJob(name);
          const selector = Object.entries(buildJobNodeSelector(this.#nodeSelector, this.#platform))
            .map(([key, value]) => `${key}=${value}`)
            .join(", ");
          throw new KubernetesImageBuildError(
            `Build Job ${name} could not be scheduled for ${String(Math.round(this.#unschedulableGraceMs / 60_000))} min: no node it can run on has ${selector}. ${unschedulable}`,
          );
        }
      }
      await sleep(this.#pollIntervalMs);
    }
  }

  async #readImageProbe(
    buildName: string,
    image: PublishedImage,
    platform: WorkspaceImagePlatform,
  ): Promise<ImageProbeReadback> {
    const name = freshProbeJobName(buildName);
    let created = false;
    try {
      const outcome = await this.#api.createJob(
        probeJob({ name, config: this.#config, image, platform, nodeSelector: this.#nodeSelector }),
      );
      if (outcome.outcome === "conflict") throw new Error(`Job ${name} already exists`);
      created = true;
      const deadline = this.#now() + probeDeadlineMs(this.#config) + 30_000;
      for (;;) {
        const job = await this.#api.getJob(name);
        const status = jobStatus(job);
        if (status === "succeeded") break;
        if (status === "missing") throw new Error(`Job ${name} missing`);
        if (status === "failed" || this.#now() > deadline) {
          const ended = status === "failed" ? "failed" : "did not finish in time";
          throw new Error(`Job ${name} ${ended}: ${await this.#probeFailure(job, name)}`);
        }
        await sleep(this.#pollIntervalMs);
      }
      const output = await this.#logTail(name, PROBE_CONTAINER_NAME, PROBE_MAX_BYTES);
      return { kind: "read", probe: parseWorkspaceImageProbe(JSON.parse(output)) };
    } catch (error) {
      const reason = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
      return {
        kind: "unread",
        note: `The image probe could not be read back from ${image.digestReference}: ${reason}`,
      };
    } finally {
      if (created) await this.#api.deleteJob(name).catch(() => undefined);
    }
  }

  async #probeFailure(job: V1Job | undefined, name: string): Promise<string> {
    const pods = await this.#api.listPods(`job-name=${name}`);
    const waiting = pods
      .flatMap((pod) => pod.status?.containerStatuses ?? [])
      .find((status) => status.state?.waiting?.reason !== undefined)?.state?.waiting;
    const failed = job?.status?.conditions?.find((c) => c.type === "Failed" && c.status === "True");
    const reason = unschedulableCondition(pods) ?? said(waiting) ?? said(failed);
    if (reason !== undefined) return reason;
    const logLine = (await this.#logTail(name, PROBE_CONTAINER_NAME, PROBE_MAX_BYTES))
      .split("\n")
      .pop();
    return logLine === undefined || logLine === "" ? "no reason reported" : logLine;
  }

  async #logTail(
    jobName: string,
    container = CONTAINER_NAME,
    limitBytes?: number,
  ): Promise<string> {
    const pods = await this.#api.listPods(`job-name=${jobName}`);
    const pod = pods[pods.length - 1];
    const podName = pod?.metadata?.name;
    if (podName === undefined) {
      return "";
    }
    return (await this.#api.readPodLogTail(podName, container, LOG_TAIL_LINES, limitBytes)).trim();
  }
}
