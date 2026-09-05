import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertDockerVolumeConfiguration,
  assertDockerVolumeSourceDirectories,
  dockerVolumeMountArgs,
  parseDockerVolumeMappings,
  prepareDockerControlDirectory,
  resolveDockerVolumeMount,
  resolveDockerVolumeMounts,
  type DockerVolumeMapping,
} from "./docker-volume-mounts.js";
import type { RuntimeMountIntent } from "./mount-intent.js";

const mapping = (logicalRoot = "/srv/store", volumeName = "mend-store"): DockerVolumeMapping => ({
  logicalRoot,
  volumeName,
});

const intent = (sourcePath = "/srv/store/project/session"): RuntimeMountIntent => ({
  sourcePath,
  mountPath: "/workspace/repo",
  readOnly: false,
  purpose: "workspace",
});

describe("parseDockerVolumeMappings", () => {
  it("parses the strict public environment shape", () => {
    expect(
      parseDockerVolumeMappings(
        JSON.stringify([
          { logicalRoot: "/var/lib/mend/store", volumeName: "mend-store" },
          { logicalRoot: "/run/sealant/sockets", volumeName: "sealant-sockets" },
        ]),
      ),
    ).toEqual([
      { logicalRoot: "/var/lib/mend/store", volumeName: "mend-store" },
      { logicalRoot: "/run/sealant/sockets", volumeName: "sealant-sockets" },
    ]);
  });

  it.each([
    ["malformed JSON", "{"],
    ["a non-array", "{}"],
    ["an empty array", "[]"],
    ["root slash", JSON.stringify([{ logicalRoot: "/", volumeName: "store" }])],
    ["a relative root", JSON.stringify([{ logicalRoot: "srv/store", volumeName: "store" }])],
    ["dot segments", JSON.stringify([{ logicalRoot: "/srv/../store", volumeName: "store" }])],
    ["double slashes", JSON.stringify([{ logicalRoot: "/srv//store", volumeName: "store" }])],
    ["a trailing slash", JSON.stringify([{ logicalRoot: "/srv/store/", volumeName: "store" }])],
    [
      "an injected option",
      JSON.stringify([{ logicalRoot: "/srv/store", volumeName: "x,readonly" }]),
    ],
    ["a leading option", JSON.stringify([{ logicalRoot: "/srv/store", volumeName: "--mount" }])],
    [
      "an unknown field",
      JSON.stringify([{ logicalRoot: "/srv/store", volumeName: "store", readOnly: true }]),
    ],
    [
      "duplicate roots",
      JSON.stringify([
        { logicalRoot: "/srv/store", volumeName: "store-a" },
        { logicalRoot: "/srv/store", volumeName: "store-b" },
      ]),
    ],
    [
      "nested roots",
      JSON.stringify([
        { logicalRoot: "/srv/store", volumeName: "store-a" },
        { logicalRoot: "/srv/store/team", volumeName: "store-b" },
      ]),
    ],
    [
      "a reused volume",
      JSON.stringify([
        { logicalRoot: "/srv/store-a", volumeName: "store" },
        { logicalRoot: "/srv/store-b", volumeName: "store" },
      ]),
    ],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseDockerVolumeMappings(raw)).toThrow(/Docker volume mount configuration/);
  });
});

describe("Docker volume configuration and lowering", () => {
  it("requires exact, separate mappings for authorization and the socket root", () => {
    const mappings = [mapping(), mapping("/run/sealant/sockets", "sealant-sockets")];
    expect(
      assertDockerVolumeConfiguration({
        mappings,
        mountAllowedStoreRoots: "/srv/store",
        controlSocketHostDir: "/run/sealant/sockets",
      }),
    ).toEqual(["/srv/store"]);

    expect(() =>
      assertDockerVolumeConfiguration({
        mappings,
        mountAllowedStoreRoots: "/srv/other",
        controlSocketHostDir: "/run/sealant/sockets",
      }),
    ).toThrow(/no exact volume mapping/);
    expect(() =>
      assertDockerVolumeConfiguration({
        mappings: [mapping()],
        mountAllowedStoreRoots: "/srv/store",
      }),
    ).toThrow(/WORKSPACE_CONTROL_SOCKET_HOST_DIR/);
    expect(() =>
      assertDockerVolumeConfiguration({
        mappings: [mapping()],
        mountAllowedStoreRoots: "/srv/store",
        controlSocketHostDir: "/srv/store",
      }),
    ).toThrow(/operational socket root must be separate/);
  });

  it("requires exactly one mapping and a non-empty volume subpath", () => {
    expect(resolveDockerVolumeMount(intent(), [mapping()]).volumeSubpath).toBe("project/session");
    expect(() => resolveDockerVolumeMount(intent("/srv/store"), [mapping()])).toThrow(
      /non-empty volume subpath/,
    );
    expect(() => resolveDockerVolumeMount(intent("/srv/unmapped/session"), [mapping()])).toThrow(
      /not beneath/,
    );
  });

  it("keeps authorization separate and emits volume-nocopy plus read-only", () => {
    const readOnlyIntent = { ...intent(), readOnly: true };
    const [resolved] = resolveDockerVolumeMounts({
      intents: [readOnlyIntent],
      mappings: [mapping()],
      allowedStoreRoots: ["/srv/store"],
    });
    expect(resolved).toBeDefined();
    if (resolved !== undefined) {
      expect(dockerVolumeMountArgs(resolved)).toEqual([
        "--mount",
        "type=volume,src=mend-store,dst=/workspace/repo,volume-subpath=project/session,volume-nocopy,readonly",
      ]);
    }
    expect(() =>
      resolveDockerVolumeMounts({
        intents: [intent()],
        mappings: [mapping()],
        allowedStoreRoots: [],
      }),
    ).toThrow(/not authorized/);
    expect(() =>
      resolveDockerVolumeMount({ ...intent(), mountPath: "/workspace/repo,readonly" }, [mapping()]),
    ).toThrow(/unsafe in Docker --mount/);
  });
});

describe("Docker volume filesystem safety", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("requires existing directories and rejects every symlink component below the volume root", async () => {
    const root = await mkdtemp(join(tmpdir(), "sealant-volume-source-"));
    cleanups.push(root);
    await mkdir(join(root, "safe", "session"), { recursive: true });
    const safeMount = resolveDockerVolumeMount(intent(join(root, "safe", "session")), [
      mapping(root),
    ]);
    await expect(assertDockerVolumeSourceDirectories([safeMount])).resolves.toBeUndefined();

    await mkdir(join(root, "target", "session"), { recursive: true });
    await symlink(join(root, "target"), join(root, "linked"));
    const linkedMount = resolveDockerVolumeMount(intent(join(root, "linked", "session")), [
      mapping(root),
    ]);
    await expect(assertDockerVolumeSourceDirectories([linkedMount])).rejects.toThrow(
      /must not be a symbolic link/,
    );

    const missingMount = resolveDockerVolumeMount(intent(join(root, "missing")), [mapping(root)]);
    await expect(assertDockerVolumeSourceDirectories([missingMount])).rejects.toThrow(
      /does not exist/,
    );
  });

  it("prepares owned control directories without replacing contents or following symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "sealant-control-root-"));
    const outside = await mkdtemp(join(tmpdir(), "sealant-control-outside-"));
    cleanups.push(root, outside);

    const owned = await prepareDockerControlDirectory({
      controlRoot: root,
      directoryName: "sealant-run-1",
      containerNamePrefix: "sealant",
    });
    await writeFile(join(owned, "control.sock"), "stale");
    await prepareDockerControlDirectory({
      controlRoot: root,
      directoryName: "sealant-run-1",
      containerNamePrefix: "sealant",
    });
    await expect(readFile(join(owned, "control.sock"), "utf8")).resolves.toBe("stale");

    await symlink(outside, join(root, "sealant-run-2"));
    await expect(
      prepareDockerControlDirectory({
        controlRoot: root,
        directoryName: "sealant-run-2",
        containerNamePrefix: "sealant",
      }),
    ).rejects.toThrow(/must not be a symbolic link/);
    await expect(stat(outside)).resolves.toBeDefined();
    await expect(
      prepareDockerControlDirectory({
        controlRoot: root,
        directoryName: "unowned",
        containerNamePrefix: "sealant",
      }),
    ).rejects.toThrow(/not owned/);
  });
});
