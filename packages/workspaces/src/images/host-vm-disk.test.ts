import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createHostVmHarness,
  HOST_VM_DIGEST,
  HOST_VM_KEY,
  HOST_VM_REFERENCE,
  type HostVmHarness,
} from "../runtime/host-vm.fixture.js";
import {
  baseDiskBuildMiB,
  hostVmBaseImageKey,
  hostVmDigestOfKey,
  hostVmMountArgs,
  HostVmStorage,
  parseInspectedImage,
} from "./host-vm-disk.js";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

let harness: HostVmHarness | undefined;
const make = async () => {
  harness = await createHostVmHarness();
  return harness;
};
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe("base disk names", () => {
  it("names a disk by its digest without a colon, and names nothing else", () => {
    expect(hostVmBaseImageKey(HOST_VM_DIGEST)).toBe(HOST_VM_KEY);
    expect(hostVmDigestOfKey(HOST_VM_KEY)).toBe(HOST_VM_DIGEST);
    // A file name the runner would resolve outside its images directory never comes out.
    expect(() => hostVmBaseImageKey("sha256:../../etc/passwd")).toThrow(
      /not a sha256 image digest/,
    );
    expect(() => hostVmBaseImageKey("sha256:test")).toThrow();
    expect(hostVmDigestOfKey("sha256-abc")).toBeUndefined();
  });

  it("mounts with --mount, so no path's colon reads as a field separator", () => {
    expect(hostVmMountArgs({ path: "/srv/images" }, "a.img", "/x/a.img", true)).toEqual([
      "--mount",
      "type=bind,source=/srv/images/a.img,target=/x/a.img,readonly",
    ]);
    expect(
      hostVmMountArgs(
        { path: "/var/lib/mend/vm-data", mount: { kind: "volume", volume: "mend-vm-data" } },
        "sealant-vm-run",
        "/var/lib/sealant/data",
        false,
      ),
    ).toEqual([
      "--mount",
      "type=volume,source=mend-vm-data,volume-subpath=sealant-vm-run,target=/var/lib/sealant/data",
    ]);
    expect(
      hostVmMountArgs(
        { path: "/data", mount: { kind: "bind", hostPath: "/srv/mend/vm-data" } },
        "",
        "/data",
        false,
      ),
    ).toEqual(["--mount", "type=bind,source=/srv/mend/vm-data,target=/data"]);
  });
});

describe("parseInspectedImage", () => {
  it("keeps the fields the guest applies and drops what Docker reports as null or empty", () => {
    const parsed = parseInspectedImage(
      JSON.stringify({
        Size: 1234,
        Config: {
          Env: ["PATH=/usr/bin", "A=1"],
          User: "",
          WorkingDir: "/workspace",
          Entrypoint: null,
          Cmd: ["bash"],
          Labels: null,
        },
      }),
    );
    expect(parsed).toEqual({
      sizeBytes: 1234,
      config: { Env: ["PATH=/usr/bin", "A=1"], WorkingDir: "/workspace", Cmd: ["bash"] },
    });
  });

  it("sizes the build with room for an image of many small files", () => {
    expect(baseDiskBuildMiB(300 * 1024 * 1024)).toBe(1112);
  });
});

describe("HostVmStorage.ensureBaseImage", () => {
  it("streams docker export into a converter with no socket, no network and no capabilities", async () => {
    const h = await make();
    const base = await h.storage.ensureBaseImage({
      digest: HOST_VM_DIGEST,
      reference: HOST_VM_REFERENCE,
    });
    expect(base.imagePath).toBe(joinPath(h.imagesDir, `${HOST_VM_KEY}.img`));
    expect(await readFile(base.imagePath, "utf8")).toBe("ext4-base");
    const config = JSON.parse(await readFile(base.configPath, "utf8"));
    expect(config.Env).toContain("PATH=/usr/local/bin:/usr/bin:/bin");

    const [pipe] = h.pipes;
    expect(pipe?.[0]).toEqual(["export", "export-container"]);
    const converter = pipe?.[1] ?? [];
    expect(converter.slice(0, 3)).toEqual(["run", "--rm", "-i"]);
    expect(converter).toEqual(expect.arrayContaining(["--network", "none", "--cap-drop", "ALL"]));
    expect(converter).not.toContain("--cap-add");
    expect(converter.join(" ")).not.toMatch(/docker\.sock|--privileged/);
    const script = converter[converter.indexOf("-c") + 1] ?? "";
    // tar straight into mke2fs, then read-only as its own step.
    expect(script).toMatch(/mke2fs .*-d - "\$1"/);
    expect(script).toMatch(/tune2fs -O read-only "\$1"/);
    expect(script).not.toMatch(/mke2fs[^\n]*read-only/);
    // The temporary container goes, and no temporary file is left.
    expect(h.calls).toContainEqual(["rm", "-f", "export-container"]);
    expect((await readdir(h.imagesDir)).toSorted()).toEqual(
      [`${HOST_VM_KEY}.config.json`, `${HOST_VM_KEY}.img`].toSorted(),
    );
  });

  it("builds a digest once for concurrent launches and reuses it after", async () => {
    const h = await make();
    const image = { digest: HOST_VM_DIGEST, reference: HOST_VM_REFERENCE };
    await Promise.all([h.storage.ensureBaseImage(image), h.storage.ensureBaseImage(image)]);
    await h.storage.ensureBaseImage(image);
    expect(h.pipes).toHaveLength(1);
  });

  it("pulls an image this host does not have before it inspects it", async () => {
    const h = await make();
    h.absentImages.add(HOST_VM_REFERENCE);
    await h.storage.ensureBaseImage({ digest: HOST_VM_DIGEST, reference: HOST_VM_REFERENCE });
    expect(h.calls.map((args) => args[0])).toContain("pull");
  });

  it("leaves no disk and no container behind when the conversion fails", async () => {
    const h = await make();
    const removed: string[][] = [];
    const storage = new HostVmStorage({
      imagesDir: { path: h.imagesDir },
      dataDir: { path: h.dataDir },
      controlDir: { path: h.controlDir },
      commandRunner: async (_command, args) => {
        if (args[0] === "rm") removed.push(args);
        if (args[0] === "create") return { stdout: "export-container\n", stderr: "" };
        if (args[0] === "image") {
          return { stdout: JSON.stringify({ Size: 1, Config: {} }), stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
      pipeRunner: async (_from, to) => {
        const target = to.find((arg) => arg.startsWith("/out/.tmp-")) ?? "";
        await writeFile(joinPath(h.imagesDir, target.slice("/out/".length)), "half");
        throw new Error("mke2fs: No space left on device");
      },
      toolsImage: "tools",
    });
    await expect(
      storage.ensureBaseImage({ digest: HOST_VM_DIGEST, reference: HOST_VM_REFERENCE }),
    ).rejects.toThrow(/No space left/);
    expect(await exists(joinPath(h.imagesDir, `${HOST_VM_KEY}.img`))).toBe(false);
    expect((await readdir(h.imagesDir)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    expect(removed).toEqual([["rm", "-f", "export-container"]]);
  });
});

describe("HostVmStorage.prepareExecutor", () => {
  it("formats a data disk once and never again", async () => {
    const h = await make();
    const name = "sealant-vm-run-1";
    const path = await h.storage.prepareExecutor({
      containerName: name,
      baseImageDigest: HOST_VM_DIGEST,
    });
    await writeFile(path, "work");
    await h.storage.prepareExecutor({ containerName: name, baseImageDigest: HOST_VM_DIGEST });
    expect(await readFile(path, "utf8")).toBe("work");
    expect(await h.storage.markedBaseImageDigest(name)).toBe(HOST_VM_DIGEST);

    // The tools container gets only what making 65532's files needs.
    const tools = h.calls.find((args) => args[0] === "run" && args.includes("--rm")) ?? [];
    expect(tools.filter((_arg, index) => tools[index - 1] === "--cap-add").toSorted()).toEqual([
      "CHOWN",
      "DAC_OVERRIDE",
      "FOWNER",
    ]);
    const script = tools[tools.indexOf("-c") + 1] ?? "";
    expect(script).toContain('if [ ! -e "$d/data.img" ]; then');
    expect(script).toContain("mkfs.ext4 -q -F -E lazy_itable_init=1,lazy_journal_init=1");
    expect(script).toContain('chown 65532:65532 "$d/data.img.tmp"');
    expect(tools.slice(tools.indexOf("-c") + 3, tools.indexOf("-c") + 5)).toEqual([
      name,
      String(20 * 1024 ** 3),
    ]);
  });

  it("refuses a container name that is not one the adapter makes", async () => {
    const h = await make();
    await expect(
      h.storage.prepareExecutor({ containerName: "../escape", baseImageDigest: HOST_VM_DIGEST }),
    ).rejects.toThrow(/not a host VM runner container name/);
  });
});
