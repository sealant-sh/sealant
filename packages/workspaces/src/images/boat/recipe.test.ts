import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  nativeWorkspaceInstallation,
  planWorkspaceImageBuild,
} from "../../buildkit/buildkit-builder.js";
import { createWorkspaceBuildSpec } from "../../buildkit/docker-parity.fixture.js";
import { createNativeRecipe } from "./recipe.js";
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
      for (const cli of ["codex@", "claude-code@", "opencode-ai@", "pi-linux-"])
        expect(recipe.value.installScript).toContain(cli);
      expect(recipe.value.installScript).toContain("groupadd -g 40000 mend");
      expect(recipe.value.installScript).toContain("/etc/sealant/person-env");
      expect(recipe.value.installScript).not.toMatch(/sealantd.* boot/);
      expect(
        recipe.value.files.find((f) => f.path.endsWith("workspace.service"))?.bytes,
      ).toBeDefined();
      expect(recipe.value.installScript).not.toContain("systemctl enable");
    }
    expect(nativeWorkspaceInstallation(spec("auto")).family).toBe("ubuntu");
  });

  it("refuses unsupported families, workspace Docker, and unproven authenticated build staging", async () => {
    for (const family of ["arch", "fedora", "custom"] as const)
      expect(await createNativeRecipe(spec(family), serializationBundleFixture)).toMatchObject({
        ok: false,
        error: { code: "native-unsupported-os" },
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
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("TemporaryFileSystem=/run");
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
