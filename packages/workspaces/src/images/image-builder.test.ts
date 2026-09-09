/**
 * The Docker builder is the historical phase-A glue, unchanged in behaviour: compile to a
 * tarball artifact, then `publishOciImage` with that artifact. Pinned here so the refactor
 * behind `WorkspaceImageBuilder` cannot alter what a Docker worker does.
 */
import type { WorkspaceBuild } from "@sealant/validators";
import { describe, expect, it, vi } from "vitest";

import type { RegistryClient } from "../registry/index.js";
import { cases } from "../runtime/docker-runtime-adapter.golden-fixture.js";
import { createDockerWorkspaceImageBuilder } from "./image-builder.js";

const build: WorkspaceBuild = {
  builder: { id: "fedora", osFamily: "fedora" },
  artifacts: [
    {
      kind: "oci-image",
      name: "sealant-workspace-fedora",
      path: "/tmp/ctx/workspace-image.tar",
      reference: "sealant-workspace-fedora:latest",
      loader: "docker-load",
    },
  ],
  metadata: { defaultArtifactName: "sealant-workspace-fedora", notes: [], planHash: "abc" },
};

describe("createDockerWorkspaceImageBuilder", () => {
  it("compiles then publishes the docker-load artifact with the same arguments as before", async () => {
    const publishOciImage = vi.fn(async () => ({
      repository: "sealant/ws",
      tag: "v1",
      reference: "127.0.0.1:5000/sealant/ws:v1",
      digestReference: "127.0.0.1:5000/sealant/ws@sha256:1",
      digest: "sha256:1",
    }));
    const registryClient = { publishOciImage } as unknown as RegistryClient;
    const compileWorkspaceSpec = vi.fn(async () => build);
    const builder = createDockerWorkspaceImageBuilder({ registryClient, compileWorkspaceSpec });

    const result = await builder.buildAndPublish({
      spec: cases.gitSource.blueprint,
      repository: "sealant/ws",
      tag: "v1",
    });

    expect(compileWorkspaceSpec).toHaveBeenCalledWith(cases.gitSource.blueprint);
    expect(publishOciImage).toHaveBeenCalledWith({
      artifactPath: "/tmp/ctx/workspace-image.tar",
      repository: "sealant/ws",
      tag: "v1",
      sourceReference: "sealant-workspace-fedora:latest",
    });
    expect(result.build).toBe(build);
    expect(result.publishedImage.digest).toBe("sha256:1");
  });

  it("skips the tarball and publishes the Engine image when the store speaks the engine transport", async () => {
    const publishOciImage = vi.fn(async () => ({
      repository: "sealant-workspace-fedora",
      tag: "plan-1",
      reference: "sealant-workspace-fedora:plan-1",
      digestReference: "sha256:1",
      digest: "sha256:1",
    }));
    const registryClient = {
      imageTransport: "engine",
      publishOciImage,
    } as unknown as RegistryClient;
    const engineBuild: WorkspaceBuild = {
      ...build,
      artifacts: [
        {
          kind: "oci-image",
          name: "sealant-workspace-fedora",
          reference: "sealant-workspace-fedora:latest",
          loader: "docker-engine",
        },
      ],
    };
    const builder = createDockerWorkspaceImageBuilder({
      registryClient,
      compileWorkspaceSpec: async () => engineBuild,
    });

    const result = await builder.buildAndPublish({
      spec: cases.gitSource.blueprint,
      repository: "sealant-workspace-fedora",
      tag: "plan-1",
    });

    expect(publishOciImage).toHaveBeenCalledWith({
      repository: "sealant-workspace-fedora",
      tag: "plan-1",
      sourceReference: "sealant-workspace-fedora:latest",
    });
    expect(result.publishedImage.digestReference).toBe("sha256:1");
  });

  it("still accepts a tarball artifact from a custom compiler under the engine transport", async () => {
    const publishOciImage = vi.fn(async () => ({
      repository: "r",
      tag: "t",
      reference: "r:t",
      digestReference: "sha256:2",
      digest: "sha256:2",
    }));
    const registryClient = {
      imageTransport: "engine",
      publishOciImage,
    } as unknown as RegistryClient;
    const builder = createDockerWorkspaceImageBuilder({
      registryClient,
      compileWorkspaceSpec: async () => build,
    });
    await builder.buildAndPublish({ spec: cases.gitSource.blueprint, repository: "r", tag: "t" });
    expect(publishOciImage).toHaveBeenCalledWith({
      artifactPath: "/tmp/ctx/workspace-image.tar",
      repository: "r",
      tag: "t",
      sourceReference: "sealant-workspace-fedora:latest",
    });
  });

  it("disables the plan-hash short-circuit for a custom compiler without a planner", () => {
    const registryClient = {} as RegistryClient;
    expect(
      createDockerWorkspaceImageBuilder({ registryClient, compileWorkspaceSpec: async () => build })
        .plan,
    ).toBeUndefined();
    expect(createDockerWorkspaceImageBuilder({ registryClient }).plan).toBeDefined();
  });

  it("fails when the compiler returns no publishable artifact", async () => {
    const registryClient = { publishOciImage: vi.fn() } as unknown as RegistryClient;
    const builder = createDockerWorkspaceImageBuilder({
      registryClient,
      compileWorkspaceSpec: async () => ({ ...build, artifacts: [] }),
    });
    await expect(
      builder.buildAndPublish({ spec: cases.gitSource.blueprint, repository: "r", tag: "t" }),
    ).rejects.toThrow(/publishable OCI image artifact/);
  });
});
