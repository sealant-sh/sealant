/**
 * The recipe of a workspace image for Lambda MicroVMs (docs/workspace-image-builders-design.md,
 * D4): the Containerfile planned for the blueprint, exactly as the Docker and Kubernetes builders
 * build it, with the MicroVM agent layered on top.
 *
 * A MicroVM's root filesystem need not be Amazon Linux. On 2026-09-20 the managed image build
 * took `FROM public.ecr.aws/docker/library/fedora:41` with Fedora packages, built it and booted
 * it through the `ready` and `validate` hooks. So the blueprint's OS family, custom base image,
 * packages and shell reach a MicroVM the way they reach a container.
 *
 * Pure: no filesystem, no AWS. The plan hash covers everything here, so a change to the agent
 * layer, the daemon or the image settings builds new images instead of reusing old ones.
 */
import { createHash } from "node:crypto";

import type { PlannedWorkspaceImageBuild } from "../../buildkit/index.js";

/** Bump when the agent layer below changes in a way old images must not be reused across. */
export const MICROVM_RECIPE_VERSION = "2";

/** Files the recipe copies in, relative to the build context. The builder supplies their bytes. */
export const MICROVM_AGENT_FILES = ["agent.mjs", "docker-service.mjs"] as const;
/** Copied in as well when the blueprint asks for the workspace's own Docker. */
export const MICROVM_DOCKER_FILES = ["download-docker.sh"] as const;
/** Copied in for an Arch blueprint: the key the Arch Linux ARM rootfs is verified against. */
export const MICROVM_ARCH_FILES = ["archlinuxarm-builder.asc"] as const;
export type MicrovmContextFile =
  | (typeof MICROVM_AGENT_FILES)[number]
  | (typeof MICROVM_DOCKER_FILES)[number]
  | (typeof MICROVM_ARCH_FILES)[number];

/**
 * Arch on ARM64. Docker Hub's `archlinux` image is x86_64 only, and a MicroVM is ARM64. The
 * official ARM port, Arch Linux ARM, ships a rootfs tarball instead of an image, signed by its
 * build system key (fingerprint below, checked against a downloaded tarball on 2026-09-20). A
 * first stage fetches the tarball and its signature over the project's mirrors, verifies the
 * signature against the key shipped in the build context, and unpacks it; the image proper starts
 * from that filesystem. `pacman-key --populate archlinuxarm` then trusts the port's package keys.
 */
export const ARCHLINUXARM_KEY_FINGERPRINT = "68B3537F39A313B3E574D06777193F152BDBE6A6";
const ARCHLINUXARM_ROOTFS = "http://os.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz";
const archlinuxArmPrelude = (fetchStageImage: string): string =>
  [
    `FROM ${fetchStageImage} AS archlinuxarm`,
    "RUN dnf -y install gnupg2 curl tar && dnf clean all",
    "COPY archlinuxarm-builder.asc /tmp/archlinuxarm-builder.asc",
    "RUN set -eu; gpg --batch --import /tmp/archlinuxarm-builder.asc; \\",
    `    gpg --batch --list-keys --with-colons | grep -q '^fpr:.*:${ARCHLINUXARM_KEY_FINGERPRINT}:'; \\`,
    `    curl -fsSL --retry 3 -o /tmp/rootfs.tar.gz ${ARCHLINUXARM_ROOTFS}; \\`,
    `    curl -fsSL --retry 3 -o /tmp/rootfs.tar.gz.sig ${ARCHLINUXARM_ROOTFS}.sig; \\`,
    "    gpg --batch --verify /tmp/rootfs.tar.gz.sig /tmp/rootfs.tar.gz; \\",
    "    mkdir /rootfs && tar -xpf /tmp/rootfs.tar.gz --numeric-owner -C /rootfs && rm /tmp/rootfs.tar.gz*",
    "FROM scratch",
    "COPY --from=archlinuxarm /rootfs /",
    "RUN pacman-key --init && pacman-key --populate archlinuxarm",
  ].join("\n");

/**
 * What guest-local Docker needs beside the engine itself: network namespaces and the tools
 * `download-docker.sh` runs with. Named per package manager, since the recipe keeps the
 * blueprint's distro. A family without an entry cannot carry the Docker service on a MicroVM.
 */
const DOCKER_SERVICE_PACKAGES: Readonly<Record<string, string>> = {
  fedora: "dnf -y install iproute iptables-nft kmod curl tar && dnf clean all",
  // Arch ships iptables-nft in place of iptables; `--needed` keeps whichever is present.
  arch: "pacman -Sy --noconfirm --needed iproute2 iptables-nft kmod curl tar",
  ubuntu:
    "apt-get update && apt-get install -y --no-install-recommends iproute2 iptables kmod curl tar ca-certificates && rm -rf /var/lib/apt/lists/*",
  // The same profile the family's own packages go into (buildkit-builder.ts); the engine and the
  // plugins are static binaries under /usr/local from download-docker.sh, on every family.
  nix: "nix profile add --priority 6 --accept-flake-config --extra-experimental-features 'nix-command flakes' nixpkgs#iproute2 nixpkgs#iptables nixpkgs#kmod nixpkgs#curl nixpkgs#gnutar",
};

export const microvmDockerServiceFamilies = (): readonly string[] =>
  Object.keys(DOCKER_SERVICE_PACKAGES);

const DOCKER_HUB_LIBRARY_MIRROR = "public.ecr.aws/docker/library/";

/**
 * Official Docker Hub images (`fedora:41`, `archlinux:latest`) are pulled from their public ECR
 * mirror: the managed build runs on shared AWS addresses, where anonymous Docker Hub pulls are
 * rate limited, and the build role then needs no registry permission. A reference that names a
 * registry or a namespace (a project's own base image) is left exactly as written.
 */
export const mirroredBaseImage = (reference: string): string => {
  const name = reference.split(/[:@]/, 1)[0] ?? reference;
  return name.includes("/") || name.includes(".")
    ? reference
    : `${DOCKER_HUB_LIBRARY_MIRROR}${reference}`;
};

export interface MicrovmRecipeSettings {
  /** The port the agent listens on and the image registers for hooks. */
  readonly agentPort: number;
  /** `minimumMemoryInMiB`: vCPU and disk follow from it on the platform. */
  readonly memoryMiB: number;
  /**
   * The blueprint asks for a Docker daemon of its own. The image then carries the engine and is
   * created with the image-level `ALL` OS capability, which only such a workspace receives.
   */
  readonly dockerService: boolean;
  /**
   * A digest of the files the recipe copies in. They are not in the Containerfile's text, so
   * without this a release that changed the agent would go on booting images with the old one.
   */
  readonly contextDigest: string;
}

export interface MicrovmRecipe {
  readonly containerfile: string;
  /** Names the image and keys its reuse. Distinct from the container plan's own hash. */
  readonly planHash: string;
}

const ENTRYPOINT = /^ENTRYPOINT \[.*\]\s*$/m;
/** The planned Containerfile copies the daemon out of its released image; the client sits beside it. */
const SEALANTD_COPY =
  /^COPY .*--from=(\S+) \/usr\/local\/bin\/sealantd \/usr\/local\/bin\/sealantd\s*$/m;
const FROM_LINE = /^FROM (\S+)(.*)$/m;

/**
 * The planned Containerfile ends in `ENTRYPOINT ["/usr/local/bin/sealantd", "boot"]`: a container
 * starts the daemon directly. A MicroVM starts the agent, which answers the platform's lifecycle
 * hooks and starts `sealantd boot` when the launch is pushed to it.
 */
export const microvmRecipe = (
  planned: PlannedWorkspaceImageBuild,
  settings: MicrovmRecipeSettings,
): MicrovmRecipe => {
  if (!ENTRYPOINT.test(planned.containerfile) || !FROM_LINE.test(planned.containerfile)) {
    throw new Error(
      "The planned Containerfile has no FROM or ENTRYPOINT line to build a MicroVM recipe on.",
    );
  }
  const fromLine = FROM_LINE.exec(planned.containerfile);
  const sealantdImage = SEALANTD_COPY.exec(planned.containerfile)?.[1];
  if (sealantdImage === undefined) {
    throw new Error(
      "The planned Containerfile copies no sealantd from a released image, so the MicroVM recipe cannot take sealantctl from beside it.",
    );
  }
  const dockerPackages = DOCKER_SERVICE_PACKAGES[planned.osFamily];
  if (settings.dockerService && dockerPackages === undefined) {
    throw new Error(
      `Workspace-scoped Docker on a MicroVM needs one of the ${microvmDockerServiceFamilies().join(", ")} OS families; this blueprint resolves to ${planned.osFamily}.`,
    );
  }
  const dockerLayer =
    !settings.dockerService || dockerPackages === undefined
      ? []
      : [
          "# Guest-local Docker: the engine, pinned by checksum, and what its networking needs.",
          `RUN ${dockerPackages}`,
          "COPY --chmod=755 download-docker.sh /opt/sealant/download-docker.sh",
          "RUN /opt/sealant/download-docker.sh && rm /opt/sealant/download-docker.sh",
          "ENV SEALANT_MICROVM_DOCKER_CAPABLE=1",
          "RUN mkdir -p /run/docker /var/lib/sealant/docker && chmod 0700 /run/docker /var/lib/sealant/docker",
        ];
  const agentLayer = [
    ...dockerLayer,
    "# The agent needs node. A distro family installs it with the harness; a custom base image",
    "# has to bring it, and says so here rather than at the first launch.",
    "RUN node --version",
    "# The platform's suspend and terminate hooks reach the agent with no control plane connected,",
    "# so the agent flushes captures itself, with the daemon's own client.",
    `COPY --chmod=755 --from=${sealantdImage} /usr/local/bin/sealantctl /usr/local/bin/sealantctl`,
    `COPY ${MICROVM_AGENT_FILES.join(" ")} /opt/sealant/`,
    `ENV SEALANT_MICROVM_AGENT_PORT=${String(settings.agentPort)}`,
    'RUN mkdir -p /workspace /run/sealant && git config --system safe.directory "*"',
    'ENTRYPOINT ["node", "/opt/sealant/agent.mjs"]',
  ].join("\n");
  const containerfile = planned.containerfile
    .replace(FROM_LINE, (_line, reference: string, rest: string) =>
      planned.osFamily === "arch" && fromLine !== null
        ? archlinuxArmPrelude(mirroredBaseImage("fedora:41"))
        : `FROM ${mirroredBaseImage(reference)}${rest}`,
    )
    .replace(ENTRYPOINT, agentLayer);
  const planHash = createHash("sha256")
    .update(
      JSON.stringify({
        recipe: MICROVM_RECIPE_VERSION,
        container: planned.planHash,
        containerfile,
        settings,
      }),
    )
    .digest("hex");
  return { containerfile, planHash };
};

export const MICROVM_IMAGE_NAME_PREFIX = "sealant-ws";

/** `sealant-ws-<24 hex>`: an image name is 1 to 64 of `[A-Za-z0-9-_]`, and one plan is one image. */
export const microvmImageName = (planHash: string, prefix = MICROVM_IMAGE_NAME_PREFIX): string =>
  `${prefix}-${planHash.slice(0, 24)}`;

/**
 * Whose image a name says it is. `ListMicrovmImages` returns no tags (read 2026-09-20), so the
 * name is the only thing a listing can count or sweep by. Two control planes that share an AWS
 * account take different prefixes, or each would count and sweep the other's images.
 */
export const isMicrovmImageNameOf = (name: string, prefix: string): boolean =>
  name.startsWith(`${prefix}-`) && /^[0-9a-f]{24}$/.test(name.slice(prefix.length + 1));
