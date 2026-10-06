import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { parseWorkspaceBlueprint, parseWorkspaceImageProbe } from "@sealant/validators";
import type { WorkspaceImageProbe } from "@sealant/validators";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { microvmRecipe } from "../images/microvm/recipe.js";
import { compileWorkspaceBuildSpec, planWorkspaceImageBuild } from "./buildkit-builder.js";
import {
  ARCH_ARCHIVE_POOL,
  IMAGE_PROBE_PATH,
  IMAGE_PROBE_SCRIPT,
  PERSON_ENV,
  PERSON_ENV_FILE,
  PERSON_ENV_PATH,
  PERSON_PATH_PREPEND,
  PERSON_SHARED_DIRS,
  PERSON_SHARED_DIRS_PATH,
  PERSON_SHARED_SUBDIRS,
  PERSON_SKEL_LINKS,
  PERSON_SUDOERS,
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

/** Every `ENV` instruction of a Containerfile, continuation lines joined. */
const envInstructions = (containerfile: string): string[] =>
  containerfile
    .replaceAll("\\\n", " ")
    .split("\n")
    .filter((line) => line.startsWith("ENV "));

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
  // What sealantd#147's `sealantd capabilities --json` prints.
  sealantd: {
    schemaVersion: 1,
    daemonVersion: "0.21.0",
    os: "linux",
    arch: "x86_64",
    supports: ["dotfiles.user", "exec.user", "restore.owner_map"],
  },
};

describe("the person layout in the managed images", () => {
  // Every family installs them in the layout layer, after the harnesses (person-layout.ts says why).
  const families = [
    { family: "fedora", packageLine: /dnf -y install --refresh sudo acl util-linux; \\/u },
    { family: "arch", packageLine: /pacman -S --noconfirm --needed sudo acl; \\/u },
    {
      family: "ubuntu",
      packageLine: /apt-get install -y --no-install-recommends sudo acl; \\/u,
    },
  ];

  for (const { family, packageLine } of families) {
    it(`gives ${family} the mend group, sudo, the ACL tools and the shared directories`, () => {
      const containerfile = containerfileFor(family);

      expect(containerfile).toMatch(packageLine);
      expect(containerfile).toContain("groupadd -g 40000 mend");
      for (const line of PERSON_SUDOERS.slice(1)) expect(containerfile).toContain(line);
      expect(containerfile).toContain("visudo -cqf /etc/sudoers.d/mend");
      const dirs = [...PERSON_SHARED_DIRS, ...PERSON_SHARED_SUBDIRS];
      expect(containerfile).toContain(`chmod 2775 ${dirs.join(" ")}`);
      expect(containerfile).toContain(
        `printf '%s\\n' ${dirs.map((dir) => `'${dir}'`).join(" ")} > '${PERSON_SHARED_DIRS_PATH}'`,
      );
      for (const line of PERSON_ENV_FILE.slice(3)) expect(containerfile).toContain(`'${line}'`);
      expect(containerfile).toContain(`> '${PERSON_ENV_PATH}'`);
      for (const [link, target] of PERSON_SKEL_LINKS) {
        expect(containerfile).toContain(`ln -sfn ${target} /etc/skel/${link}`);
      }
      expect(containerfile).toContain("'store-dir=/var/cache/pnpm' > '/etc/skel/.config/pnpm/rc'");
      expect(containerfile).toContain("git config --system --replace-all safe.directory '*'");
      // A managed image that cannot run the person layout fails its build.
      expect(containerfile).toContain(
        `/usr/local/lib/sealant/image-probe --require > ${IMAGE_PROBE_PATH}`,
      );
    });

    it(`installs ${family}'s layout packages after the harnesses, never in the package layer`, () => {
      const containerfile = containerfileFor(family);
      const layout = containerfile.search(packageLine);
      // Each RUN of the package layer and of every harness install comes first, so a change to
      // the layout's packages rebuilds only its own layer: no OS upgrade, no harness reinstall.
      const harnesses = [...containerfile.matchAll(/^RUN .*(npm install -g|pi-linux)/gmu)];
      expect(harnesses.length).toBeGreaterThanOrEqual(4);
      for (const harness of harnesses) expect(harness.index).toBeLessThan(layout);
      const packageLayer = containerfile.match(
        /^RUN [^\n]*\n?(?:.*\\\n)*.*(?:dnf -y install|pacman -S --noconfirm --needed|apt-get install) [^\n]*bash[^\n]*$/mu,
      );
      expect(packageLayer?.[0]).toBeDefined();
      expect(packageLayer?.[0]).not.toMatch(/\b(sudo|acl)\b/u);
    });

    it(`leaves ${family}'s environment exactly as it was`, () => {
      const containerfile = containerfileFor(family);
      const env = envInstructions(containerfile).join("\n");

      // Root and every shared-layout process see the image ENV: nothing of the layout is in it.
      for (const [name] of PERSON_ENV) expect(env).not.toContain(name);
      expect(env).not.toContain("/opt/");
      expect(env).not.toContain("/var/cache");
      expect(env).not.toContain("SEALANT_PERSON");
      // What broke one-person sessions in an earlier draft: nvm, the pyenv installer, the npm
      // warnings, and every node_modules installed against root's pnpm store.
      expect(containerfile).not.toMatch(/(^|[^p])npm_config_store_dir/mu);
      for (const gone of [
        "npm_config_devdir",
        "npm_config_cache",
        "NVM_DIR",
        "PYENV_ROOT",
        "/opt/nvm",
        "/opt/pyenv",
        "/opt/mise/shims",
      ]) {
        expect(containerfile).not.toContain(gone);
      }
    });

    it(`keeps ${family}'s harness layers ahead of the layout, and probes last`, () => {
      const containerfile = containerfileFor(family);
      const layout = containerfile.indexOf("groupadd -g 40000 mend");
      const lastHarness = containerfile.lastIndexOf("RUN npm install -g");
      const probe = containerfile.indexOf("image-probe --require");
      const bootEnv = containerfile.indexOf("ENV SEALANT_OS_FAMILY=");

      expect(lastHarness).toBeGreaterThan(0);
      expect(layout).toBeGreaterThan(lastHarness);
      expect(probe).toBeGreaterThan(layout);
      expect(bootEnv).toBeGreaterThan(probe);
    });
  }

  it("puts pnpm's global bins on a person's PATH, for pnpm 10 and for 11 and later", () => {
    // pnpm 11 and 12 refuse `add -g` unless $PNPM_HOME/bin is on PATH; pnpm 10 uses $PNPM_HOME.
    expect(PERSON_PATH_PREPEND.indexOf("/opt/pnpm/bin")).toBeGreaterThanOrEqual(0);
    expect(PERSON_PATH_PREPEND.indexOf("/opt/pnpm/bin")).toBeLessThan(
      PERSON_PATH_PREPEND.indexOf("/opt/pnpm"),
    );
    expect(PERSON_SHARED_SUBDIRS).toContain("/opt/pnpm/bin");
    expect(PERSON_SUDOERS.find((line) => line.includes("secure_path"))).toContain(
      "/opt/pnpm/bin:/opt/pnpm:",
    );
    expect(PERSON_ENV_FILE).toContain(`PATH_PREPEND=${PERSON_PATH_PREPEND.join(":")}`);
  });

  it("opens the person environment with its version, for readers that know it", () => {
    expect(PERSON_ENV_FILE[0]).toBe("# person-env 1");
  });

  it("makes every new home 0700, whatever the family's default", () => {
    for (const family of ["fedora", "arch", "ubuntu"]) {
      expect(containerfileFor(family)).toContain(
        "if grep -q '^HOME_MODE' /etc/login.defs; then sed -i 's/^HOME_MODE.*/HOME_MODE\\t0700/' /etc/login.defs; else printf 'HOME_MODE\\t0700\\n' >> /etc/login.defs; fi",
      );
    }
  });

  it("binds every sudo default to the mend group, so root's sudo is unchanged", () => {
    const defaults = PERSON_SUDOERS.filter((line) => line.startsWith("Defaults"));

    expect(defaults.length).toBeGreaterThan(0);
    for (const line of defaults) expect(line.startsWith("Defaults:%mend ")).toBe(true);
    expect(PERSON_SUDOERS.find((line) => line.includes("env_keep"))).toBe(
      `Defaults:%mend env_keep += "${PERSON_ENV.map(([name]) => name).join(" ")}"`,
    );
  });

  it("installs Arch's layout packages against its package layer's database, never -Sy", () => {
    const containerfile = containerfileFor("arch");
    const layout = containerfile.slice(containerfile.indexOf("# Mend's person layout"));
    const layoutRun = layout.slice(0, layout.indexOf("\n\n"));

    // A partial upgrade is never made: the archive serves what a mirror has since dropped.
    expect(layoutRun).not.toMatch(/pacman -S[a-z]*y/u);
    const commands = layoutRun.split("; \\\n").map((command) => command.trim());
    const append = commands.indexOf(
      `echo 'Server = ${ARCH_ARCHIVE_POOL}' >> /etc/pacman.d/mirrorlist`,
    );
    const install = commands.indexOf("pacman -S --noconfirm --needed sudo acl");
    const restore = commands.indexOf("mv /tmp/mirrorlist /etc/pacman.d/mirrorlist");
    expect(commands.indexOf("cp /etc/pacman.d/mirrorlist /tmp/mirrorlist")).toBeLessThan(append);
    expect(append).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(append);
    expect(restore).toBeGreaterThan(install);
  });

  it("adds the docker group, keeping one the image has, only with the workspace's own Docker", () => {
    expect(containerfileFor("arch", { docker: true })).toContain(
      "getent group docker >/dev/null || groupadd -g 2375 docker",
    );
    expect(containerfileFor("arch", { docker: false })).not.toContain("groupadd -g 2375");
  });

  it("leaves nix images one person's, and records what the probe finds there", () => {
    const containerfile = containerfileFor("nix");

    expect(containerfile).not.toContain("groupadd -g 40000 mend");
    expect(containerfile).not.toContain(`> '${PERSON_ENV_PATH}'`);
    expect(containerfile).toContain(`/usr/local/lib/sealant/image-probe > ${IMAGE_PROBE_PATH}`);
    expect(containerfile).not.toContain("image-probe --require");
  });

  it("probes a custom base without changing it, and never fails its build", () => {
    const containerfile = containerfileFor("custom", { baseImage: "node:24-bookworm" });

    expect(containerfile).not.toContain("groupadd -g 40000 mend");
    expect(containerfile).not.toContain(`> '${PERSON_ENV_PATH}'`);
    expect(containerfile).toContain(`/usr/local/lib/sealant/image-probe > ${IMAGE_PROBE_PATH}`);
    expect(containerfile).not.toContain("image-probe --require");
    // A base that builds as a user who cannot write /etc still builds, and reads as unknown.
    expect(containerfile).toContain(
      "|| echo 'sealant: the image probe could not be written; this image reads as unknown.' >&2",
    );
  });

  it("carries the layout into a MicroVM image of the same base", () => {
    const planned = planWorkspaceImageBuild({ blueprint: blueprintFor("arch") });
    const recipe = microvmRecipe(planned, {
      agentPort: 8080,
      memoryMiB: 2048,
      dockerService: false,
      contextDigest: "digest",
    });

    expect(recipe.containerfile).toMatch(/pacman -S --noconfirm --needed sudo acl; \\/u);
    expect(recipe.containerfile).toContain("groupadd -g 40000 mend");
    expect(recipe.containerfile).toContain("image-probe --require");
  });

  it("names a per-user credential store, never a shared one, for every tool it shares", () => {
    for (const toolchain of PERSON_TOOLCHAINS) {
      for (const shared of toolchain.shared) {
        expect(shared).not.toMatch(/credential|token|\.npmrc|netrc|auth|npm_config_cache/i);
      }
    }
    // Cargo's home, which holds credentials.toml, is the user's; only its caches and binaries link
    // out of it. npm's cache holds its debug logs, which print a token passed on the command line.
    const names = PERSON_ENV.map(([name]) => name);
    expect(names).not.toContain("CARGO_HOME");
    expect(names).not.toContain("npm_config_cache");
    expect(PERSON_SKEL_LINKS.map(([link]) => link)).not.toContain(".cargo");
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
  it("needs setpriv and flock, which every write into a person's home takes", () => {
    expect(
      imagePersonLayoutSupport({ ...readyProbe, tools: { ...readyProbe.tools, setpriv: false } })
        .missing,
    ).toEqual(["setpriv"]);
    expect(
      imagePersonLayoutSupport({ ...readyProbe, tools: { ...readyProbe.tools, flock: false } })
        .missing,
    ).toEqual(["flock"]);
    // An image probed before flock was recorded: unknown, never supported.
    const withoutFlock = {
      sudo: true,
      sudoSetuid: true,
      useradd: true,
      groupadd: true,
      setfacl: true,
      getfacl: true,
      setpriv: true,
    };
    expect(imagePersonLayoutSupport({ ...readyProbe, tools: withoutFlock })).toMatchObject({
      status: "unknown",
      unknown: ["flock"],
    });
  });

  it("says yes when the image and its sealantd have everything", () => {
    expect(imagePersonLayoutSupport(readyProbe)).toEqual({
      status: "supported",
      missing: [],
      unknown: [],
    });
  });

  it("names the capabilities a sealantd that answers does not list", () => {
    expect(
      imagePersonLayoutSupport({ ...readyProbe, sealantd: { supports: ["restore.owner_map"] } }),
    ).toEqual({
      status: "unsupported",
      missing: ["sealantd:exec.user", "sealantd:dotfiles.user"],
      unknown: [],
    });
  });

  it("names every capability a sealantd without the command cannot report", () => {
    expect(imagePersonLayoutSupport({ ...readyProbe, sealantd: null })).toEqual({
      status: "unsupported",
      missing: ["sealantd:exec.user", "sealantd:dotfiles.user", "sealantd:restore.owner_map"],
      unknown: [],
    });
  });

  it("reads an answer it cannot read as unknown, never as missing capabilities", () => {
    for (const sealantd of [
      "unreadable" as const,
      { supports: { "exec.user": true } },
      { supports: ["exec.user", 7] },
      { capabilities: ["exec.user", "dotfiles.user", "restore.owner_map"] },
    ]) {
      expect(imagePersonLayoutSupport({ ...readyProbe, sealantd })).toEqual({
        status: "unknown",
        missing: [],
        unknown: ["sealantd"],
      });
    }
  });

  it("refuses sudo under no_new_privs, seen by the probe or set by the runtime", () => {
    expect(imagePersonLayoutSupport(readyProbe, { noNewPrivileges: true }).missing).toEqual([
      "sudo-no-new-privileges",
    ]);
    expect(imagePersonLayoutSupport({ ...readyProbe, noNewPrivileges: true }).missing).toEqual([
      "sudo-no-new-privileges",
    ]);
  });

  it("refuses a nix-like image: no setuid sudo, no useradd, a read-only passwd", () => {
    const probe: WorkspaceImageProbe = {
      ...readyProbe,
      tools: {
        ...readyProbe.tools,
        sudoSetuid: false,
        useradd: false,
        groupadd: false,
        setfacl: false,
      },
      sudoersMend: false,
      sudoersIncludesDir: false,
      passwdWritable: false,
      mendGroup: "absent",
    };

    expect(imagePersonLayoutSupport(probe).missing).toEqual([
      "setuid-sudo",
      "useradd",
      "groupadd",
      "sudoers",
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

  it("accepts a mend group or sudoers rule prepare can still add, and only then", () => {
    expect(
      imagePersonLayoutSupport({ ...readyProbe, mendGroup: "absent", sudoersMend: false }).status,
    ).toBe("supported");
    expect(
      imagePersonLayoutSupport({
        ...readyProbe,
        mendGroup: "absent",
        tools: { ...readyProbe.tools, groupadd: false },
      }).missing,
    ).toEqual(["groupadd"]);
    expect(
      imagePersonLayoutSupport({ ...readyProbe, sudoersMend: false, sudoersIncludesDir: false })
        .missing,
    ).toEqual(["sudoers"]);
  });
});

describe("the image probe script", () => {
  const runProbe = (args: readonly string[], env: Record<string, string> = {}) =>
    execFileAsync("/bin/sh", ["-c", IMAGE_PROBE_SCRIPT.join("\n"), "image-probe", ...args], {
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env },
    });

  let fakes: string | undefined;
  beforeAll(async () => {
    fakes = await mkdtemp(join(tmpdir(), "image-probe-sealantd-"));
  });
  afterAll(async () => {
    if (fakes !== undefined) await rm(fakes, { recursive: true, force: true });
  });

  /** The probe's `sealantd` field, asking a stand-in sealantd that runs `body`. */
  const sealantdField = async (body: string): Promise<unknown> => {
    const path = join(fakes ?? tmpdir(), `sealantd-${String(Math.random()).slice(2)}`);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    const { stdout } = await runProbe([], { SEALANT_PROBE_SEALANTD: path });
    return parseWorkspaceImageProbe(JSON.parse(stdout)).sealantd;
  };

  it("records a sealantd from before the capabilities command as null", async () => {
    // clap's answer to an unknown subcommand, today's sealantd's.
    expect(
      await sealantdField("echo \"error: unrecognized subcommand 'capabilities'\" >&2; exit 2"),
    ).toBe(null);
  });

  it("records a sealantd that times out, crashes or fails otherwise as unreadable", async () => {
    expect(await sealantdField("exit 124")).toBe("unreadable");
    expect(await sealantdField("kill -SEGV $$")).toBe("unreadable");
    expect(await sealantdField("exit 1")).toBe("unreadable");
    expect(await sealantdField("echo not json")).toBe("unreadable");
  });

  it("records sealantd's answer, whitespace and all", async () => {
    expect(
      await sealantdField(
        `printf '  {"schemaVersion":1,"supports":["exec.user","dotfiles.user","restore.owner_map"]}\\n\\n'`,
      ),
    ).toEqual({
      schemaVersion: 1,
      supports: ["exec.user", "dotfiles.user", "restore.owner_map"],
    });
  });

  it("prints JSON the build record accepts, on this machine", async () => {
    const { stdout } = await runProbe([]);
    const probe = parseWorkspaceImageProbe(JSON.parse(stdout));

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
