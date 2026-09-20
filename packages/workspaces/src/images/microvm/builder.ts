/**
 * Builds a blueprint's workspace image for Lambda MicroVMs
 * (docs/workspace-image-builders-design.md, D4).
 *
 * The recipe is the Containerfile every other builder builds, with the MicroVM agent on top
 * (`./recipe.ts`). AWS's managed image build runs it, under a build role that can read one
 * artifacts prefix and nothing else, so a tenant's base image never runs on the control plane or
 * with its credentials. Nothing here needs Docker.
 *
 * One plan is one image. The image is named by the plan hash, so a second workspace with the same
 * plan finds it by name and builds nothing, whatever the job table says. That is the fault that
 * left 513 build directories on a host worker in 2026-09; on AWS it would pile up images where
 * nothing fills up to warn anyone. A cap refuses to go past a configured number of images.
 */
import { randomUUID } from "node:crypto";

import type { NewWorkspace, WorkspaceBuild } from "@sealant/validators";

import { planWorkspaceImageBuild, type PlannedWorkspaceImageBuild } from "../../buildkit/index.js";
import { microvmImageReference } from "../../runtime/microvm/image-reference.js";
import type { PublishedImage } from "../../runtime/runtime-adapter.js";
import type {
  BuildAndPublishInput,
  BuildAndPublishResult,
  WorkspaceImageBuilder,
} from "../image-builder.js";
import type {
  MicrovmArtifactStore,
  MicrovmImageApi,
  MicrovmImageDescription,
} from "./image-api.js";
import {
  isMicrovmImageNameOf,
  MICROVM_AGENT_FILES,
  MICROVM_ARCH_FILES,
  MICROVM_DOCKER_FILES,
  microvmImageName,
  microvmRecipe,
  type MicrovmContextFile,
} from "./recipe.js";
import { zipStored, type ZipEntry } from "./zip.js";

/**
 * For a person reading the console. Nothing here decides by them: a listing carries no tags, so
 * the cap and retention tell this builder's images by name (`imageNamePrefix`).
 */
export const MICROVM_IMAGE_MANAGED_TAG = "sealant:workspace-image";
export const MICROVM_IMAGE_PLAN_TAG = "sealant:plan-hash";

export interface MicrovmImageBuildConfig {
  /** The managed base the platform boots under the recipe's root filesystem (`…:al2023-1`). */
  readonly baseImageArn: string;
  /** Read-only on `artifactPrefix`, plus the two log actions. Nothing else. */
  readonly buildRoleArn: string;
  /** Key prefix in the artifacts bucket, without a trailing slash. */
  readonly artifactPrefix: string;
  readonly memoryMiB: number;
  readonly agentPort: number;
  readonly logGroup?: string | undefined;
  /**
   * Every image is named `<prefix>-<plan hash>`, and a name with this prefix is this builder's.
   * Two control planes that share an AWS account take different prefixes.
   */
  readonly imageNamePrefix: string;
  /**
   * Whether the operator allows workspace-scoped Docker. Without it no image is ever created with
   * the elevated OS capability, whatever a blueprint asks for.
   */
  readonly dockerService: boolean;
  /** Past this many images of its own the builder refuses to create another. */
  readonly maxImages: number;
  readonly pollIntervalMs: number;
  readonly buildTimeoutMs: number;
}

export interface MicrovmWorkspaceImageBuilderOptions {
  readonly api: MicrovmImageApi;
  readonly artifacts: MicrovmArtifactStore;
  readonly config: MicrovmImageBuildConfig;
  /**
   * The files the recipe copies in, read from where the release put them on the worker. Never
   * read back from the artifacts bucket: a build role can write nothing there, and this keeps it
   * that way even if one ever could.
   */
  readonly readContextFile: (name: MicrovmContextFile) => Promise<Uint8Array>;
  /** A digest of those files, so a release that changes the agent builds new images. */
  readonly contextDigest: string;
  /** Test seams. */
  readonly planWorkspaceSpec?: (spec: NewWorkspace) => PlannedWorkspaceImageBuild;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly uniqueId?: () => string;
}

export class MicrovmImageBuildError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MicrovmImageBuildError";
    this.code = code;
  }
}

const READY: ReadonlySet<MicrovmImageDescription["state"]> = new Set(["CREATED", "UPDATED"]);
const IN_PROGRESS: ReadonlySet<MicrovmImageDescription["state"]> = new Set([
  "CREATING",
  "UPDATING",
  "DELETING",
]);

export class MicrovmWorkspaceImageBuilder implements WorkspaceImageBuilder {
  // AWS's managed image build: recipe steps run on the platform, under the build role.
  readonly isolation = "isolated" as const;

  readonly #options: MicrovmWorkspaceImageBuilderOptions;

  constructor(options: MicrovmWorkspaceImageBuilderOptions) {
    this.#options = options;
  }

  readonly plan = (spec: NewWorkspace): PlannedWorkspaceImageBuild => {
    const planned = (
      this.#options.planWorkspaceSpec ??
      ((blueprint: NewWorkspace) => planWorkspaceImageBuild({ blueprint }))
    )(spec);
    const recipe = microvmRecipe(planned, {
      agentPort: this.#options.config.agentPort,
      memoryMiB: this.#options.config.memoryMiB,
      dockerService: wantsDockerService(spec),
      contextDigest: this.#options.contextDigest,
    });
    return { ...planned, containerfile: recipe.containerfile, planHash: recipe.planHash };
  };

  readonly buildAndPublish = async (
    input: BuildAndPublishInput,
  ): Promise<BuildAndPublishResult> => {
    if (wantsDockerService(input.spec) && !this.#options.config.dockerService) {
      throw new MicrovmImageBuildError(
        "microvm-image-docker-disabled",
        "Workspace-scoped Docker (tooling.services.docker) is not enabled on this Lambda MicroVM deployment (SEALANT_MICROVM_DOCKER_ENABLED). Nothing was built.",
      );
    }
    const planned = this.plan(input.spec);
    const name = microvmImageName(planned.planHash, this.#options.config.imageNamePrefix);

    let image = await this.#settled(name);
    let built = false;
    if (image !== undefined && !READY.has(image.state)) {
      // A failed build leaves a name that can never become an image. Clear it and build again.
      await this.#options.api.deleteImage(name);
      image = await this.#settled(name);
    }
    if (image === undefined) {
      image = await this.#build(name, planned, wantsDockerService(input.spec));
      built = true;
    }

    const version = image.latestActiveImageVersion;
    if (version === undefined) {
      throw new MicrovmImageBuildError(
        "microvm-image-no-version",
        `The MicroVM image ${name} is ${image.state} and names no active version.`,
      );
    }
    const reference = microvmImageReference(image.imageArn, version);
    const publishedImage: PublishedImage = {
      repository: name,
      tag: version,
      reference,
      digestReference: reference,
      // The recipe's own content hash: what this image was built from.
      digest: `sha256:${planned.planHash}`,
    };
    const build: WorkspaceBuild = {
      builder: { id: planned.osFamily, osFamily: planned.osFamily },
      artifacts: [{ kind: "oci-image", name, reference }],
      metadata: {
        defaultArtifactName: name,
        notes: [
          built
            ? `Built the MicroVM image ${name} for plan ${planned.planHash} with the managed image build.`
            : `Reused the MicroVM image ${name}: plan ${planned.planHash} was already built; nothing was built or uploaded.`,
        ],
        planHash: planned.planHash,
      },
    };
    return { publishedImage, build };
  };

  /** The image by name once it is no longer changing; undefined when there is none. */
  async #settled(name: string): Promise<MicrovmImageDescription | undefined> {
    const sleep = this.#options.sleep ?? defaultSleep;
    const now = this.#options.now ?? Date.now;
    const deadline = now() + this.#options.config.buildTimeoutMs;
    for (;;) {
      const image = await this.#options.api.getImage(name);
      if (image === undefined || !IN_PROGRESS.has(image.state)) return image;
      if (now() >= deadline) {
        throw new MicrovmImageBuildError(
          "microvm-image-build-timeout",
          `The MicroVM image ${name} was still ${image.state} after ${String(this.#options.config.buildTimeoutMs)} ms.`,
        );
      }
      await sleep(this.#options.config.pollIntervalMs);
    }
  }

  async #build(
    name: string,
    planned: PlannedWorkspaceImageBuild,
    dockerService: boolean,
  ): Promise<MicrovmImageDescription> {
    const { api, artifacts, config } = this.#options;
    // By name: a listing carries no tags.
    const own = (await api.listImages(config.imageNamePrefix)).filter((candidate) =>
      isMicrovmImageNameOf(candidate.name, config.imageNamePrefix),
    );
    if (own.length >= config.maxImages) {
      throw new MicrovmImageBuildError(
        "microvm-image-cap",
        `This control plane already holds ${String(own.length)} MicroVM workspace images, its configured maximum (${String(config.maxImages)}). Nothing was built. Image retention frees unused ones; raise SEALANT_MICROVM_MAX_IMAGES if every one is in use.`,
      );
    }

    const entries: ZipEntry[] = [
      { name: "Dockerfile", content: Buffer.from(planned.containerfile, "utf8") },
    ];
    for (const file of [
      ...MICROVM_AGENT_FILES,
      ...(dockerService ? MICROVM_DOCKER_FILES : []),
      ...(planned.osFamily === "arch" ? MICROVM_ARCH_FILES : []),
    ]) {
      entries.push({ name: file, content: await this.#options.readContextFile(file) });
    }
    // An unguessable key: a build role cannot list the bucket, so it cannot find another build's.
    const attempt = (this.#options.uniqueId ?? randomUUID)();
    const key = `${config.artifactPrefix}/${attempt}.zip`;
    const uri = await artifacts.put(key, zipStored(entries));
    try {
      await api.createImage({
        name,
        description: `Sealant workspace image, plan ${planned.planHash.slice(0, 12)} (${planned.osFamily})`,
        baseImageArn: config.baseImageArn,
        buildRoleArn: config.buildRoleArn,
        codeArtifactUri: uri,
        memoryMiB: config.memoryMiB,
        agentPort: config.agentPort,
        logGroup: config.logGroup,
        // Only an image that carries guest-local Docker is given the elevated capability.
        allOsCapabilities: dockerService,
        tags: {
          [MICROVM_IMAGE_MANAGED_TAG]: "true",
          [MICROVM_IMAGE_PLAN_TAG]: planned.planHash,
        },
        // One token per attempt, never the plan hash. The name already makes one plan one image.
        // A plan is built again after its image was deleted (retention, or a failed build that
        // was cleared), and a token the platform has already completed left that second create in
        // CREATING with no build running, where it cannot even be deleted (observed 2026-09-20).
        clientToken: attempt,
      });
      const image = await this.#settled(name);
      if (image === undefined || !READY.has(image.state)) {
        throw new MicrovmImageBuildError(
          "microvm-image-build-failed",
          `The managed build of the MicroVM image ${name} ended ${image?.state ?? "with no image"}${
            image?.stateReason === undefined ? "" : `: ${image.stateReason}`
          }. The build log is in the image's log group.`,
        );
      }
      return image;
    } finally {
      // The context is needed only while the build reads it. Built, failed or timed out, it goes.
      await artifacts.remove(key).catch(() => undefined);
    }
  }
}

const wantsDockerService = (spec: NewWorkspace): boolean =>
  spec.tooling.services?.docker?.enabled === true;

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
