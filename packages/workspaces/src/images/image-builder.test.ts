/**
 * The Docker builder is the historical phase-A glue, unchanged in behaviour: compile to a
 * tarball artifact, then `publishOciImage` with that artifact. Pinned here so the refactor
 * behind `WorkspaceImageBuilder` cannot alter what a Docker worker does.
 */
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkspaceBuild, WorkspaceImageProbe } from "@sealant/validators";
import { describe, expect, it, vi } from "vitest";

import { planWorkspaceImageBuild } from "../buildkit/index.js";
import { PERSON_SHARED_DIRS } from "../buildkit/person-layout.js";
import type { RegistryClient } from "../registry/index.js";
import { cases } from "../runtime/docker-runtime-adapter.golden-fixture.js";
import { createDockerWorkspaceImageBuilder } from "./image-builder.js";
import { planImageCoordinates } from "./plan-coordinates.js";

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

  const scratchBuild = async (): Promise<{ contextDirectory: string; build: WorkspaceBuild }> => {
    const contextDirectory = await mkdtemp(join(tmpdir(), "sealant-buildkit-fedora-"));
    const tarPath = join(contextDirectory, "workspace-image.tar");
    await writeFile(tarPath, "not really a tarball");
    return {
      contextDirectory,
      build: {
        ...build,
        artifacts: [
          {
            kind: "oci-image",
            name: "sealant-workspace-fedora",
            path: tarPath,
            reference: "sealant-workspace-fedora:latest",
            loader: "docker-load",
          },
        ],
      },
    };
  };

  it("removes the compile's scratch directory once the image is published", async () => {
    const { contextDirectory, build: scratch } = await scratchBuild();
    const registryClient = {
      publishOciImage: vi.fn(async () => ({
        repository: "r",
        tag: "t",
        reference: "r:t",
        digestReference: "sha256:3",
        digest: "sha256:3",
      })),
    } as unknown as RegistryClient;
    const builder = createDockerWorkspaceImageBuilder({
      registryClient,
      compileWorkspaceSpec: async () => scratch,
    });

    await builder.buildAndPublish({ spec: cases.gitSource.blueprint, repository: "r", tag: "t" });

    expect(existsSync(contextDirectory)).toBe(false);
  });

  it("removes the scratch directory even when the publish fails", async () => {
    const { contextDirectory, build: scratch } = await scratchBuild();
    const registryClient = {
      publishOciImage: vi.fn(async () => {
        throw new Error("registry down");
      }),
    } as unknown as RegistryClient;
    const builder = createDockerWorkspaceImageBuilder({
      registryClient,
      compileWorkspaceSpec: async () => scratch,
    });

    await expect(
      builder.buildAndPublish({ spec: cases.gitSource.blueprint, repository: "r", tag: "t" }),
    ).rejects.toThrow("registry down");
    expect(existsSync(contextDirectory)).toBe(false);
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

/** A Docker Engine store that holds `digest` under every name, or nothing. */
const engineStore = (digest: string | null) => {
  const publishOciImage = vi.fn(async (input: { repository: string; tag: string }) => ({
    repository: input.repository,
    tag: input.tag,
    reference: `${input.repository}:${input.tag}`,
    digestReference: digest ?? "",
    digest: digest ?? "",
  }));
  const headManifest = vi.fn(async () => digest);
  const registryClient = {
    imageTransport: "engine",
    headManifest,
    publishOciImage,
  } as unknown as RegistryClient;
  return { registryClient, headManifest, publishOciImage };
};

describe("createDockerWorkspaceImageBuilder.findPublished", () => {
  const probe: WorkspaceImageProbe = {
    version: 1,
    tools: {
      sudo: true,
      sudoSetuid: true,
      useradd: true,
      groupadd: true,
      setfacl: true,
      getfacl: true,
      setpriv: true,
      flock: true,
    },
    sudoersMend: true,
    sudoersIncludesDir: true,
    noNewPrivileges: false,
    passwdWritable: true,
    mendGroup: "present",
    reservedIdsInUse: [],
    personEnv: true,
    sharedDirs: [...PERSON_SHARED_DIRS],
    gitTrustsWorktree: true,
    sealantd: {
      schemaVersion: 1,
      daemonVersion: "0.21.0",
      os: "linux",
      arch: "x86_64",
      supports: ["dotfiles.user", "exec.user", "restore.owner_map"],
    },
  };
  const planned = planWorkspaceImageBuild({ blueprint: cases.gitSource.blueprint });
  const coordinates = planImageCoordinates(planned);

  /** `docker`: the image's plan-hash label for an inspect, the probe for a run. */
  const engine = (label: string) =>
    vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === "image" ? `${label}\n` : JSON.stringify(probe),
      stderr: "",
    }));

  it("reuses the plan's image the Engine kept, with the probe read back from it, building nothing", async () => {
    const { registryClient } = engineStore("sha256:kept");
    const commandRunner = engine(planned.planHash);
    const builder = createDockerWorkspaceImageBuilder({ registryClient, commandRunner });

    const found = await builder.findPublished?.({ planned, ...coordinates });

    expect(found?.publishedImage).toMatchObject({ digest: "sha256:kept" });
    expect(found?.build.metadata).toMatchObject({ planHash: planned.planHash, imageProbe: probe });
    // An inspect checks the label and one short `docker run` reads the probe; no `docker build`.
    expect(commandRunner.mock.calls.map(([, args]) => args[0])).toEqual(["image", "run"]);
    expect(commandRunner.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["sha256:kept"]));
  });

  it("does not reuse an image under the plan's tag that carries another plan's hash", async () => {
    const { registryClient, publishOciImage } = engineStore("sha256:retagged");
    const commandRunner = engine("e".repeat(64));
    const builder = createDockerWorkspaceImageBuilder({ registryClient, commandRunner });
    await expect(builder.findPublished?.({ planned, ...coordinates })).resolves.toBeNull();
    // Nothing is probed or published: the image is not the plan's.
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(publishOciImage).not.toHaveBeenCalled();
  });

  it("does not reuse a kept image built before images carried their plan hash", async () => {
    const { registryClient } = engineStore("sha256:old");
    const builder = createDockerWorkspaceImageBuilder({
      registryClient,
      commandRunner: engine("<no value>"),
    });
    await expect(builder.findPublished?.({ planned, ...coordinates })).resolves.toBeNull();
  });

  it("finds nothing when the Engine has no image for the plan", async () => {
    const { registryClient } = engineStore(null);
    const commandRunner = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const builder = createDockerWorkspaceImageBuilder({ registryClient, commandRunner });
    await expect(builder.findPublished?.({ planned, ...coordinates })).resolves.toBeNull();
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it("does not vouch for an image whose probe cannot be read: it is built again", async () => {
    const { registryClient, publishOciImage } = engineStore("sha256:kept");
    const commandRunner = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === "image" ? planned.planHash : "not json",
      stderr: "",
    }));
    const builder = createDockerWorkspaceImageBuilder({ registryClient, commandRunner });
    await expect(builder.findPublished?.({ planned, ...coordinates })).resolves.toBeNull();
    expect(publishOciImage).not.toHaveBeenCalled();
  });

  it("is not offered for a registry store, which has its publishes on record", () => {
    const registryClient = { publishOciImage: vi.fn() } as unknown as RegistryClient;
    expect(createDockerWorkspaceImageBuilder({ registryClient }).findPublished).toBeUndefined();
  });
});
