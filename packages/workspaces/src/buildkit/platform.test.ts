import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkspaceImagePlatform } from "@sealant/validators";
import { describe, expect, it, vi } from "vitest";

import { microvmRecipe } from "../images/microvm/recipe.js";
import { cases } from "../runtime/docker-runtime-adapter.golden-fixture.js";
import {
  ARCHLINUXARM_BUILDER_KEY,
  ARCHLINUXARM_KEY_FILE,
  ARCHLINUXARM_KEY_FINGERPRINT,
  ARCHLINUXARM_ROOTFS,
  renderArchlinuxArmBase,
} from "./archlinuxarm.js";
import {
  compileWorkspaceBuildSpec,
  planWorkspaceImageBuild,
  removeBuildContext,
} from "./buildkit-builder.js";
import {
  dockerDaemonImagePlatform,
  processImagePlatform,
  UnsupportedImagePlatformError,
  workspaceImagePlatformOf,
} from "./platform.js";

type Family = "fedora" | "arch" | "ubuntu" | "nix";

const blueprintFor = (family: Family) => ({
  ...cases.gitSource.blueprint,
  target: { ...cases.gitSource.blueprint.target, os: { family, mode: "require" as const } },
});

const plan = (family: Family, platform: WorkspaceImagePlatform) =>
  planWorkspaceImageBuild({ blueprint: blueprintFor(family), platform });

const compile = async (family: Family, platform: WorkspaceImagePlatform) => {
  const commandRunner = vi.fn(async (_command: string, _args: string[]) => ({
    stdout: "",
    stderr: "",
  }));
  const result = await compileWorkspaceBuildSpec({
    blueprint: blueprintFor(family),
    platform,
    options: { commandRunner, emitTarball: false },
  });
  const calls = commandRunner.mock.calls.map(([, args]) => args);
  return {
    result,
    build: calls.find((args) => args[0] === "build") ?? [],
    probe: calls.find((args) => args[0] === "run") ?? [],
    context: result.buildkit.spec.contextDirectory,
  };
};

describe("the platform a workspace image is built for", () => {
  it("reads Docker's, the kernel's and Node's names for the two architectures", () => {
    for (const name of ["amd64", "x86_64", "x64", " amd64\n"]) {
      expect(workspaceImagePlatformOf(name)).toBe("linux/amd64");
    }
    for (const name of ["arm64", "aarch64", "arm64\n"]) {
      expect(workspaceImagePlatformOf(name)).toBe("linux/arm64");
    }
    expect(workspaceImagePlatformOf("s390x")).toBeUndefined();
    expect(processImagePlatform("arm64")).toBe("linux/arm64");
    expect(() => processImagePlatform("riscv64")).toThrow(UnsupportedImagePlatformError);
  });

  it("asks the Docker daemon for its architecture", async () => {
    const runner = vi.fn(async () => ({ stdout: "arm64\n", stderr: "" }));
    await expect(dockerDaemonImagePlatform(runner)).resolves.toBe("linux/arm64");
    expect(runner).toHaveBeenCalledWith("docker", ["version", "--format", "{{.Server.Arch}}"]);

    const s390x = vi.fn(async () => ({ stdout: "s390x\n", stderr: "" }));
    await expect(dockerDaemonImagePlatform(s390x)).rejects.toThrow(/s390x/);
  });

  it("keys the plan by platform, so an image is never reused across architectures", () => {
    for (const family of ["fedora", "arch", "ubuntu", "nix"] as const) {
      const amd64 = plan(family, "linux/amd64");
      const arm64 = plan(family, "linux/arm64");
      expect(amd64.platform).toBe("linux/amd64");
      expect(arm64.platform).toBe("linux/arm64");
      expect(arm64.planHash).not.toBe(amd64.planHash);
      expect(plan(family, "linux/arm64").planHash).toBe(arm64.planHash);
    }
  });

  it("builds the multi-arch families natively from the same Containerfile on both", () => {
    for (const family of ["fedora", "ubuntu", "nix"] as const) {
      expect(plan(family, "linux/arm64").containerfile).toBe(
        plan(family, "linux/amd64").containerfile,
      );
    }
  });

  it("keeps Docker Hub's archlinux image on amd64", async () => {
    const planned = plan("arch", "linux/amd64");
    expect(planned.containerfile).toMatch(/^FROM archlinux:latest$/m);
    expect(planned.containerfile).not.toContain("archlinuxarm");
    expect(planned.imagePlan.baseImage).toBe("archlinux:latest");

    const { build, probe, context } = await compile("arch", "linux/amd64");
    try {
      expect(build).toEqual(expect.arrayContaining(["--platform", "linux/amd64"]));
      expect(probe).toEqual(expect.arrayContaining(["--platform", "linux/amd64"]));
      expect(existsSync(join(context, ARCHLINUXARM_KEY_FILE))).toBe(false);
    } finally {
      await removeBuildContext(context);
    }
  });

  it("builds Arch on arm64 natively from the verified Arch Linux ARM rootfs", async () => {
    const planned = plan("arch", "linux/arm64");
    expect(planned.containerfile).not.toContain("archlinux:latest");
    expect(planned.containerfile).toContain(renderArchlinuxArmBase("fedora:41"));
    expect(planned.imagePlan.baseImage).toBe(ARCHLINUXARM_ROOTFS);
    // The rest of the recipe is the family's own, pacman and all.
    expect(planned.containerfile).toContain(
      "RUN sed -i 's/^DownloadUser/#DownloadUser/' /etc/pacman.conf",
    );
    expect(planned.containerfile).toContain("pacman -S --noconfirm --needed sudo acl");

    const { result, build, probe, context } = await compile("arch", "linux/arm64");
    try {
      expect(build).toEqual(expect.arrayContaining(["--platform", "linux/arm64"]));
      expect(probe).toEqual(expect.arrayContaining(["--platform", "linux/arm64"]));
      // The key the rootfs is verified against rides in the build context.
      await expect(readFile(join(context, ARCHLINUXARM_KEY_FILE), "utf8")).resolves.toBe(
        ARCHLINUXARM_BUILDER_KEY,
      );
      expect(result.metadata?.notes).toContain(
        "Compiled by the arch BuildKit compiler for linux/arm64.",
      );
    } finally {
      await removeBuildContext(context);
    }
  });

  it("verifies the rootfs, drops the board's kernel and firmware, and locks its default accounts", () => {
    const base = renderArchlinuxArmBase("fedora:41");
    expect(base).toMatch(/^FROM fedora:41 AS archlinuxarm$/m);
    expect(base).toContain(`COPY ${ARCHLINUXARM_KEY_FILE} /tmp/${ARCHLINUXARM_KEY_FILE}`);
    expect(base).toContain(`grep -q '^fpr:.*:${ARCHLINUXARM_KEY_FINGERPRINT}:'`);
    expect(base).toContain("gpg --batch --verify /tmp/rootfs.tar.gz.sig /tmp/rootfs.tar.gz");
    expect(base).toMatch(/^FROM scratch$/m);
    expect(base).toContain("pacman-key --populate archlinuxarm");
    expect(base).toContain("linux-aarch64|linux-firmware(-.+)?|mkinitcpio(-busybox)?");
    expect(base).toContain("userdel alarm && rm -rf /home/alarm && usermod -p '*' root");
    expect(ARCHLINUXARM_BUILDER_KEY).toMatch(/^-----BEGIN PGP PUBLIC KEY BLOCK-----\n/);
    expect(ARCHLINUXARM_BUILDER_KEY.trimEnd()).toMatch(/\n-----END PGP PUBLIC KEY BLOCK-----$/);
  });

  it("gives a MicroVM the same Arch Linux ARM stages, its fetch stage from the ECR mirror", () => {
    const planned = plan("arch", "linux/arm64");
    const { containerfile } = microvmRecipe(planned, {
      agentPort: 8080,
      memoryMiB: 2048,
      dockerService: false,
      contextDigest: "digest",
    });
    expect(containerfile).toContain(
      renderArchlinuxArmBase("fedora:41").replace(
        "FROM fedora:41 AS",
        "FROM public.ecr.aws/docker/library/fedora:41 AS",
      ),
    );
  });
});
