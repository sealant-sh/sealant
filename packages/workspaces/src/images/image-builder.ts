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
import type { NewWorkspace, WorkspaceBuild } from "@sealant/validators";

import {
  compileWorkspaceBuildSpec,
  planWorkspaceImageBuild,
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
}

export interface BuildAndPublishResult {
  readonly publishedImage: PublishedImage;
  /** What the job row records as `resultPayload`; shape is the compiler's build result. */
  readonly build: WorkspaceBuild;
}

export interface WorkspaceImageBuilder {
  /**
   * Docker-free planning: blueprint → OS family → Containerfile → plan hash. Undefined when the
   * builder cannot plan (a custom compiler without a matching planner) — callers then skip the
   * plan-hash short-circuit.
   */
  readonly plan: ((spec: NewWorkspace) => PlannedWorkspaceImageBuild) | undefined;
  readonly buildAndPublish: (input: BuildAndPublishInput) => Promise<BuildAndPublishResult>;
}

export interface DockerWorkspaceImageBuilderOptions {
  readonly registryClient: RegistryClient;
  /** Test seams, mirroring the build job's historical `compileWorkspaceSpec` / `planWorkspaceSpec`. */
  readonly compileWorkspaceSpec?: (spec: NewWorkspace) => Promise<WorkspaceBuild>;
  readonly planWorkspaceSpec?: (spec: NewWorkspace) => PlannedWorkspaceImageBuild;
}

const isPublishableOciImageArtifact = (
  artifact: WorkspaceBuild["artifacts"][number],
): artifact is WorkspaceBuild["artifacts"][number] & {
  kind: "oci-image";
  path: string;
  loader: "docker-load";
} =>
  artifact.kind === "oci-image" && artifact.path !== undefined && artifact.loader === "docker-load";

/** The Docker/self-host builder: compile to a tarball, then `docker load/tag/push`. Unchanged. */
export const createDockerWorkspaceImageBuilder = (
  options: DockerWorkspaceImageBuilderOptions,
): WorkspaceImageBuilder => {
  const compile =
    options.compileWorkspaceSpec ??
    ((spec: NewWorkspace): Promise<WorkspaceBuild> =>
      compileWorkspaceBuildSpec({ blueprint: spec }));
  // A custom compiler without a matching planner disables the short-circuit: the planner's hash
  // would not describe what the custom compiler builds.
  const plan =
    options.planWorkspaceSpec ??
    (options.compileWorkspaceSpec === undefined
      ? (spec: NewWorkspace): PlannedWorkspaceImageBuild =>
          planWorkspaceImageBuild({ blueprint: spec })
      : undefined);

  return {
    plan,
    buildAndPublish: async (input) => {
      const build = await compile(input.spec);
      const artifact = build.artifacts.find(isPublishableOciImageArtifact);
      if (artifact === undefined) {
        throw new Error("The compiler did not return a publishable OCI image artifact.");
      }
      const publishedImage = await options.registryClient.publishOciImage({
        artifactPath: artifact.path,
        repository: input.repository,
        tag: input.tag,
        ...(artifact.reference === undefined ? {} : { sourceReference: artifact.reference }),
      });
      return { publishedImage, build };
    },
  };
};
