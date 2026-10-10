/**
 * Image build + publish behind one interface (design §D7).
 *
 * The worker's build phase used to be two Docker-CLI steps glued together: `docker build` +
 * `docker save` in the compiler, then `docker load` + `tag` + `push` in the registry client. That
 * is fine on a host with `/var/run/docker.sock` and impossible in a Kubernetes worker Pod.
 * `WorkspaceImageBuilder` keeps the plan (blueprint → Containerfile → plan hash) shared and makes
 * the build/publish mechanism pluggable:
 *
 *   - `createDockerWorkspaceImageBuilder` is the existing behaviour, byte for byte;
 *   - `KubernetesWorkspaceImageBuilder` (`./kubernetes/`) runs one rootless BuildKit Job per build
 *     that pushes straight to the registry.
 */
import type { NewWorkspace, WorkspaceBuild, WorkspaceImagePlatform } from "@sealant/validators";

import {
  buildContextDirectoryOf,
  compileWorkspaceBuildSpec,
  localImageNameOf,
  planWorkspaceImageBuild,
  PLAN_HASH_LABEL,
  readWorkspaceImageProbe,
  removeBuildContext,
  runBuildkitCommand,
  type BuildkitCommandRunner,
  type BuildkitCompilerOptions,
  type ImageBuildProgress,
  type PlannedWorkspaceImageBuild,
} from "../buildkit/index.js";
import type { RegistryClient } from "../registry/index.js";
import type { PublishedImage } from "../runtime/runtime-adapter.js";

export interface BuildAndPublishInput {
  readonly spec: NewWorkspace;
  readonly repository: string;
  readonly tag: string;
  /** Keys Job/ConfigMap names and logs; the build job id in practice. */
  readonly buildId?: string;
  /**
   * Called with the build's progress as the builder reports it (step N of M, last output). A
   * builder that cannot observe its build never calls it.
   */
  readonly onProgress?: (progress: ImageBuildProgress) => void;
  /**
   * Aborts when the build must stop: its worker lost the job's claim, or the build ran past the
   * worker's bound. A builder that can stop its build does; the job is failed either way.
   */
  readonly signal?: AbortSignal;
}

export interface FindPublishedInput {
  readonly planned: PlannedWorkspaceImageBuild;
  /** The plan's coordinates (`planImageCoordinates`): where a build of it was published. */
  readonly repository: string;
  readonly tag: string;
}

export interface BuildAndPublishResult {
  readonly publishedImage: PublishedImage;
  /** What the job row records as `resultPayload`; shape is the compiler's build result. */
  readonly build: WorkspaceBuild;
}

/**
 * Where a blueprint's recipe steps run (docs/workspace-image-builders-design.md, D3).
 * `host`: they share the control plane's kernel, Docker daemon or credentials. Fine on a
 * single-user install, where the tenant is the operator. `isolated`: they run somewhere that
 * cannot reach the control plane or its credentials.
 */
export type WorkspaceImageBuilderIsolation = "host" | "isolated";

export interface WorkspaceImageBuilder {
  readonly isolation: WorkspaceImageBuilderIsolation;
  /**
   * Docker-free planning: blueprint → OS family → Containerfile → plan hash. Undefined when the
   * builder cannot plan (a custom compiler without a matching planner) — callers then skip the
   * plan-hash short-circuit.
   */
  readonly plan: ((spec: NewWorkspace) => PlannedWorkspaceImageBuild) | undefined;
  readonly buildAndPublish: (input: BuildAndPublishInput) => Promise<BuildAndPublishResult>;
  /**
   * The image an earlier build of this exact plan left in the store, when the builder can tell it
   * is there and read its probe back: a launch then uses it and nothing is built. This is the
   * fallback for when no recorded publish of the plan exists (a fresh database over a Docker
   * Engine that kept its images). Null when there is none, or it cannot be vouched for.
   */
  readonly findPublished?: (input: FindPublishedInput) => Promise<BuildAndPublishResult | null>;
}

export interface DockerWorkspaceImageBuilderOptions {
  readonly registryClient: RegistryClient;
  /** What images are built for: the Docker daemon's own architecture (`dockerDaemonImagePlatform`). */
  readonly platform: WorkspaceImagePlatform;
  /** Test seams, mirroring the build job's historical `compileWorkspaceSpec` / `planWorkspaceSpec`. */
  readonly compileWorkspaceSpec?: (spec: NewWorkspace) => Promise<WorkspaceBuild>;
  readonly planWorkspaceSpec?: (spec: NewWorkspace) => PlannedWorkspaceImageBuild;
  /** Fails a build that writes nothing for this long (`BuildkitCompilerOptions.stallTimeoutMs`). */
  readonly stallTimeoutMs?: number;
  /** BuildKit's layer cache between builds (`BuildkitCompilerOptions.cacheDirectory`). */
  readonly cacheDirectory?: string;
  /** Test seam: runs `docker` for the image probe of an image found in the Engine. */
  readonly commandRunner?: BuildkitCommandRunner;
}

const isPublishableOciImageArtifact = (
  artifact: WorkspaceBuild["artifacts"][number],
): artifact is WorkspaceBuild["artifacts"][number] & {
  kind: "oci-image";
  path: string;
  loader: "docker-load";
} =>
  artifact.kind === "oci-image" && artifact.path !== undefined && artifact.loader === "docker-load";

const isEngineOciImageArtifact = (
  artifact: WorkspaceBuild["artifacts"][number],
): artifact is WorkspaceBuild["artifacts"][number] & {
  kind: "oci-image";
  reference: string;
  loader: "docker-engine";
} =>
  artifact.kind === "oci-image" &&
  artifact.reference !== undefined &&
  artifact.loader === "docker-engine";

/**
 * The Docker/self-host builder. With a registry store: compile to a tarball, then
 * `docker load/tag/push` (unchanged). With the local Engine store (`imageTransport: "engine"`):
 * `docker build` already left the image in the Engine workspaces launch from, so the compiler skips
 * `docker save` and the store only tags it — no tarball is written or read.
 */
export const createDockerWorkspaceImageBuilder = (
  options: DockerWorkspaceImageBuilderOptions,
): WorkspaceImageBuilder => {
  const engineTransport = options.registryClient.imageTransport === "engine";
  const compile = (
    spec: NewWorkspace,
    input: Pick<BuildAndPublishInput, "onProgress" | "signal">,
  ): Promise<WorkspaceBuild> => {
    if (options.compileWorkspaceSpec !== undefined) return options.compileWorkspaceSpec(spec);
    const compilerOptions: BuildkitCompilerOptions = {
      ...(engineTransport ? { emitTarball: false } : {}),
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
      ...(options.cacheDirectory === undefined ? {} : { cacheDirectory: options.cacheDirectory }),
      ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
    };
    return compileWorkspaceBuildSpec({
      blueprint: spec,
      platform: options.platform,
      options: compilerOptions,
    });
  };
  // A custom compiler without a matching planner disables the short-circuit: the planner's hash
  // would not describe what the custom compiler builds.
  const plan =
    options.planWorkspaceSpec ??
    (options.compileWorkspaceSpec === undefined
      ? (spec: NewWorkspace): PlannedWorkspaceImageBuild =>
          planWorkspaceImageBuild({ blueprint: spec, platform: options.platform })
      : undefined);

  const publish = async (input: BuildAndPublishInput, build: WorkspaceBuild) => {
    const engineArtifact = engineTransport
      ? build.artifacts.find(isEngineOciImageArtifact)
      : undefined;
    if (engineArtifact !== undefined) {
      return options.registryClient.publishOciImage({
        repository: input.repository,
        tag: input.tag,
        sourceReference: engineArtifact.reference,
      });
    }
    const artifact = build.artifacts.find(isPublishableOciImageArtifact);
    if (artifact === undefined) {
      throw new Error("The compiler did not return a publishable OCI image artifact.");
    }
    return options.registryClient.publishOciImage({
      artifactPath: artifact.path,
      repository: input.repository,
      tag: input.tag,
      ...(artifact.reference === undefined ? {} : { sourceReference: artifact.reference }),
    });
  };

  return {
    // `docker build` on the control plane's own daemon: recipe steps share its kernel, and on a
    // cloud host a build step can reach the instance metadata service.
    isolation: "host",
    plan,
    buildAndPublish: async (input) => {
      const build = await compile(input.spec, input);
      // The scratch directory (Containerfile, plan/spec JSON, and with the tarball transport the
      // `docker save` output) is only needed until the publish has read it. Published or not, it
      // goes: the job row keeps the metadata that matters, and a leaked tarball per build is how
      // a single-host install fills its disk.
      try {
        const publishedImage = await publish(input, build);
        return { publishedImage, build };
      } finally {
        const contextDirectory = buildContextDirectoryOf(build);
        if (contextDirectory !== undefined) await removeBuildContext(contextDirectory);
      }
    },
    // Only where the store IS the Engine that builds (and runs) the image: the image found there
    // is the one a launch boots, and its probe is read from it with one short `docker run`. A
    // registry store would need a pull for that, and its publishes are on record anyway.
    ...(engineTransport && options.compileWorkspaceSpec === undefined
      ? {
          findPublished: async (input: FindPublishedInput) => {
            const digest = await options.registryClient.headManifest(input.repository, input.tag);
            if (digest === null) return null;
            const reference = `${input.repository}:${input.tag}`;
            // The tag names twelve characters of the plan hash and anyone with the Engine can put
            // it on any image: the image must carry the whole hash its build stamped on it.
            const { stdout } = await (options.commandRunner ?? runBuildkitCommand)("docker", [
              "image",
              "inspect",
              "--format",
              `{{index .Config.Labels "${PLAN_HASH_LABEL}"}}`,
              digest,
            ]);
            if (stdout.trim() !== input.planned.planHash) return null;
            const { probe } = await readWorkspaceImageProbe(
              digest,
              input.planned.platform,
              options.commandRunner,
            );
            // An image whose probe cannot be read is not vouched for: a per-person launch would be
            // refused on it. Build it again instead.
            if (probe === undefined) return null;
            const publishedImage = await options.registryClient.publishOciImage({
              repository: input.repository,
              tag: input.tag,
              sourceReference: digest,
            });
            const name = localImageNameOf(input.planned.imagePlan);
            return {
              publishedImage,
              build: {
                builder: { id: input.planned.osFamily, osFamily: input.planned.osFamily },
                artifacts: [{ kind: "oci-image", name, reference, loader: "docker-engine" }],
                metadata: {
                  defaultArtifactName: name,
                  notes: [
                    `Reused ${reference} (${digest}) from the Docker Engine: an earlier build of plan ${input.planned.planHash} left it there; nothing was built.`,
                  ],
                  planHash: input.planned.planHash,
                  imageProbe: probe,
                },
              },
            };
          },
        }
      : {}),
  };
};
