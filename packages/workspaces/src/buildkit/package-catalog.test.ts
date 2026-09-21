import { describe, expect, it } from "vitest";

import { cases } from "../runtime/docker-runtime-adapter.golden-fixture.js";
import { planWorkspaceImageBuild } from "./index.js";
import {
  CATALOG_OS_FAMILIES,
  knownWorkspacePackageIds,
  renderReleaseInstall,
  unknownWorkspacePackageIds,
  WORKSPACE_PACKAGE_CATALOG,
} from "./package-catalog.js";

/** Mend's default workspace package list (packages/domain/src/settings.ts), 2026-09-21. */
const MEND_DEFAULTS = [
  "pnpm",
  "python",
  "uv",
  "mise",
  "github-cli",
  "lazygit",
  "bat",
  "curl",
  "jq",
  "ripgrep",
  "fd",
  "fzf",
];

const containerfileFor = (family: "fedora" | "arch" | "ubuntu" | "nix", packages: string[]) =>
  planWorkspaceImageBuild({
    blueprint: {
      ...cases.gitSource.blueprint,
      target: { ...cases.gitSource.blueprint.target, os: { family, mode: "require" } },
      tooling: { ...cases.gitSource.blueprint.tooling, packages: packages.map((id) => ({ id })) },
    },
  }).containerfile;

describe("the workspace package catalog", () => {
  it("answers every id on every managed family, by a repository package, a pinned release or npm", () => {
    for (const [id, entry] of Object.entries(WORKSPACE_PACKAGE_CATALOG)) {
      for (const family of CATALOG_OS_FAMILIES) {
        const install = entry[family];
        const ways = [install.packages?.length, install.release, install.npmGlobal?.length].filter(
          Boolean,
        );
        expect(ways.length, `${id} on ${family} installs nothing`).toBeGreaterThan(0);
      }
    }
  });

  it("covers Mend's default list and what the harnesses and dotfiles request", () => {
    const known = new Set(knownWorkspacePackageIds());
    for (const id of [...MEND_DEFAULTS, "nodejs", "bubblewrap", "git", "chezmoi", "stow", "tar"]) {
      expect(known.has(id), id).toBe(true);
    }
    expect(unknownWorkspacePackageIds(["mise", "nope", "mise", "also-nope"])).toEqual([
      "nope",
      "also-nope",
    ]);
  });

  it("plans Mend's default list on every managed family", () => {
    for (const family of CATALOG_OS_FAMILIES) {
      const containerfile = containerfileFor(family, MEND_DEFAULTS);
      // The GitHub CLI under each family's own name.
      expect(containerfile).toMatch(family === "arch" ? /github-cli/ : /\bgh\b/);
      // fzf and ripgrep are repository packages everywhere.
      expect(containerfile).toContain("fzf");
      expect(containerfile).toContain("ripgrep");
    }
  });

  it("refuses an id it does not know when the image is planned, naming it", () => {
    expect(() => containerfileFor("fedora", ["ripgrep", "nope"])).toThrow(
      /Unknown workspace package 'nope'/,
    );
  });

  it("installs a pinned release where a family's repositories have no package", () => {
    const fedora = containerfileFor("fedora", ["mise", "lazygit"]);
    expect(fedora).toContain("mise 2026.9.12");
    expect(fedora).toContain("lazygit 0.65.1");
    expect(fedora).toMatch(/dnf -y install .*\bcurl\b.*\btar\b/);
    // Arch packages lazygit but not mise on ARM: mise is the release, lazygit the repository.
    const arch = containerfileFor("arch", ["mise", "lazygit"]);
    expect(arch).toContain("mise 2026.9.12");
    expect(arch).toMatch(/pacman -S .*\blazygit\b/);
    expect(arch).not.toContain("lazygit 0.65.1");
    // Ubuntu: uv from its release, pnpm from npm, fd and bat linked under the asked-for names.
    const ubuntu = containerfileFor("ubuntu", ["uv", "pnpm", "fd", "bat"]);
    expect(ubuntu).toContain("uv 0.12.17");
    expect(ubuntu).toMatch(/RUN npm install -g '?pnpm'?/);
    expect(ubuntu).toContain("ln -sf /usr/bin/fdfind /usr/local/bin/fd");
    expect(ubuntu).toContain("ln -sf /usr/bin/batcat /usr/local/bin/bat");
    // nix has all of them as packages.
    const nix = containerfileFor("nix", MEND_DEFAULTS);
    expect(nix).not.toContain("pinned by checksum");
    expect(nix).toContain("nixpkgs#mise");
  });

  it("renders a release install that checks the checksum before unpacking, per architecture", () => {
    const step = renderReleaseInstall(WORKSPACE_PACKAGE_CATALOG.mise!.fedora.release!);
    expect(step).toContain(
      "x86_64) url='https://github.com/jdx/mise/releases/download/v2026.9.12/mise-v2026.9.12-linux-x64.tar.gz'; sha=b4058dece685259910d3aba5782445996eea79dbdb3cf952a6eb81aadf0373ff",
    );
    expect(step).toContain(
      "aarch64) url='https://github.com/jdx/mise/releases/download/v2026.9.12/mise-v2026.9.12-linux-arm64.tar.gz'; sha=e4a0921da0a76ce4666832d5b57b6f0eb9f22d149ba92845ebae4c38638c6775",
    );
    expect(step.indexOf("sha256sum -c")).toBeLessThan(step.indexOf("tar -xzf"));
    expect(step).toContain('*) echo "mise: no release for $(uname -m)" >&2; exit 1;;');
    expect(step).toContain('install -m 0755 "$d/$m" "/usr/local/bin/$(basename "$m")"');
  });
});
