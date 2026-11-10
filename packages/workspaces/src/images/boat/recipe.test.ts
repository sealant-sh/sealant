import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import lock from "../../../boat-image/asset-lock.json" with { type: "json" };
import {
  nativeWorkspaceInstallation,
  planWorkspaceImageBuild,
} from "../../buildkit/buildkit-builder.js";
import { createWorkspaceBuildSpec } from "../../buildkit/docker-parity.fixture.js";
import { BOAT_AGENT_FILES, BOAT_AGENT_MANIFEST_FILE } from "../../runtime/boat/agent-contract.js";
import {
  BOAT_AGENT_DOCKER_DROPIN_PATH,
  BOAT_AGENT_UNIT_PATH,
  boatAgentManifestDigest,
  createNativeRecipe,
  NATIVE_SUBSTRATE,
} from "./recipe.js";
import {
  NATIVE_RUNTIME_PIN,
  sha256,
  VerifiedRuntimeBundle,
  type NativeRuntimeIdentity,
} from "./runtime-bundle.js";

const runtime: NativeRuntimeIdentity = {
  source: NATIVE_RUNTIME_PIN.source,
  platform: "linux/amd64",
  manifest: NATIVE_RUNTIME_PIN.manifest,
  sealantd: NATIVE_RUNTIME_PIN.sealantd,
  sealantctl: NATIVE_RUNTIME_PIN.sealantctl,
};
const daemon = Buffer.from("sealantd bytes");
const client = Buffer.from("sealantctl bytes");
const serializationBundleFixture = {
  identity: runtime,
  files: () => [
    { path: "/usr/local/bin/sealantd", bytes: daemon, sha256: sha256(daemon) },
    { path: "/usr/local/bin/sealantctl", bytes: client, sha256: sha256(client) },
  ],
};
const spec = (family: "ubuntu" | "nix" | "auto" | "arch" | "fedora" | "custom" = "ubuntu") =>
  createWorkspaceBuildSpec({
    target: { os: { family, mode: "require" }, runtime: { family: "auto", mode: "prefer" } },
  });
const withDocker = (base = spec()) => ({
  ...base,
  tooling: { ...base.tooling, services: { docker: { enabled: true } } },
});
const text = (bytes: Uint8Array | undefined) => Buffer.from(bytes ?? []).toString();

describe("native recipe boundary", () => {
  it("ships the guest agent, its Boat host mode and the bind CLI beside the pinned Node, run by one unit", async () => {
    const planned = await createNativeRecipe(spec(), serializationBundleFixture);
    if (!planned.ok) throw planned.error;
    const files = planned.value.files;
    for (const source of BOAT_AGENT_FILES) {
      const name = source.slice(source.lastIndexOf("/") + 1);
      const shipped = files.find((file) => file.path === `/opt/sealant/${name}`);
      expect(shipped?.mode).toBe("0644");
      expect(shipped?.sha256).toBe(lock.files.find((file) => file.name === name)?.sha256);
    }
    expect(files.find((file) => file.path === "/usr/local/bin/sealantd")?.sha256).toBe(
      sha256(daemon),
    );
    expect(files.find((file) => file.path === "/usr/local/bin/sealantctl")?.mode).toBe("0755");
    const unit = text(files.find((file) => file.path === BOAT_AGENT_UNIT_PATH)?.bytes);
    expect(unit).toContain("ExecStart=/opt/sealant/node /opt/sealant/agent.mjs");
    expect(unit).toContain("Environment=SEALANT_AGENT_HOST=boat");
    expect(unit).toContain("Environment=SEALANT_CONTROL_SOCKET=/run/sealant/control.sock");
    expect(unit).toContain("Environment=SEALANT_MICROVM_AGENT_PORT=8080");
    expect(unit).toContain("Restart=no");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(files.some((file) => file.path === BOAT_AGENT_DOCKER_DROPIN_PATH)).toBe(false);
    expect(files.some((file) => file.path.endsWith("download-docker.sh"))).toBe(false);
    // Nothing of the box: no mapped root, no Python guest, no relay, no held-boot units.
    for (const file of files) {
      expect(file.path).not.toContain("/var/lib/sealant/guest");
      expect(file.path).not.toContain("/var/lib/sealant/workspace-root");
      expect(file.path).not.toMatch(/\.py$/);
    }
    expect(planned.value.installScript).not.toContain("debootstrap");
    expect(planned.value.installScript).not.toContain("systemd-container");
    expect(planned.value.installScript).not.toContain("python3");
    expect(planned.value.installScript).not.toContain("uidmap");
    expect(planned.value.installScript).toContain("systemctl enable sealant-agent.service");
    expect(planned.value.installScript).toContain(
      "! systemctl is-active --quiet sealant-agent.service",
    );
  });
  it("writes the agent manifest digest the bind exchange names, over the agent files, the daemon and the unit", async () => {
    const planned = await createNativeRecipe(spec(), serializationBundleFixture);
    if (!planned.ok) throw planned.error;
    const files = planned.value.files;
    const manifest = files.find((file) => file.path === BOAT_AGENT_MANIFEST_FILE);
    expect(manifest?.mode).toBe("0600");
    expect(JSON.parse(text(manifest?.bytes))).toEqual({
      digest: planned.value.agentManifestDigest,
    });
    const covered = files.filter(
      (file) =>
        file.path.startsWith("/opt/sealant/") ||
        file.path === "/usr/local/bin/sealantd" ||
        file.path === BOAT_AGENT_UNIT_PATH,
    );
    expect(covered.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "/opt/sealant/agent.mjs",
        "/opt/sealant/boat-host.mjs",
        "/opt/sealant/boat-bind.mjs",
        "/usr/local/bin/sealantd",
        BOAT_AGENT_UNIT_PATH,
      ]),
    );
    // The project install script lives beside the agent but is not the agent.
    expect(planned.value.agentManifestDigest).toBe(
      boatAgentManifestDigest(covered.filter((file) => !file.path.endsWith("project-install.sh"))),
    );
    // Another daemon is another manifest; another project is not.
    const otherDaemon = await createNativeRecipe(spec(), {
      ...serializationBundleFixture,
      files: () => [
        { path: "/usr/local/bin/sealantd", bytes: client, sha256: sha256(client) },
        { path: "/usr/local/bin/sealantctl", bytes: client, sha256: sha256(client) },
      ],
    });
    const otherProject = await createNativeRecipe(
      { ...spec(), customization: { ...spec().customization, defaultShell: "zsh" } },
      serializationBundleFixture,
    );
    if (!otherDaemon.ok || !otherProject.ok) throw new Error("recipes");
    expect(otherDaemon.value.agentManifestDigest).not.toBe(planned.value.agentManifestDigest);
    expect(otherProject.value.agentManifestDigest).toBe(planned.value.agentManifestDigest);
  });
  it("carries the Docker engine and turns the agent's Docker service on when the blueprint asks for it", async () => {
    const planned = await createNativeRecipe(withDocker(), serializationBundleFixture);
    if (!planned.ok) throw planned.error;
    const files = planned.value.files;
    expect(planned.value.dockerService).toBe(true);
    const installer = files.find((file) => file.path === "/opt/sealant/download-docker.sh");
    expect(installer?.mode).toBe("0755");
    expect(installer?.sha256).toBe(
      lock.files.find((file) => file.name === "download-docker.sh")?.sha256,
    );
    expect(planned.value.installScript).toContain("/opt/sealant/download-docker.sh");
    const dropin = text(files.find((file) => file.path === BOAT_AGENT_DOCKER_DROPIN_PATH)?.bytes);
    expect(dropin).toContain("Environment=SEALANT_MICROVM_DOCKER_CAPABLE=1");
    expect(dropin).toContain("Environment=SEALANT_MICROVM_DOCKER_BIP=198.18.1.1/24");
    expect(dropin).toContain(
      "Environment=SEALANT_MICROVM_DOCKER_ADDRESS_POOLS=base=198.19.0.0/16,size=24",
    );
    expect(dropin).toContain("Environment=SEALANT_MICROVM_DOCKER_GROUP=docker");
    // The proved stop is the agent's Boat default, not something the image must remember.
    expect(dropin).not.toContain("CGROUP");
    expect(dropin).not.toContain("CONTAINER_STOP_SECONDS");
    // The person layout makes the docker group the daemon's socket is owned by.
    const project = text(files.find((file) => file.path.endsWith("project-install.sh"))?.bytes);
    expect(project).toContain("groupadd -g 2375 docker");
    const plain = await createNativeRecipe(spec(), serializationBundleFixture);
    if (!plain.ok) throw plain.error;
    expect(
      text(plain.value.files.find((f) => f.path.endsWith("project-install.sh"))?.bytes),
    ).not.toContain("groupadd -g 2375 docker");
    // The drop-in is part of the agent: a Docker image has another manifest digest.
    expect(planned.value.agentManifestDigest).not.toBe(plain.value.agentManifestDigest);
    expect(planned.value.hash).not.toBe(plain.value.hash);
  });
  it("preserves Boat's base systemd family and installs what the agent and the tunnel need", async () => {
    for (const family of ["ubuntu", "nix"] as const) {
      const recipe = await createNativeRecipe(spec(family), serializationBundleFixture);
      if (!recipe.ok) throw recipe.error;
      const script = recipe.value.installScript;
      expect(NATIVE_SUBSTRATE.systemd.version).toBe("255.4-1ubuntu8.16");
      for (const name of [
        "systemd",
        "systemd-sysv",
        "libsystemd0",
        "libsystemd-shared",
        "libudev1",
      ])
        expect(script).toContain(`dpkg-query -W -f='\${Version}' ${name}`);
      const hold = script.indexOf('apt-mark hold "${systemd_packages[@]}"');
      expect(hold).toBeGreaterThan(0);
      expect(hold).toBeLessThan(script.indexOf("apt-get update"));
      expect(script).toContain('$2 == "systemd" && $3 == "installed"');
      expect(script).toContain(
        "apt-get install -y --no-install-recommends curl xz-utils ca-certificates procps util-linux iproute2 iptables kmod wireguard-tools",
      );
      const unchanged =
        'test "$systemd_versions" = "$(dpkg-query -W -f=\'${binary:Package}=${Version}\\n\' "${systemd_packages[@]}")"';
      expect(script.split(unchanged)).toHaveLength(3);
      expect(script.trimEnd().endsWith(unchanged)).toBe(true);
      expect(script).not.toContain("--allow-change-held-packages");
      expect(script).not.toContain("--allow-downgrades");
    }
  });
  it("pins the self-contained Node binary that runs the agent", async () => {
    const recipe = await createNativeRecipe(spec(), serializationBundleFixture);
    if (!recipe.ok) throw recipe.error;
    expect(recipe.value.substrate.node.version).toBe("24.22.2");
    expect(recipe.value.installScript).toContain(NATIVE_SUBSTRATE.node.archive);
    expect(recipe.value.installScript).toContain(NATIVE_SUBSTRATE.node.sha256);
    expect(recipe.value.installScript).toContain("--to-stdout node-v24.22.2-linux-x64/bin/node");
    expect(recipe.value.installScript).toContain("/opt/sealant/node --version");
    expect(recipe.value.installScript).not.toContain("python3 nodejs");
  });
  it("does not install dotfiles without a source when applyDotfiles is enabled", async () => {
    const base = spec();
    const disabled = { ...base, customization: { ...base.customization, applyDotfiles: false } };
    const enabled = { ...base, customization: { ...base.customization, applyDotfiles: true } };
    expect(base.sources.inputs).toEqual([]);
    expect(base.runtime.dotfilesArchives).toEqual([]);
    expect(nativeWorkspaceInstallation(enabled).shell).toBe(
      nativeWorkspaceInstallation(disabled).shell,
    );
    const recipes = await Promise.all(
      [enabled, disabled].map((input) => createNativeRecipe(input, serializationBundleFixture)),
    );
    const projects = recipes.map((recipe) => {
      if (!recipe.ok) throw recipe.error;
      return recipe.value.files.find((file) => file.path.endsWith("project-install.sh"))?.sha256;
    });
    expect(projects[0]).toBeDefined();
    expect(projects[0]).toBe(projects[1]);
  });

  it("refuses inline dotfiles credentials before build or runtime serialization", async () => {
    const base = spec();
    for (const authRef of [undefined, "github-installation-repository:gh_installation_repo_1"]) {
      for (const url of [
        "https://user:token@example.invalid/dots.git",
        "https://token@example.invalid/dots.git",
        "ssh://git:token@example.invalid/dots.git",
        "https://example.invalid/dots.git?access_token=secret",
        "https://example.invalid/dots.git?X-Amz-Signature=secret",
        "https://example.invalid/dots.git#secret",
      ]) {
        const result = await createNativeRecipe(
          {
            ...base,
            sources: {
              ...base.sources,
              inputs: [
                {
                  id: "dotfiles",
                  purpose: "dotfiles",
                  kind: "git",
                  provider: "generic",
                  url,
                  ...(authRef === undefined ? {} : { authRef }),
                },
              ],
            },
          },
          serializationBundleFixture,
        );
        expect(result).toMatchObject({ ok: false, error: { code: "native-dotfiles-unsafe-url" } });
        expect(JSON.stringify(result)).not.toContain("secret");
      }
    }
    expect(
      await createNativeRecipe(
        {
          ...base,
          sources: {
            ...base.sources,
            inputs: [
              {
                id: "dotfiles",
                purpose: "dotfiles",
                kind: "git",
                provider: "generic",
                url: "ssh://git@example.invalid/dots.git",
              },
            ],
          },
        },
        serializationBundleFixture,
      ),
    ).toMatchObject({ ok: true });
  });
  it("keeps container-only service and loader changes out of native installation", async () => {
    for (const family of ["ubuntu", "nix"] as const) {
      const recipe = await createNativeRecipe(spec(family), serializationBundleFixture);
      expect(recipe.ok).toBe(true);
      if (!recipe.ok) throw recipe.error;
      expect(() =>
        execFileSync("bash", ["-n"], { input: recipe.value.installScript }),
      ).not.toThrow();
      const nixStart = recipe.value.files.find((f) => f.path.endsWith("native-nix-start"));
      expect(nixStart).toBeDefined();
      expect(() => execFileSync("sh", ["-n"], { input: nixStart?.bytes })).not.toThrow();
      expect(recipe.value.installScript).not.toContain("sshd.service");
      expect(recipe.value.installScript).not.toContain('ln -sf "$loader"');
      const project = text(
        recipe.value.files.find((file) => file.path.endsWith("project-install.sh"))?.bytes,
      );
      expect(() => execFileSync("bash", ["-n"], { input: project })).not.toThrow();
      for (const cli of ["codex@", "claude-code@", "opencode-ai@", "pi-linux-"])
        expect(project).toContain(cli);
      expect(project).toContain("groupadd -g 40000 mend");
      expect(project).toContain("/etc/sealant/person-env");
      // The install never starts the daemon: the snapshot's own boots do, through the agent.
      expect(recipe.value.installScript).not.toMatch(/sealantd.* boot/);
      expect(recipe.value.installScript).toContain("/bin/bash /opt/sealant/project-install.sh");
      expect(recipe.value.installScript).toContain("test -f /etc/sealant/image-probe.json");
    }
    expect(nativeWorkspaceInstallation(spec("auto")).family).toBe("ubuntu");
  });

  it("refuses unsupported families and unproven authenticated build staging", async () => {
    for (const family of ["arch", "fedora"] as const)
      expect(await createNativeRecipe(spec(family), serializationBundleFixture)).toMatchObject({
        ok: false,
        error: { code: "native-unsupported-os" },
      });
    expect(await createNativeRecipe(spec("custom"), serializationBundleFixture)).toMatchObject({
      ok: false,
      error: { code: "native-custom-base-unsupported" },
    });
    const runsc = spec();
    expect(
      await createNativeRecipe(
        { ...runsc, runtime: { ...runsc.runtime, ociRuntime: "runsc" } },
        serializationBundleFixture,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "native-oci-runtime-unsupported" },
    });
    const base = spec();
    expect(
      await createNativeRecipe(
        {
          ...base,
          sources: {
            ...base.sources,
            inputs: [
              {
                id: "dotfiles",
                purpose: "dotfiles",
                kind: "git",
                provider: "generic",
                url: "https://github.com/example/dots",
                authRef: "/keys/private",
              },
            ],
          },
        },
        serializationBundleFixture,
      ),
    ).toMatchObject({ ok: false, error: { code: "native-dotfiles-tmpfs-unproven" } });
  });

  it("hashes actual file bytes, runtime identity, shell, lifecycle metadata, and immutable inputs", async () => {
    const base = spec();
    const first = await createNativeRecipe(base, serializationBundleFixture);
    if (!first.ok) throw first.error;
    const changes = [
      createNativeRecipe(
        { ...base, customization: { ...base.customization, defaultShell: "zsh" } },
        serializationBundleFixture,
      ),
      createNativeRecipe(
        {
          ...base,
          lifecycle: { ...base.lifecycle, setup: [{ run: "touch /must-not-run", shell: "sh" }] },
        },
        serializationBundleFixture,
      ),
      createNativeRecipe(base, {
        ...serializationBundleFixture,
        identity: { ...runtime, sealantctl: "b".repeat(64) },
      }),
      createNativeRecipe(base, {
        ...serializationBundleFixture,
        files: () => [{ path: "/test", bytes: Buffer.from("changed"), sha256: sha256("changed") }],
      }),
    ];
    for (const result of await Promise.all(changes)) {
      if (!result.ok) throw result.error;
      expect(result.value.hash).not.toBe(first.value.hash);
    }
    for (const f of first.value.files) expect(f.sha256).toBe(sha256(f.bytes));
    const unit = await readFile(
      new URL("../../../boat-image/sealant-agent.service", import.meta.url),
      "utf8",
    );
    expect(createHash("sha256").update(unit).digest("hex")).toBe(
      lock.files.find((file) => file.name === "sealant-agent.service")?.sha256,
    );
    expect(unit).toContain("Restart=no");
    expect(unit).not.toContain("ConditionPathExists");
  });

  it("refuses Ubuntu Chromium on ARM during planning", () => {
    const base = spec();
    expect(() =>
      planWorkspaceImageBuild({
        blueprint: { ...base, tooling: { packages: [{ id: "chromium" }] } },
        platform: "linux/arm64",
      }),
    ).toThrow(/no verified release/);
  });

  it("rejects cached or relabelled daemon bytes before any guest work", () => {
    expect(
      VerifiedRuntimeBundle.parse({
        sourceIndex: Buffer.from("{}"),
        platformManifest: Buffer.from("{}"),
        sealantd: Buffer.from("next177"),
        sealantctl: Buffer.from("sealantctl"),
      }),
    ).toMatchObject({ ok: false, error: { code: "native-runtime-provenance-mismatch" } });
  });
});
