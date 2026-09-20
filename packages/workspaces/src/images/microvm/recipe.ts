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
export const MICROVM_RECIPE_VERSION = "1";

/** Files the recipe copies in, relative to the build context. The builder supplies their bytes. */
export const MICROVM_AGENT_FILES = ["agent.mjs", "docker-service.mjs"] as const;

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
}

export interface MicrovmRecipe {
  readonly containerfile: string;
  /** Names the image and keys its reuse. Distinct from the container plan's own hash. */
  readonly planHash: string;
}

const ENTRYPOINT = /^ENTRYPOINT \[.*\]\s*$/m;
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
  const agentLayer = [
    "# The agent needs node. A distro family installs it with the harness; a custom base image",
    "# has to bring it, and says so here rather than at the first launch.",
    "RUN node --version",
    `COPY ${MICROVM_AGENT_FILES.join(" ")} /opt/sealant/`,
    `ENV SEALANT_MICROVM_AGENT_PORT=${String(settings.agentPort)}`,
    'RUN mkdir -p /workspace /run/sealant && git config --system safe.directory "*"',
    'ENTRYPOINT ["node", "/opt/sealant/agent.mjs"]',
  ].join("\n");
  const containerfile = planned.containerfile
    .replace(
      FROM_LINE,
      (_line, reference: string, rest: string) => `FROM ${mirroredBaseImage(reference)}${rest}`,
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
