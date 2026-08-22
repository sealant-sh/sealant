/**
 * Pure manifest builders for one workspace attempt (design §D5). No cluster access; every
 * function is a total function of its inputs so tests can pin the exact objects.
 *
 * Security posture, stated plainly:
 *   - the workspace container is NOT privileged, cannot escalate, drops every capability and adds
 *     back only what `sealantd boot` needs to chown/apply dotfiles and signal its children, and
 *     runs under the runtime default seccomp profile;
 *   - it still runs as root (the images do), so this is baseline, not restricted, Pod Security;
 *   - no ServiceAccount token is mounted; no secret value ever appears in the Pod spec — secret
 *     env arrives through `valueFrom.secretKeyRef`, the boot secret file through a projected
 *     Secret volume.
 */
import type {
  V1Container,
  V1EnvVar,
  V1Pod,
  V1Secret,
  V1Service,
  V1Volume,
  V1VolumeMount,
} from "@kubernetes/client-node";

import { getHarnessIntegration } from "../../harness/integrations.js";
import type { RuntimeAdapterLaunchInput } from "../runtime-adapter.js";
import {
  COMPONENT_WORKSPACE,
  LABEL_ADAPTER,
  LABEL_COMPONENT,
  LABEL_MANAGED_BY,
  LABEL_POOL,
  LABEL_PRINCIPAL,
  LABEL_RUN_ID,
  LABEL_WORKSPACE_ID,
  type KubernetesRuntimeConfig,
} from "./config.js";
import { workspaceServiceDnsName, type WorkspaceResourceNames } from "./names.js";
import type { LoweredMounts } from "./volumes.js";

/** Fixed in-container layout; `sealantd boot` reads these paths. */
export const RUN_SEALANT_PATH = "/run/sealant";
export const LAUNCH_MOUNT_PATH = "/run/sealant/launch";
export const TLS_MOUNT_PATH = "/run/sealant/tls";
export const SECRET_ENV_KEY = "env.json";
export const DOTFILES_SUBDIR = "dotfiles";
export const CONTROL_PORT_NAME = "control";

/** Capabilities the root-running image needs for boot (dotfiles apply, chown, process signalling). */
export const WORKSPACE_CAPABILITIES = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "SETUID",
  "SETGID",
  "KILL",
] as const;

export interface WorkspaceLabelsInput {
  readonly runId: string;
  readonly adapter: "k8s" | "k3s";
  readonly workspaceId?: string | undefined;
  readonly principalId?: string | undefined;
  readonly pool?: "hot" | undefined;
}

const labelSafe = (value: string): string =>
  value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .slice(0, 63);

/** Labels stamped on every object; the run id is the reconciliation key. */
export const workspaceLabels = (
  config: Pick<KubernetesRuntimeConfig, "managedBy">,
  input: WorkspaceLabelsInput,
): Record<string, string> => ({
  [LABEL_MANAGED_BY]: config.managedBy,
  [LABEL_COMPONENT]: COMPONENT_WORKSPACE,
  [LABEL_RUN_ID]: labelSafe(input.runId),
  [LABEL_ADAPTER]: input.adapter,
  ...(input.workspaceId === undefined
    ? {}
    : { [LABEL_WORKSPACE_ID]: labelSafe(input.workspaceId) }),
  ...(input.principalId === undefined ? {} : { [LABEL_PRINCIPAL]: labelSafe(input.principalId) }),
  ...(input.pool === undefined ? {} : { [LABEL_POOL]: input.pool }),
});

/** Selector that finds every object the worker manages (for reconciliation). */
export const managedSelector = (config: Pick<KubernetesRuntimeConfig, "managedBy">): string =>
  `${LABEL_MANAGED_BY}=${config.managedBy},${LABEL_COMPONENT}=${COMPONENT_WORKSPACE}`;

/** Selector for one run's objects. */
export const runSelector = (
  config: Pick<KubernetesRuntimeConfig, "managedBy">,
  runId: string,
): string => `${managedSelector(config)},${LABEL_RUN_ID}=${labelSafe(runId)}`;

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

/**
 * The non-secret env the Docker adapter also emits, in the same precedence order (later wins):
 * userEnv, source/harness contract, runtime.env. Secret-bearing channels (clone auth, platform,
 * credential env) are NOT here — see `secretEnvEntries`.
 */
export const plainEnvEntries = (
  input: Pick<RuntimeAdapterLaunchInput, "blueprint">,
  config: Pick<KubernetesRuntimeConfig, "controlPort" | "volumeMappings">,
  options: { readonly secretEnvFile: boolean; readonly dotfilesArchiveDir: string | undefined },
): ReadonlyArray<readonly [string, string]> => {
  const { blueprint } = input;
  const entries: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(blueprint.runtime.userEnv ?? {})) {
    entries.push([key, value]);
  }
  const source = blueprint.sources.workspace;
  if (source.kind === "mount") {
    entries.push(["SEALANT_WORKSPACE_SOURCE", "mount"]);
    entries.push(["SEALANT_WORKSPACE_MOUNT_HOST_PATH", source.hostPath]);
    entries.push([
      "SEALANT_MOUNT_ALLOWED_STORE_ROOTS",
      config.volumeMappings.map((mapping) => mapping.logicalRoot).join(":"),
    ]);
  } else {
    entries.push(["SEALANT_WORKSPACE_REPO_URL", source.url]);
    if (source.ref !== undefined) {
      entries.push(["SEALANT_WORKSPACE_REPO_REF", source.ref]);
    }
  }
  entries.push(["SEALANT_OCI_RUNTIME", blueprint.runtime.ociRuntime]);
  const harness = getHarnessIntegration(blueprint.harness.id);
  if (harness !== undefined) {
    entries.push(["SEALANT_HARNESS_BANNER", `Starting ${blueprint.harness.id} workspace`]);
    entries.push(["SEALANT_HARNESS_LAUNCH_COMMAND", harness.launchCommand]);
  }
  for (const [key, value] of Object.entries(blueprint.runtime.env)) {
    entries.push([key, value]);
  }
  // The opt-in WSS frontend (sealantd ADR-0013): on, for the Service port, with the per-workspace
  // server certificate and the issuer CA as the client CA.
  entries.push(["SEALANT_CONTROL_WSS_LISTEN", `0.0.0.0:${config.controlPort}`]);
  entries.push(["SEALANT_CONTROL_WSS_CERT", `${TLS_MOUNT_PATH}/tls.crt`]);
  entries.push(["SEALANT_CONTROL_WSS_KEY", `${TLS_MOUNT_PATH}/tls.key`]);
  entries.push(["SEALANT_CONTROL_WSS_CLIENT_CA", `${TLS_MOUNT_PATH}/ca.crt`]);
  if (options.secretEnvFile) {
    entries.push(["SEALANT_SECRET_ENV_FILE", `${LAUNCH_MOUNT_PATH}/${SECRET_ENV_KEY}`]);
  }
  if (options.dotfilesArchiveDir !== undefined) {
    entries.push(["SEALANT_DOTFILES_ARCHIVE_DIR", options.dotfilesArchiveDir]);
  }
  return entries;
};

/**
 * Env that carries secrets: clone auth, worker-resolved platform env, connected-account tokens.
 * These become keys of the env Secret and are referenced from the container with
 * `valueFrom.secretKeyRef`, placed AFTER the plain entries so the Docker precedence (credential
 * env wins) is preserved — `env` order is last-wins in Kubernetes.
 */
export const secretEnvEntries = (
  input: Pick<RuntimeAdapterLaunchInput, "workspaceCloneAuth" | "platformEnv" | "credentialEnv">,
  cloneAuthKeyBase64: string | undefined,
): ReadonlyArray<readonly [string, string]> => {
  const entries: Array<readonly [string, string]> = [];
  const auth = input.workspaceCloneAuth;
  if (auth?.type === "file-ref" && cloneAuthKeyBase64 !== undefined) {
    entries.push(["SEALANT_WORKSPACE_AUTH_KEY_BASE64", cloneAuthKeyBase64]);
  } else if (auth?.type === "http-token") {
    entries.push(["SEALANT_WORKSPACE_HTTP_USERNAME", auth.username]);
    entries.push(["SEALANT_WORKSPACE_HTTP_TOKEN", auth.token]);
  }
  for (const [key, value] of Object.entries(input.platformEnv ?? {})) {
    entries.push([key, value]);
  }
  for (const [key, value] of Object.entries(input.credentialEnv ?? {})) {
    entries.push([key, value]);
  }
  return entries;
};

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

const b64 = (value: string | Uint8Array): string => Buffer.from(value).toString("base64");

/** Env Secret: one key per secret-bearing env var. Undefined when there is nothing secret. */
export const buildEnvSecret = (
  names: WorkspaceResourceNames,
  namespace: string,
  labels: Record<string, string>,
  entries: ReadonlyArray<readonly [string, string]>,
): V1Secret | undefined => {
  if (entries.length === 0) {
    return undefined;
  }
  const data: Record<string, string> = {};
  for (const [key, value] of entries) {
    data[key] = b64(value);
  }
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: names.envSecret, namespace, labels },
    type: "Opaque",
    data,
  };
};

export interface LaunchSecretContent {
  readonly secretEnvJson?: string | undefined;
  /** manifest.json + archives, already serialized; keys become files under `dotfiles/`. */
  readonly dotfiles?:
    | { readonly manifestJson: string; readonly archives: ReadonlyArray<Uint8Array> }
    | undefined;
}

/** Launch Secret projected at /run/sealant/launch. Undefined when there is nothing to project. */
export const buildLaunchSecret = (
  names: WorkspaceResourceNames,
  namespace: string,
  labels: Record<string, string>,
  content: LaunchSecretContent,
): V1Secret | undefined => {
  const data: Record<string, string> = {};
  if (content.secretEnvJson !== undefined) {
    data[SECRET_ENV_KEY] = b64(content.secretEnvJson);
  }
  if (content.dotfiles !== undefined) {
    data["dotfiles-manifest"] = b64(content.dotfiles.manifestJson);
    content.dotfiles.archives.forEach((archive, index) => {
      data[`dotfiles-${index}`] = b64(archive);
    });
  }
  if (Object.keys(data).length === 0) {
    return undefined;
  }
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: names.launchSecret, namespace, labels },
    type: "Opaque",
    data,
  };
};

/** Byte size of a Secret as the API server counts it (roughly: base64 payload + keys). */
export const secretPayloadBytes = (secret: V1Secret): number =>
  Object.entries(secret.data ?? {}).reduce(
    (sum, [key, value]) => sum + key.length + value.length,
    0,
  );

// ---------------------------------------------------------------------------------------------
// Certificate (cert-manager.io/v1) and Service
// ---------------------------------------------------------------------------------------------

export interface CertificateObject {
  readonly apiVersion: "cert-manager.io/v1";
  readonly kind: "Certificate";
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Record<string, string>;
  };
  readonly spec: {
    readonly secretName: string;
    readonly dnsNames: readonly string[];
    readonly usages: readonly string[];
    readonly duration: string;
    readonly renewBefore: string;
    readonly privateKey: {
      readonly algorithm: "ECDSA";
      readonly size: 256;
      readonly rotationPolicy: "Always";
    };
    readonly issuerRef: { readonly name: string; readonly kind: string; readonly group: string };
    readonly secretTemplate: { readonly labels: Record<string, string> };
  };
}

/** Server-only usages: this certificate must never pass a clientAuth check (design §D3). */
export const buildCertificate = (
  names: WorkspaceResourceNames,
  config: Pick<KubernetesRuntimeConfig, "namespace" | "certManagerIssuer">,
  labels: Record<string, string>,
): CertificateObject => ({
  apiVersion: "cert-manager.io/v1",
  kind: "Certificate",
  metadata: { name: names.certificate, namespace: config.namespace, labels },
  spec: {
    secretName: names.tlsSecret,
    dnsNames: [
      workspaceServiceDnsName(names.service, config.namespace),
      `${workspaceServiceDnsName(names.service, config.namespace)}.cluster.local`,
    ],
    usages: ["server auth", "digital signature", "key encipherment"],
    duration: "48h",
    renewBefore: "12h",
    privateKey: { algorithm: "ECDSA", size: 256, rotationPolicy: "Always" },
    issuerRef: {
      name: config.certManagerIssuer.name,
      kind: config.certManagerIssuer.kind,
      group: config.certManagerIssuer.group,
    },
    secretTemplate: { labels },
  },
});

export const buildService = (
  names: WorkspaceResourceNames,
  config: Pick<KubernetesRuntimeConfig, "namespace" | "controlPort" | "managedBy">,
  labels: Record<string, string>,
  runId: string,
): V1Service => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: { name: names.service, namespace: config.namespace, labels },
  spec: {
    type: "ClusterIP",
    selector: {
      [LABEL_MANAGED_BY]: config.managedBy,
      [LABEL_COMPONENT]: COMPONENT_WORKSPACE,
      [LABEL_RUN_ID]: labelSafe(runId),
    },
    ports: [
      {
        name: CONTROL_PORT_NAME,
        port: config.controlPort,
        targetPort: CONTROL_PORT_NAME,
        protocol: "TCP",
      },
    ],
  },
});

// ---------------------------------------------------------------------------------------------
// Pod
// ---------------------------------------------------------------------------------------------

export interface BuildPodInput {
  readonly names: WorkspaceResourceNames;
  readonly config: KubernetesRuntimeConfig;
  readonly labels: Record<string, string>;
  readonly input: RuntimeAdapterLaunchInput;
  readonly lowered: LoweredMounts;
  readonly plainEnv: ReadonlyArray<readonly [string, string]>;
  /** Keys present in the env Secret, in precedence order. */
  readonly secretEnvKeys: readonly string[];
  readonly launchSecret: V1Secret | undefined;
  readonly priorityClassName: string | undefined;
}

/** Env list with last-wins dedupe so a value never appears twice with the plaintext losing. */
const envList = (
  plain: ReadonlyArray<readonly [string, string]>,
  secretName: string,
  secretKeys: readonly string[],
): V1EnvVar[] => {
  const ordered = new Map<string, V1EnvVar>();
  for (const [name, value] of plain) {
    ordered.delete(name);
    ordered.set(name, { name, value });
  }
  for (const name of secretKeys) {
    ordered.delete(name);
    ordered.set(name, { name, valueFrom: { secretKeyRef: { name: secretName, key: name } } });
  }
  return [...ordered.values()];
};

export const buildPod = (build: BuildPodInput): V1Pod => {
  const { names, config, labels, input, lowered } = build;
  const volumes: V1Volume[] = [
    { name: "run-sealant", emptyDir: {} },
    { name: "tls", secret: { secretName: names.tlsSecret, defaultMode: 0o400 } },
    ...lowered.volumes.map((volume) => ({
      name: volume.name,
      persistentVolumeClaim: { ...volume.persistentVolumeClaim },
    })),
  ];
  const volumeMounts: V1VolumeMount[] = [
    { name: "run-sealant", mountPath: RUN_SEALANT_PATH },
    { name: "tls", mountPath: TLS_MOUNT_PATH, readOnly: true },
    ...lowered.volumeMounts.map((mount) => ({ ...mount })),
  ];
  if (build.launchSecret !== undefined) {
    const keys = Object.keys(build.launchSecret.data ?? {});
    volumes.push({
      name: "launch",
      secret: {
        secretName: names.launchSecret,
        defaultMode: 0o400,
        items: keys.map((key) => ({
          key,
          path:
            key === SECRET_ENV_KEY
              ? SECRET_ENV_KEY
              : key === "dotfiles-manifest"
                ? `${DOTFILES_SUBDIR}/manifest.json`
                : `${DOTFILES_SUBDIR}/${key.slice("dotfiles-".length)}.tar.gz`,
        })),
      },
    });
    volumeMounts.push({ name: "launch", mountPath: LAUNCH_MOUNT_PATH, readOnly: true });
  }

  const container: V1Container = {
    name: "workspace",
    image: input.publishedImage.digestReference,
    imagePullPolicy: "IfNotPresent",
    workingDir: input.blueprint.runtime.workingDirectory,
    env: envList(build.plainEnv, names.envSecret, build.secretEnvKeys),
    ports: [{ name: CONTROL_PORT_NAME, containerPort: config.controlPort, protocol: "TCP" }],
    volumeMounts,
    resources: {
      requests: { ...config.resources.requests },
      limits: { ...config.resources.limits },
    },
    securityContext: {
      privileged: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: false,
      capabilities: { drop: ["ALL"], add: [...WORKSPACE_CAPABILITIES] },
    },
  };

  const runtimeClassName =
    input.blueprint.runtime.ociRuntime === "runsc" ? config.gvisorRuntimeClass : undefined;

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: names.pod, namespace: config.namespace, labels },
    spec: {
      restartPolicy: "Never",
      serviceAccountName: config.workspaceServiceAccount,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 30,
      ...(build.priorityClassName === undefined
        ? {}
        : { priorityClassName: build.priorityClassName }),
      ...(runtimeClassName === undefined ? {} : { runtimeClassName }),
      ...(Object.keys(config.nodeSelector).length === 0
        ? {}
        : { nodeSelector: { ...config.nodeSelector } }),
      ...(config.imagePullSecret === undefined
        ? {}
        : { imagePullSecrets: [{ name: config.imagePullSecret }] }),
      ...(config.topologySpread
        ? {
            topologySpreadConstraints: [
              {
                maxSkew: 1,
                topologyKey: "kubernetes.io/hostname",
                whenUnsatisfiable: "ScheduleAnyway",
                labelSelector: {
                  matchLabels: {
                    [LABEL_MANAGED_BY]: config.managedBy,
                    [LABEL_COMPONENT]: COMPONENT_WORKSPACE,
                  },
                },
              },
            ],
          }
        : {}),
      securityContext: { seccompProfile: { type: "RuntimeDefault" } },
      volumes,
      containers: [container],
    },
  };
};
