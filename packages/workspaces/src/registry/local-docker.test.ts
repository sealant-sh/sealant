/**
 * The local Docker Engine store: same contract as the registry client, but every operation is a
 * Docker CLI call against the Engine that built the image. Pinned here because the single-host
 * install (and Mend's bundle) launch every workspace through this path.
 */
import { describe, expect, it } from "vitest";

import type { CommandRunner } from "./client.js";
import { createLocalDockerImageStore } from "./local-docker.js";

const runner = (
  respond: (command: string, args: Array<string>) => string | Error,
): { calls: Array<Array<string>>; commandRunner: CommandRunner } => {
  const calls: Array<Array<string>> = [];
  const commandRunner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    const result = respond(command, args);
    if (result instanceof Error) throw result;
    return { stdout: result, stderr: "" };
  };
  return { calls, commandRunner };
};

describe("LocalDockerImageStore", () => {
  it("declares the engine transport so the builder skips the tarball round-trip", () => {
    expect(createLocalDockerImageStore().imageTransport).toBe("engine");
  });

  it("publishes by tagging the built image in place and reports the Engine image id as digest", async () => {
    const { calls, commandRunner } = runner((_, args) =>
      args[0] === "image" && args[1] === "inspect" ? "sha256:abc123\n" : "",
    );
    const store = createLocalDockerImageStore({ commandRunner });

    const published = await store.publishOciImage({
      repository: "sealant-workspace-debian",
      tag: "plan-0123456789ab",
      sourceReference: "sealant-workspace-debian:latest",
    });

    expect(calls).toEqual([
      [
        "docker",
        "tag",
        "sealant-workspace-debian:latest",
        "sealant-workspace-debian:plan-0123456789ab",
      ],
      [
        "docker",
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        "sealant-workspace-debian:plan-0123456789ab",
      ],
    ]);
    expect(published).toEqual({
      repository: "sealant-workspace-debian",
      tag: "plan-0123456789ab",
      reference: "sealant-workspace-debian:plan-0123456789ab",
      digestReference: "sha256:abc123",
      digest: "sha256:abc123",
    });
  });

  it("loads a tarball first when no source reference is given", async () => {
    const { calls, commandRunner } = runner((_, args) => {
      if (args[0] === "load") return "Loaded image: sealant-workspace-fedora:latest\n";
      if (args[0] === "image" && args[1] === "inspect") return "sha256:def\n";
      return "";
    });
    const store = createLocalDockerImageStore({ commandRunner });

    await store.publishOciImage({
      artifactPath: "/tmp/ctx/workspace-image.tar",
      repository: "sealant-workspace-fedora",
      tag: "plan-1",
    });

    expect(calls[0]).toEqual(["docker", "load", "-i", "/tmp/ctx/workspace-image.tar"]);
    expect(calls[1]).toEqual([
      "docker",
      "tag",
      "sealant-workspace-fedora:latest",
      "sealant-workspace-fedora:plan-1",
    ]);
  });

  it("rejects a publish with neither a tarball nor a source reference", async () => {
    const store = createLocalDockerImageStore({ commandRunner: runner(() => "").commandRunner });
    await expect(store.publishOciImage({ repository: "r", tag: "t" })).rejects.toThrow(
      /artifact tarball or a source reference/,
    );
  });

  it("answers headManifest with the image id, and null once the image is gone", async () => {
    const present = createLocalDockerImageStore({
      commandRunner: runner(() => "sha256:live\n").commandRunner,
    });
    await expect(present.headManifest("sealant-workspace-debian", "plan-1")).resolves.toBe(
      "sha256:live",
    );

    const gone = createLocalDockerImageStore({
      commandRunner: runner(
        () =>
          new Error("Error response from daemon: No such image: sealant-workspace-debian:plan-1"),
      ).commandRunner,
    });
    await expect(gone.headManifest("sealant-workspace-debian", "plan-1")).resolves.toBeNull();
    await expect(gone.getManifest("sealant-workspace-debian", "plan-1")).resolves.toBeNull();
  });

  it("surfaces Engine failures other than a missing image", async () => {
    const broken = createLocalDockerImageStore({
      commandRunner: runner(() => new Error("Cannot connect to the Docker daemon")).commandRunner,
    });
    await expect(broken.headManifest("r", "t")).rejects.toThrow(/Cannot connect/);
    await expect(broken.ping()).rejects.toThrow(/Cannot connect/);
  });

  it("lists tags from the Engine, ignoring other repositories and untagged images", async () => {
    const { calls, commandRunner } = runner(() =>
      [
        "sealant-workspace-debian\tplan-1",
        "sealant-workspace-debian\t<none>",
        "sealant-workspace-debian-extra\tplan-9",
        "sealant-workspace-debian\tplan-2",
        "",
      ].join("\n"),
    );
    const store = createLocalDockerImageStore({ commandRunner });

    await expect(store.listTags("sealant-workspace-debian")).resolves.toEqual(["plan-1", "plan-2"]);
    await expect(store.repositoryExists("sealant-workspace-debian")).resolves.toBe(true);
    expect(calls[0]).toEqual([
      "docker",
      "image",
      "ls",
      "--format",
      "{{.Repository}}\t{{.Tag}}",
      "--filter",
      "reference=sealant-workspace-debian",
    ]);
  });

  it("has no registry extensions", async () => {
    await expect(createLocalDockerImageStore().discoverExtensions()).resolves.toEqual([]);
  });

  it("deletes by image id and reports a referenced image as in use", async () => {
    const { calls, commandRunner } = runner((_, args) => {
      if (args[0] !== "image" || args[1] !== "rm") return "";
      if (args[3] === "sha256:gone") return new Error("Error: No such image: sha256:gone");
      if (args[3] === "sha256:busy") {
        return new Error(
          "Error response from daemon: conflict: unable to delete sha256:busy (cannot be forced) - image is being used by running container 0123",
        );
      }
      return "Untagged: sealant-workspace-debian:plan-0123456789ab\nDeleted: sha256:free\n";
    });
    const store = createLocalDockerImageStore({ commandRunner });

    await expect(
      store.deleteImage({ repository: "sealant-workspace-debian", digest: "sha256:free" }),
    ).resolves.toBe("deleted");
    await expect(
      store.deleteImage({ repository: "sealant-workspace-debian", digest: "sha256:gone" }),
    ).resolves.toBe("missing");
    await expect(
      store.deleteImage({ repository: "sealant-workspace-debian", digest: "sha256:busy" }),
    ).resolves.toBe("in-use");
    await expect(
      store.deleteImage({ repository: "sealant-workspace-debian", digest: "plan-0123456789ab" }),
    ).rejects.toThrow(/image id/);
    expect(calls).toEqual([
      ["docker", "image", "rm", "-f", "sha256:free"],
      ["docker", "image", "rm", "-f", "sha256:gone"],
      ["docker", "image", "rm", "-f", "sha256:busy"],
    ]);
  });
});
