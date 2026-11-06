import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  nativeWorkspaceInstallation,
  planWorkspaceImageBuild,
} from "../../buildkit/buildkit-builder.js";
import { createWorkspaceBuildSpec } from "../../buildkit/docker-parity.fixture.js";
import { createNativeRecipe, NATIVE_SUBSTRATE } from "./recipe.js";
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
  socat: NATIVE_RUNTIME_PIN.socat,
  relay: "a".repeat(64),
};
const serializationBundleFixture = { identity: runtime, files: () => [] };
const spec = (family: "ubuntu" | "nix" | "auto" | "arch" | "fedora" | "custom" = "ubuntu") =>
  createWorkspaceBuildSpec({
    target: { os: { family, mode: "require" }, runtime: { family: "auto", mode: "prefer" } },
  });

describe("native recipe boundary", () => {
  it("preserves Boat's base systemd family while installing the matching nspawn package", async () => {
    for (const family of ["ubuntu", "nix"] as const) {
      const recipe = await createNativeRecipe(spec(family), serializationBundleFixture);
      if (!recipe.ok) throw recipe.error;
      const script = recipe.value.installScript;
      expect(NATIVE_SUBSTRATE.systemd.version).toBe("255.4-1ubuntu8.16");
      expect(NATIVE_SUBSTRATE.systemd.snapshot).toBe(
        "https://snapshot.ubuntu.com/ubuntu/20260731T000000Z/",
      );
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
      expect(script).toContain("native-systemd-snapshot-digest-mismatch");
      expect(script).toContain("native-systemd-snapshot-package-mismatch");
      expect(script).toContain(NATIVE_SUBSTRATE.systemd.indexSha256);
      expect(script).toContain(NATIVE_SUBSTRATE.systemd.sha256);
      expect(script).toContain('uidmap "$snapshot_directory/systemd-container.deb"');
      expect(script).toContain("apt-mark hold systemd-container");
      const unchanged =
        'test "$systemd_versions" = "$(dpkg-query -W -f=\'${binary:Package}=${Version}\\n\' "${systemd_packages[@]}")"';
      expect(script.split(unchanged)).toHaveLength(3);
      expect(script.trimEnd().endsWith(unchanged)).toBe(true);
      expect(script).not.toContain("--allow-change-held-packages");
      expect(script).not.toContain("--allow-downgrades");
    }
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
      const project = Buffer.from(
        recipe.value.files.find((file) => file.path.endsWith("project-install.sh"))?.bytes ?? [],
      ).toString();
      expect(() => execFileSync("bash", ["-n"], { input: project })).not.toThrow();
      for (const cli of ["codex@", "claude-code@", "opencode-ai@", "pi-linux-"])
        expect(project).toContain(cli);
      expect(project).toContain("groupadd -g 40000 mend");
      expect(project).toContain("/etc/sealant/person-env");
      expect(recipe.value.installScript).not.toMatch(/sealantd.* boot/);
      expect(
        recipe.value.files.find((f) => f.path.endsWith("workspace.service"))?.bytes,
      ).toBeDefined();
      expect(recipe.value.installScript).toContain(
        "systemctl enable sealant-held.service sealant-held-watchdog.timer",
      );
    }
    expect(nativeWorkspaceInstallation(spec("auto")).family).toBe("ubuntu");
  });

  it("refuses unsupported families, workspace Docker, and unproven authenticated build staging", async () => {
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
    expect(
      await createNativeRecipe(
        { ...spec(), tooling: { packages: [], services: { docker: { enabled: true } } } },
        serializationBundleFixture,
      ),
    ).toMatchObject({ ok: false, error: { code: "native-workspace-docker-unsupported" } });
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

  it("hashes actual file bytes, relay identity, shell, lifecycle metadata, and immutable inputs", async () => {
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
        identity: { ...runtime, relay: "b".repeat(64) },
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
      new URL("../../../boat-image/workspace.service", import.meta.url),
      "utf8",
    );
    expect(unit).toContain("ExecStart=/bin/false");
    expect(unit).toContain("NotifyAccess=none");
    expect(unit).not.toContain("[Install]");
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
        socat: Buffer.from("socat"),
        relay: Buffer.from("relay"),
      }),
    ).toMatchObject({ ok: false, error: { code: "native-runtime-provenance-mismatch" } });
  });
});
