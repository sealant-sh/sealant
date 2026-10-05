import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseWorkspaceBlueprint, parseWorkspaceImageProbe } from "@sealant/validators";
import type { WorkspaceImageProbe } from "@sealant/validators";
import { describe, expect, it, vi } from "vitest";

import { microvmRecipe } from "../images/microvm/recipe.js";
import { compileWorkspaceBuildSpec, planWorkspaceImageBuild } from "./buildkit-builder.js";
import {
  IMAGE_PROBE_PATH,
  IMAGE_PROBE_SCRIPT,
  PERSON_SHARED_DIRS,
  PERSON_SHARED_SUBDIRS,
  PERSON_SKEL_LINKS,
  PERSON_SUDOERS,
  PERSON_TOOLCHAIN_ENV,
  PERSON_TOOLCHAINS,
  imagePersonLayoutSupport,
} from "./person-layout.js";

const execFileAsync = promisify(execFile);

const blueprintFor = (
  family: string,
  options: { readonly docker?: boolean; readonly baseImage?: string } = {},
) =>
  parseWorkspaceBlueprint({
    sources: { workspace: { url: "https://example.invalid/repo.git", ref: "main" } },
    harness: { id: "claude-code" },
    target: {
      os: { family, ...(options.baseImage === undefined ? {} : { baseImage: options.baseImage }) },
    },
    tooling: {
      packages: family === "custom" ? [] : [{ id: "mise" }, { id: "pnpm" }],
      services: { docker: { enabled: options.docker ?? false } },
    },
  });

const containerfileFor = (family: string, options?: Parameters<typeof blueprintFor>[1]) =>
  planWorkspaceImageBuild({ blueprint: blueprintFor(family, options) }).containerfile;

const readyProbe: WorkspaceImageProbe = {
  version: 1,
  tools: {
    sudo: true,
    sudoSetuid: true,
    useradd: true,
    groupadd: true,
    setfacl: true,
    getfacl: true,
    setpriv: true,
  },
  sudoersMend: true,
  passwdWritable: true,
  mendGroup: "present",
  reservedIdsInUse: [],
  sharedDirs: [...PERSON_SHARED_DIRS],
  sealantd: { capabilities: ["exec.user", "dotfiles.user", "restore.owner_map"] },
};

describe("the person layout in the managed images", () => {
  const families = [
    // Fedora's go in its package layer: a layer of their own would carry a rewritten rpmdb.
    { family: "fedora", packages: "socat sudo acl util-linux", install: "dnf -y install bash" },
    { family: "arch", packages: "sudo acl", install: "pacman -S --noconfirm --needed" },
    {
      family: "ubuntu",
      packages: "sudo acl",
      install: "apt-get install -y --no-install-recommends",
    },
  ];

  for (const { family, packages, install } of families) {
    it(`gives ${family} the mend group, sudo, the ACL tools and the shared toolchains`, () => {
      const containerfile = containerfileFor(family);

      expect(containerfile).toContain(install);
      expect(containerfile).toContain(` ${packages}`);
      expect(containerfile).toContain("groupadd -g 40000 mend");
      for (const line of PERSON_SUDOERS) expect(containerfile).toContain(line.split("'")[0]);
      expect(containerfile).toContain("visudo -cqf /etc/sudoers.d/mend");
      expect(containerfile).toContain(`chmod 2775 ${PERSON_SHARED_DIRS.join(" ")}`);
      for (const [link, target] of PERSON_SKEL_LINKS) {
        expect(containerfile).toContain(`ln -sfn ${target} /etc/skel/${link}`);
      }
      for (const [name, value] of PERSON_TOOLCHAIN_ENV) {
        expect(containerfile).toContain(`${name}='${value}'`);
      }
      expect(containerfile).toContain(
        `SEALANT_PERSON_SHARED_DIRS='${[...PERSON_SHARED_DIRS, ...PERSON_SHARED_SUBDIRS].join(":")}'`,
      );
      expect(containerfile).toContain(
        "PATH=/opt/mise/shims:/opt/npm-global/bin:/opt/pnpm:/opt/uv/bin:/opt/rust/cargo/bin:/opt/bun/bin:$PATH",
      );
      expect(containerfile).toContain("git config --system --replace-all safe.directory '*'");
      // A managed image that cannot run the person layout fails its build.
      expect(containerfile).toContain(
        `/usr/local/lib/sealant/image-probe --require > ${IMAGE_PROBE_PATH}`,
      );
    });

    it(`keeps ${family}'s package and harness layers ahead of the layout, and probes last`, () => {
      const containerfile = containerfileFor(family);
      const layout = containerfile.indexOf("groupadd -g 40000 mend");
      const lastHarness = containerfile.lastIndexOf("RUN npm install -g");
      const probe = containerfile.indexOf("image-probe --require");
      const bootEnv = containerfile.indexOf("ENV SEALANT_OS_FAMILY=");

      expect(lastHarness).toBeGreaterThan(0);
      // The harness layers, and the binaries' locations, are what they were before the layout:
      // npm's global prefix moves only for what is installed after the image is built.
      expect(layout).toBeGreaterThan(lastHarness);
      expect(probe).toBeGreaterThan(layout);
      expect(bootEnv).toBeGreaterThan(probe);
    });
  }

  it("installs nothing in Fedora's layout layer", () => {
    const containerfile = containerfileFor("fedora");
    const layout = containerfile.slice(containerfile.indexOf("# Mend's person layout"));

    expect(layout.slice(0, layout.indexOf("\nENV "))).not.toContain("dnf");
    expect(containerfile.match(/dnf -y install/g)).toHaveLength(1);
  });

  it("adds the docker group, outside the reserved range, only with the workspace's own Docker", () => {
    expect(containerfileFor("arch", { docker: true })).toContain("groupadd -f -g 2375 docker");
    expect(containerfileFor("arch", { docker: false })).not.toContain("docker; \\");
    expect(containerfileFor("arch", { docker: false })).not.toContain("groupadd -f -g 2375");
  });

  it("leaves nix images one person's, and records what the probe finds there", () => {
    const containerfile = containerfileFor("nix");

    expect(containerfile).not.toContain("groupadd -g 40000 mend");
    expect(containerfile).not.toContain("/etc/sudoers.d/mend; \\");
    expect(containerfile).not.toContain("MISE_DATA_DIR");
    expect(containerfile).toContain(`/usr/local/lib/sealant/image-probe > ${IMAGE_PROBE_PATH}`);
    expect(containerfile).not.toContain("image-probe --require");
  });

  it("probes a custom base without changing it or failing its build", () => {
    const containerfile = containerfileFor("custom", { baseImage: "node:24-bookworm" });

    expect(containerfile).not.toContain("groupadd -g 40000 mend");
    expect(containerfile).not.toContain("MISE_DATA_DIR");
    expect(containerfile).toContain(`/usr/local/lib/sealant/image-probe > ${IMAGE_PROBE_PATH}`);
    expect(containerfile).not.toContain("image-probe --require");
  });

  it("carries the layout into a MicroVM image of the same base", () => {
    const planned = planWorkspaceImageBuild({ blueprint: blueprintFor("arch") });
    const recipe = microvmRecipe(planned, {
      agentPort: 8080,
      memoryMiB: 2048,
      dockerService: false,
      contextDigest: "digest",
    });

    expect(recipe.containerfile).toContain("pacman -S --noconfirm --needed sudo acl");
    expect(recipe.containerfile).toContain("groupadd -g 40000 mend");
    expect(recipe.containerfile).toContain("image-probe --require");
  });

  it("names a per-user credential store, never a shared one, for every tool it shares", () => {
    for (const toolchain of PERSON_TOOLCHAINS) {
      for (const shared of toolchain.shared) {
        expect(shared).not.toMatch(/credential|token|\.npmrc|netrc|auth/i);
      }
    }
    // Cargo's home, which holds credentials.toml, is the user's; only its caches and binaries link
    // out of it.
    expect(PERSON_TOOLCHAIN_ENV.map(([name]) => name)).not.toContain("CARGO_HOME");
    expect(PERSON_SKEL_LINKS.map(([link]) => link)).not.toContain(".cargo");
    expect(PERSON_SKEL_LINKS.map(([link]) => link)).not.toContain(".cargo/credentials.toml");
    // sudo keeps the toolchain variables and nothing else.
    const envKeep = PERSON_SUDOERS.find((line) => line.includes("env_keep"));
    expect(envKeep).toBe(
      `Defaults env_keep += "${PERSON_TOOLCHAIN_ENV.map(([name]) => name).join(" ")}"`,
    );
  });
});

describe("reading the image probe back from a built image", () => {
  it("records the probe on the build", async () => {
    const commandRunner = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === "run" ? JSON.stringify(readyProbe) : "",
      stderr: "",
    }));
    const result = await compileWorkspaceBuildSpec({
      blueprint: blueprintFor("ubuntu"),
      options: { commandRunner, emitTarball: false },
    });

    expect(result.metadata?.imageProbe).toEqual(readyProbe);
    const probeCall = commandRunner.mock.calls.find(([, args]) => args[0] === "run");
    expect(probeCall?.[1]).toEqual([
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--entrypoint",
      "/bin/sh",
      result.buildkit.spec.imageReference,
      "-c",
      `cat ${IMAGE_PROBE_PATH}`,
    ]);
  });

  it("keeps the build, with a note and no answer, when the probe cannot be read", async () => {
    const commandRunner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "run") throw new Error("cat: /etc/sealant/image-probe.json: No such file");
      return { stdout: "", stderr: "" };
    });
    const result = await compileWorkspaceBuildSpec({
      blueprint: blueprintFor("fedora"),
      options: { commandRunner, emitTarball: false },
    });

    expect(result.metadata?.imageProbe).toBeUndefined();
    expect(result.metadata?.notes).toContain(
      "The image probe could not be read back from the image: cat: /etc/sealant/image-probe.json: No such file",
    );
  });
});

describe("imagePersonLayoutSupport", () => {
  it("says yes when the image and its sealantd have everything", () => {
    expect(imagePersonLayoutSupport(readyProbe)).toEqual({ supported: true, missing: [] });
  });

  it("names every sealantd capability a sealantd without the command cannot report", () => {
    expect(imagePersonLayoutSupport({ ...readyProbe, sealantd: null })).toEqual({
      supported: false,
      missing: ["sealantd:exec.user", "sealantd:dotfiles.user", "sealantd:restore.owner_map"],
    });
  });

  it("refuses a nix-like image: no setuid sudo, no useradd, a read-only passwd", () => {
    const probe: WorkspaceImageProbe = {
      ...readyProbe,
      tools: { ...readyProbe.tools, sudoSetuid: false, useradd: false, setfacl: false },
      passwdWritable: false,
      mendGroup: "absent",
    };

    expect(imagePersonLayoutSupport(probe).missing).toEqual([
      "setuid-sudo",
      "useradd",
      "setfacl",
      "passwd-writable",
    ]);
  });

  it("refuses an image whose reserved ids or mend group are taken", () => {
    const probe: WorkspaceImageProbe = {
      ...readyProbe,
      mendGroup: "conflict",
      reservedIdsInUse: ["user:ceph:40001"],
    };

    expect(imagePersonLayoutSupport(probe).missing).toEqual(["mend-group", "reserved-ids"]);
  });

  it("accepts a mend group or sudoers rule prepare can still add", () => {
    expect(
      imagePersonLayoutSupport({ ...readyProbe, mendGroup: "absent", sudoersMend: false }),
    ).toEqual({ supported: true, missing: [] });
  });
});

describe("the image probe script", () => {
  const runProbe = (args: readonly string[]) =>
    execFileAsync("/bin/sh", ["-c", IMAGE_PROBE_SCRIPT.join("\n"), "image-probe", ...args], {
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        SEALANT_PERSON_SHARED_DIRS: "/opt/a:/var/cache/b",
      },
    });

  it("prints JSON the build record accepts, on this machine", async () => {
    const { stdout } = await runProbe([]);
    const probe = parseWorkspaceImageProbe(JSON.parse(stdout));

    expect(probe.sharedDirs).toEqual(["/opt/a", "/var/cache/b"]);
    expect(typeof probe.tools.useradd).toBe("boolean");
    for (const entry of probe.reservedIdsInUse) {
      expect(entry).toMatch(/^(user|group):[A-Za-z0-9._-]+:4\d{4}$/);
    }
  });

  it("with --require, fails naming what is missing, or passes on a machine that has it all", async () => {
    const outcome = await runProbe(["--require"]).then(
      () => ({ failed: false, stderr: "" }),
      (error: { stderr?: string }) => ({ failed: true, stderr: error.stderr ?? "" }),
    );
    if (outcome.failed) {
      expect(outcome.stderr).toMatch(
        /^sealant: this image cannot run the person layout; missing: /,
      );
    }
  });
});
