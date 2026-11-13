/**
 * What each runtime supports, and the create-time refusals derived from it: one table, so the
 * report a client reads before a create (`GET /v1/workspaces/runtimes`) and the refusal of that
 * create cannot disagree. A create that asks a runtime for an item it marks unsupported is refused
 * with that item's sentence (`runtimeRefusal`); the adapters keep their own checks as a second
 * line, for what only the worker can see.
 *
 * The sentences are for a developer choosing a project's environment: plain words, no settings.
 */
import type {
  RuntimeArchitecture,
  RuntimeCapability,
  RuntimeOsFamily,
  RuntimeSupport,
  RuntimeUnsupported,
} from "@sealant/api-contracts";

import type { WorkspaceImagePlatform } from "./image-platform.js";
import type { RuntimeAdapterId } from "./runtime-adapter-ids.js";

export type {
  RuntimeArchitecture,
  RuntimeCapability,
  RuntimeOsFamily,
  RuntimeSupport,
  RuntimeUnsupported,
} from "@sealant/api-contracts";

/** What one install knows that changes the answers. Every field is read by the API. */
export interface RuntimeInstall {
  /** Kubernetes workspaces may run Docker inside (an operator decision). */
  readonly kubernetesDocker: boolean;
  /** MicroVM workspaces may run Docker inside (an operator decision). */
  readonly microvmDocker: boolean;
  /** The port the MicroVM guest agent listens on inside the VM. */
  readonly microvmAgentPort: number;
  /** The architecture Docker and Kubernetes workspaces are built for and run on. */
  readonly containerArchitecture: RuntimeArchitecture;
  /** Resources run on this install's Docker host, so a workspace may be linked to them. */
  readonly resourceHost: "docker" | "kubernetes" | "none";
  /**
   * Whether a worker that launches Boat workspaces has the resource gateway, the only way a Boat
   * workspace reaches resources (`boat_launch_reports`). Absent: not known here, and Boat follows
   * `resourceHost` alone.
   */
  readonly boatGateway?: boolean | undefined;
}

const SUPPORTED = { supported: true } as const;
const no = (message: string): RuntimeUnsupported => ({ supported: false, message });

/** A Kubernetes workspace's sealantd listens here (the per-workspace Service's default port). */
const KUBERNETES_CONTROL_PORT = 7443;
/** Boat's guest agent holds this port in every VM (`agent-contract.ts`). */
const BOAT_AGENT_PORT = 8080;

export const runtimeArchitectureOf = (platform: WorkspaceImagePlatform): RuntimeArchitecture =>
  platform === "linux/arm64" ? "aarch64" : "x86_64";

const NAMES: Readonly<Record<RuntimeAdapterId, string>> = {
  docker: "Docker",
  k8s: "Kubernetes",
  k3s: "k3s",
  cloudflare: "Cloudflare",
  microvm: "MicroVM",
  boat: "Boat",
};

const allOs = (): RuntimeSupport["os"] => ({
  ubuntu: SUPPORTED,
  nix: SUPPORTED,
  arch: SUPPORTED,
  fedora: SUPPORTED,
});

const clusterEnvOnlyOnKubernetes = (runtime: RuntimeAdapterId) =>
  no(
    `${NAMES[runtime]} workspaces cannot read Kubernetes Secrets, ConfigMaps or a service account; only Kubernetes workspaces can. Remove them from this workspace.`,
  );

const dockerOff = (runtime: "k8s" | "k3s" | "microvm") =>
  no(
    `Docker inside the workspace is not turned on for this deployment's ${runtime === "microvm" ? "MicroVM" : "Kubernetes"} workspaces. Turn Docker off for this workspace, or ask the deployment's operator to turn it on.`,
  );

const resourcesFor = (
  runtime: RuntimeAdapterId,
  install: RuntimeInstall,
): RuntimeSupport["resources"] => {
  if (runtime === "boat" && install.boatGateway === false)
    return no(
      "This install's Boat workspaces cannot reach project resources: its worker has no resource gateway. Create the workspace with runtime.resources: \"none\", or ask the install's operator to configure the gateway (SEALANT_BOAT_GATEWAY_HOST_ID).",
    );
  if (install.resourceHost === "docker" && (runtime === "docker" || runtime === "boat"))
    return { supported: true, attach: "live" };
  if (install.resourceHost === "kubernetes")
    return no(
      "On this deployment's Kubernetes cluster, a project's resources are reached only by the services they were made for; they cannot be linked to a workspace.",
    );
  return no(
    `This deployment runs no resources beside ${NAMES[runtime]} workspaces, so a project's resources cannot be linked to one.`,
  );
};

const containerScreen = (install: RuntimeInstall): RuntimeSupport["screen"] => ({
  supported: true,
  architectures: [install.containerArchitecture],
});

/** The whole table: what `runtime` supports on `install`. */
export const runtimeSupport = (
  runtime: RuntimeAdapterId,
  install: RuntimeInstall,
): RuntimeSupport => {
  const resources = resourcesFor(runtime, install);
  switch (runtime) {
    case "docker":
      return {
        runtime,
        os: allOs(),
        customImage: SUPPORTED,
        hostDirectories: SUPPORTED,
        docker: SUPPORTED,
        gvisor: SUPPORTED,
        clusterEnv: clusterEnvOnlyOnKubernetes(runtime),
        gitSource: SUPPORTED,
        dotfilesArchives: SUPPORTED,
        screen: containerScreen(install),
        reservedPorts: [],
        resources,
        idleCost: {
          charged: false,
          message:
            "A Docker workspace runs on this deployment's own servers: sitting idle costs nothing beyond them.",
        },
      };
    case "k8s":
    case "k3s":
      return {
        runtime,
        os: allOs(),
        customImage: SUPPORTED,
        hostDirectories: SUPPORTED,
        docker: install.kubernetesDocker ? SUPPORTED : dockerOff(runtime),
        gvisor: SUPPORTED,
        clusterEnv: SUPPORTED,
        gitSource: SUPPORTED,
        dotfilesArchives: SUPPORTED,
        screen: containerScreen(install),
        reservedPorts: [KUBERNETES_CONTROL_PORT],
        resources,
        idleCost: {
          charged: false,
          message:
            "A Kubernetes workspace runs on the cluster's own nodes: sitting idle costs nothing beyond them.",
        },
      };
    case "microvm":
      return {
        runtime,
        os: allOs(),
        customImage: SUPPORTED,
        hostDirectories: no(
          "A MicroVM cannot bind directories from this deployment's servers. Start the workspace from a capture or a repository instead.",
        ),
        docker: install.microvmDocker ? SUPPORTED : dockerOff(runtime),
        gvisor: no(
          "A MicroVM cannot run its workspace under gVisor (runsc): the VM itself isolates the workspace.",
        ),
        clusterEnv: clusterEnvOnlyOnKubernetes(runtime),
        gitSource: SUPPORTED,
        dotfilesArchives: SUPPORTED,
        screen: { supported: true, architectures: ["aarch64"] },
        reservedPorts: [install.microvmAgentPort],
        resources,
        idleCost: {
          charged: true,
          message: "AWS bills a MicroVM for as long as it runs, idle or not.",
        },
      };
    case "cloudflare":
      return {
        runtime,
        os: allOs(),
        customImage: SUPPORTED,
        hostDirectories: no(
          "A Cloudflare sandbox cannot bind directories from this deployment's servers. Start the workspace from a capture or a repository instead.",
        ),
        docker: no(
          "A Cloudflare sandbox cannot run Docker inside the workspace. Turn Docker off for this workspace.",
        ),
        gvisor: no(
          "A Cloudflare sandbox cannot run its workspace under gVisor (runsc): Cloudflare isolates the sandbox itself.",
        ),
        clusterEnv: clusterEnvOnlyOnKubernetes(runtime),
        gitSource: SUPPORTED,
        dotfilesArchives: SUPPORTED,
        screen: { supported: true, architectures: ["x86_64"] },
        reservedPorts: [],
        resources,
        idleCost: {
          charged: true,
          message: "Cloudflare bills a sandbox for as long as it runs, idle or not.",
        },
      };
    case "boat": {
      const os = (family: string) => no(`Boat supports Ubuntu and Nix; ${family} is unsupported.`);
      return {
        runtime,
        os: { ubuntu: SUPPORTED, nix: SUPPORTED, arch: os("Arch"), fedora: os("Fedora") },
        customImage: no("Boat cannot boot a custom OCI base image."),
        hostDirectories: no("Boat cannot bind directories from this deployment's own servers."),
        // Boat's VM is the workspace: its image carries the engine when the blueprint asks for it.
        docker: SUPPORTED,
        gvisor: no("Boat cannot supply the runsc OCI runtime."),
        clusterEnv: no("Boat cannot resolve Kubernetes environment references."),
        gitSource: no(
          "Boat starts a workspace only from a capture of its files, not by cloning a repository.",
        ),
        dotfilesArchives: no(
          "Boat cannot apply dotfiles sent as archives with the create. Name a dotfiles repository instead.",
        ),
        screen: { supported: true, architectures: ["x86_64"] },
        reservedPorts: [BOAT_AGENT_PORT],
        resources,
        idleCost: {
          charged: true,
          message: "Boat bills a workspace by the second while its VM runs, idle or not.",
        },
      };
    }
  }
};

/** The parts of a workspace spec the table answers for. */
export interface RuntimeRequest {
  readonly target: {
    readonly os: { readonly family: string; readonly baseImage?: string | undefined };
  };
  readonly runtime: {
    readonly ociRuntime: string;
    readonly envFrom: readonly { readonly kind: string; readonly name: string }[];
    readonly kubernetes: { readonly serviceAccountName?: string | undefined };
    readonly dotfilesArchives: readonly unknown[];
  };
  readonly sources: {
    readonly workspace: { readonly kind: string };
    readonly mounts: readonly unknown[];
  };
  readonly tooling: {
    readonly services?: { readonly docker?: { readonly enabled: boolean } | undefined } | undefined;
  };
}

/** The refusal codes released SDKs match on; each maps to its own HTTP error. */
export type RuntimeRefusalCode =
  | "runtime-os-unsupported"
  | "runtime-requirement-unsupported"
  | "workspace-docker-unsupported"
  | "runtime-env-references-unsupported";

export interface RuntimeRefusal {
  readonly code: RuntimeRefusalCode;
  /** A stable name for the item refused, for the image builders' own errors. */
  readonly detail: string;
  readonly message: string;
}

/** The items of the table a create can ask for, in the order a create is checked. */
export type RuntimeRequirement =
  | "os"
  | "customImage"
  | "gvisor"
  | "hostDirectories"
  | "clusterEnv"
  | "gitSource"
  | "dotfilesArchives"
  | "docker";

const REQUIREMENTS: readonly RuntimeRequirement[] = [
  "os",
  "customImage",
  "gvisor",
  "hostDirectories",
  "clusterEnv",
  "gitSource",
  "dotfilesArchives",
  "docker",
];

const DETAILS: Readonly<Record<RuntimeRequirement, string>> = {
  os: "native-unsupported-os",
  customImage: "native-custom-base-unsupported",
  gvisor: "native-oci-runtime-unsupported",
  hostDirectories: "native-host-bind-unsupported",
  clusterEnv: "native-cluster-env-unsupported",
  gitSource: "native-capture-source-required",
  dotfilesArchives: "native-dotfiles-archives-unsupported",
  docker: "workspace-docker-unsupported",
};

const isManagedFamily = (family: string): family is RuntimeOsFamily =>
  family === "ubuntu" || family === "nix" || family === "arch" || family === "fedora";

/** The table's item `requirement` asks of `support` for this request, or none. */
const askedOf = (
  support: RuntimeSupport,
  requirement: RuntimeRequirement,
  request: RuntimeRequest,
): RuntimeCapability | undefined => {
  switch (requirement) {
    case "os": {
      const family = request.target.os.family;
      return isManagedFamily(family) ? support.os[family] : undefined;
    }
    case "customImage":
      return request.target.os.family === "custom" || request.target.os.baseImage !== undefined
        ? support.customImage
        : undefined;
    case "gvisor":
      return request.runtime.ociRuntime === "runsc" ? support.gvisor : undefined;
    case "hostDirectories": {
      const kind = request.sources.workspace.kind;
      return kind === "mount" || kind === "standby" || request.sources.mounts.length > 0
        ? support.hostDirectories
        : undefined;
    }
    case "clusterEnv":
      return request.runtime.envFrom.length > 0 ||
        request.runtime.kubernetes.serviceAccountName !== undefined
        ? support.clusterEnv
        : undefined;
    case "gitSource":
      return request.sources.workspace.kind === "git" ? support.gitSource : undefined;
    case "dotfilesArchives":
      return request.runtime.dotfilesArchives.length > 0 ? support.dotfilesArchives : undefined;
    case "docker":
      return request.tooling.services?.docker?.enabled === true ? support.docker : undefined;
  }
};

const codeOf = (runtime: RuntimeAdapterId, requirement: RuntimeRequirement): RuntimeRefusalCode => {
  if (requirement === "os") return "runtime-os-unsupported";
  if (requirement === "docker") return "workspace-docker-unsupported";
  if (requirement === "clusterEnv" && runtime !== "boat")
    return "runtime-env-references-unsupported";
  return "runtime-requirement-unsupported";
};

/** What a refusal adds to its item's sentence: the names a request gave, where it gave any. */
const requestedNames = (requirement: RuntimeRequirement, request: RuntimeRequest) => {
  if (requirement !== "clusterEnv") return "";
  const serviceAccount = request.runtime.kubernetes.serviceAccountName;
  const names = [
    ...request.runtime.envFrom.map((binding) => `${binding.kind}/${binding.name}`),
    ...(serviceAccount === undefined ? [] : [`serviceAccount ${serviceAccount}`]),
  ];
  return ` This workspace names ${names.join(", ")}.`;
};

/**
 * The first item this request asks of the runtime that the runtime does not support, as the
 * refusal a create answers with; `undefined` when the runtime supports everything it asks.
 * `only` limits the check to some items (an image builder asks about the image alone).
 */
export const runtimeRefusal = (
  support: RuntimeSupport,
  request: RuntimeRequest,
  only: readonly RuntimeRequirement[] = REQUIREMENTS,
): RuntimeRefusal | undefined => {
  for (const requirement of REQUIREMENTS) {
    if (!only.includes(requirement)) continue;
    const asked = askedOf(support, requirement, request);
    if (asked === undefined || asked.supported) continue;
    const code = codeOf(support.runtime, requirement);
    return {
      code,
      detail: DETAILS[requirement],
      message:
        code === "runtime-env-references-unsupported"
          ? `${asked.message}${requestedNames(requirement, request)}`
          : asked.message,
    };
  }
  return undefined;
};
