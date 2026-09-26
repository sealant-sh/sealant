/**
 * The workspace package catalog: what each package id a blueprint may ask for means on each
 * managed OS family.
 *
 * A family's repositories are the first choice. Where a family has no package, or a repository
 * lags behind the architecture (Arch Linux ARM carries no `mise`), the entry names the project's
 * own release: a pinned version, one archive per architecture, and its SHA-256, checked before
 * anything is unpacked. Version and checksum move together, by pull request. Where a repository
 * package installs a binary under another name (`fdfind`, `batcat`), the entry links the name a
 * blueprint asked for.
 *
 * An id the catalog does not know is refused when the image is planned, and by the API when the
 * workspace is created, instead of being handed to the package manager to fail minutes into a
 * build. Measured on 2026-09-21: Fedora 41 has no `mise` or `lazygit` and calls the GitHub CLI
 * `gh`; Ubuntu 24.04 also lacks `uv` and `pnpm`; Arch Linux ARM lacks `mise`; nixpkgs has all.
 * Measured on 2026-09-26: neither Fedora 41 nor Ubuntu 24.04 has `starship` or
 * `zsh-history-substring-search`; Arch (x86_64 and ARM) and nixpkgs have both.
 *
 * A zsh plugin's `.zsh` file lands where its family puts it, which differs:
 *
 * - `zsh-autosuggestions`: Fedora and Ubuntu `/usr/share/zsh-autosuggestions/`, Arch
 *   `/usr/share/zsh/plugins/zsh-autosuggestions/`, nix
 *   `/root/.nix-profile/share/zsh-autosuggestions/`.
 * - `zsh-syntax-highlighting`: Fedora and Ubuntu `/usr/share/zsh-syntax-highlighting/`, Arch
 *   `/usr/share/zsh/plugins/zsh-syntax-highlighting/`, nix
 *   `/root/.nix-profile/share/zsh-syntax-highlighting/`.
 * - `zsh-history-substring-search`: Fedora and Ubuntu (the release)
 *   `/usr/local/share/zsh-history-substring-search/`, Arch
 *   `/usr/share/zsh/plugins/zsh-history-substring-search/`, nix
 *   `/root/.nix-profile/share/zsh-history-substring-search/`.
 */
import type { BuildkitTargetOsFamily } from "@sealant/validators";

export type CatalogOsFamily = Exclude<BuildkitTargetOsFamily, "custom">;
export const CATALOG_OS_FAMILIES: readonly CatalogOsFamily[] = ["fedora", "arch", "ubuntu", "nix"];

export type ReleaseArchitecture = "x86_64" | "aarch64";

/**
 * A pinned upstream release archive, one per architecture. Its members are binaries installed to
 * /usr/local/bin, or, for a shell plugin, files installed to the release's own directory.
 */
export interface ReleaseInstall {
  /** For the log and the error. */
  readonly name: string;
  readonly version: string;
  /** Download URL and SHA-256 of the `.tar.gz` for each architecture. */
  readonly archives: Readonly<Record<ReleaseArchitecture, { url: string; sha256: string }>>;
  /** Paths inside the archive to install, each to /usr/local/bin/<basename>. */
  readonly members: Readonly<Record<ReleaseArchitecture, readonly string[]>>;
  /**
   * Installs the members to <directory>/<basename> as plain files (0644) instead of to
   * /usr/local/bin as programs: a shell plugin is sourced, not run.
   */
  readonly directory?: string;
}

export interface FamilyInstall {
  /** Repository packages, in the family's own names. */
  readonly packages?: readonly string[];
  /** A pinned upstream release, where the repositories have none. */
  readonly release?: ReleaseInstall;
  /** npm packages installed globally, where a family has no repository package (needs nodejs). */
  readonly npmGlobal?: readonly string[];
  /** Shell lines after the install: a link from the name a blueprint asked for to the binary. */
  readonly postInstall?: readonly string[];
}

export type CatalogEntry = Readonly<Record<CatalogOsFamily, FamilyInstall>>;

const everywhere = (name: string, nix = name): CatalogEntry => ({
  fedora: { packages: [name] },
  arch: { packages: [name] },
  ubuntu: { packages: [name] },
  nix: { packages: [nix] },
});

const MISE_VERSION = "2026.9.12";
const mise: ReleaseInstall = {
  name: "mise",
  version: MISE_VERSION,
  archives: {
    x86_64: {
      url: `https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64.tar.gz`,
      sha256: "b4058dece685259910d3aba5782445996eea79dbdb3cf952a6eb81aadf0373ff",
    },
    aarch64: {
      url: `https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-arm64.tar.gz`,
      sha256: "e4a0921da0a76ce4666832d5b57b6f0eb9f22d149ba92845ebae4c38638c6775",
    },
  },
  members: { x86_64: ["mise/bin/mise"], aarch64: ["mise/bin/mise"] },
};

const LAZYGIT_VERSION = "0.65.1";
const lazygit: ReleaseInstall = {
  name: "lazygit",
  version: LAZYGIT_VERSION,
  archives: {
    x86_64: {
      url: `https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_linux_x86_64.tar.gz`,
      sha256: "02beacbcda0fa342e50ae3480ba8147307353af3fb28e1d5f790e02329c201a6",
    },
    aarch64: {
      url: `https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_linux_arm64.tar.gz`,
      sha256: "49abecdf6adf4f2dfdb11bf7b9bfada267ea523612ed809d1c6d87f6c04000a7",
    },
  },
  members: { x86_64: ["lazygit"], aarch64: ["lazygit"] },
};

const UV_VERSION = "0.12.17";
const uv: ReleaseInstall = {
  name: "uv",
  version: UV_VERSION,
  archives: {
    x86_64: {
      url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz`,
      sha256: "fa82fd8dde8e8eefdecada6aa0889666556cfceb690d06e0c3bca49eb3070a63",
    },
    aarch64: {
      url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-unknown-linux-gnu.tar.gz`,
      sha256: "d636d1b678e9e7f367ecb22b46bd1cabbed234d6bc3b4d96365d2b507f72f86c",
    },
  },
  members: {
    x86_64: ["uv-x86_64-unknown-linux-gnu/uv", "uv-x86_64-unknown-linux-gnu/uvx"],
    aarch64: ["uv-aarch64-unknown-linux-gnu/uv", "uv-aarch64-unknown-linux-gnu/uvx"],
  },
};

const STARSHIP_VERSION = "1.26.0";
const starship: ReleaseInstall = {
  name: "starship",
  version: STARSHIP_VERSION,
  archives: {
    x86_64: {
      url: `https://github.com/starship/starship/releases/download/v${STARSHIP_VERSION}/starship-x86_64-unknown-linux-musl.tar.gz`,
      sha256: "b7c232b0e8249d8e55a40beb79c5c43a7d370f3f9408bd215deb0170daeaadf3",
    },
    aarch64: {
      url: `https://github.com/starship/starship/releases/download/v${STARSHIP_VERSION}/starship-aarch64-unknown-linux-musl.tar.gz`,
      sha256: "dc30189378d2f2e287384e8a692d3f95ad1df64cf0e8c36aa9201516028aed6b",
    },
  },
  members: { x86_64: ["starship"], aarch64: ["starship"] },
};

// A zsh script, the same for every architecture: the archive GitHub serves for the release tag.
const ZSH_HISTORY_SUBSTRING_SEARCH_VERSION = "1.1.0";
const zshHistorySubstringSearchArchive = {
  url: `https://github.com/zsh-users/zsh-history-substring-search/archive/refs/tags/v${ZSH_HISTORY_SUBSTRING_SEARCH_VERSION}.tar.gz`,
  sha256: "9b52eca6c894dd98caa5f07160199f3f3179ff017575d5acc9fdc467b1ac70f8",
};
const zshHistorySubstringSearchMember = `zsh-history-substring-search-${ZSH_HISTORY_SUBSTRING_SEARCH_VERSION}/zsh-history-substring-search.zsh`;
const zshHistorySubstringSearch: ReleaseInstall = {
  name: "zsh-history-substring-search",
  version: ZSH_HISTORY_SUBSTRING_SEARCH_VERSION,
  archives: {
    x86_64: zshHistorySubstringSearchArchive,
    aarch64: zshHistorySubstringSearchArchive,
  },
  members: {
    x86_64: [zshHistorySubstringSearchMember],
    aarch64: [zshHistorySubstringSearchMember],
  },
  directory: "/usr/local/share/zsh-history-substring-search",
};

const fd: CatalogEntry = {
  fedora: { packages: ["fd-find"] },
  arch: { packages: ["fd"] },
  ubuntu: { packages: ["fd-find"], postInstall: ["ln -sf /usr/bin/fdfind /usr/local/bin/fd"] },
  nix: { packages: ["fd"] },
};

export const WORKSPACE_PACKAGE_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  bash: everywhere("bash"),
  // Codex's Linux sandbox wants a system `bwrap`; the harness integration requests it.
  bubblewrap: everywhere("bubblewrap"),
  bat: {
    fedora: { packages: ["bat"] },
    arch: { packages: ["bat"] },
    // Debian installs it as `batcat`, to leave the name to another package.
    ubuntu: { packages: ["bat"], postInstall: ["ln -sf /usr/bin/batcat /usr/local/bin/bat"] },
    nix: { packages: ["bat"] },
  },
  chezmoi: {
    fedora: { packages: ["chezmoi"] },
    arch: { packages: ["chezmoi"] },
    // Ubuntu has no package; the dotfiles step installs it with the upstream script over curl.
    ubuntu: { packages: ["curl", "ca-certificates"] },
    nix: { packages: ["chezmoi"] },
  },
  curl: everywhere("curl"),
  direnv: everywhere("direnv"),
  eza: everywhere("eza"),
  fd,
  // Debian's and Fedora's name for it, kept as an id since blueprints have used it.
  "fd-find": fd,
  fish: everywhere("fish"),
  fzf: everywhere("fzf"),
  git: everywhere("git", "gitMinimal"),
  htop: everywhere("htop"),
  "github-cli": {
    fedora: { packages: ["gh"] },
    arch: { packages: ["github-cli"] },
    ubuntu: { packages: ["gh"] },
    nix: { packages: ["gh"] },
  },
  jq: everywhere("jq"),
  lazygit: {
    fedora: { release: lazygit },
    arch: { packages: ["lazygit"] },
    ubuntu: { release: lazygit },
    nix: { packages: ["lazygit"] },
  },
  mise: {
    fedora: { release: mise },
    // Arch packages it on x86_64 and not on ARM; the release serves both.
    arch: { release: mise },
    ubuntu: { release: mise },
    nix: { packages: ["mise"] },
  },
  neovim: everywhere("neovim"),
  nodejs: {
    fedora: { packages: ["nodejs", "npm"] },
    arch: { packages: ["nodejs", "npm"] },
    ubuntu: { packages: ["nodejs", "npm"] },
    nix: { packages: ["nodejs"] },
  },
  pnpm: {
    fedora: { packages: ["nodejs", "npm", "pnpm"] },
    arch: { packages: ["nodejs", "npm", "pnpm"] },
    ubuntu: { packages: ["nodejs", "npm"], npmGlobal: ["pnpm"] },
    nix: { packages: ["nodejs", "pnpm"] },
  },
  python: {
    fedora: { packages: ["python3"] },
    arch: { packages: ["python"] },
    ubuntu: { packages: ["python3"] },
    nix: { packages: ["python3"] },
  },
  ripgrep: everywhere("ripgrep"),
  starship: {
    fedora: { release: starship },
    arch: { packages: ["starship"] },
    ubuntu: { release: starship },
    nix: { packages: ["starship"] },
  },
  stow: everywhere("stow"),
  tar: everywhere("tar", "gnutar"),
  tmux: everywhere("tmux"),
  uv: {
    fedora: { packages: ["uv"] },
    arch: { packages: ["uv"] },
    ubuntu: { release: uv },
    nix: { packages: ["uv"] },
  },
  zsh: everywhere("zsh"),
  "zsh-autosuggestions": everywhere("zsh-autosuggestions"),
  "zsh-history-substring-search": {
    fedora: { release: zshHistorySubstringSearch },
    arch: { packages: ["zsh-history-substring-search"] },
    ubuntu: { release: zshHistorySubstringSearch },
    nix: { packages: ["zsh-history-substring-search"] },
  },
  "zsh-syntax-highlighting": everywhere("zsh-syntax-highlighting"),
};

export const knownWorkspacePackageIds = (): readonly string[] =>
  Object.keys(WORKSPACE_PACKAGE_CATALOG).toSorted();

/** The ids a request names that the catalog does not know, in request order, once each. */
export const unknownWorkspacePackageIds = (ids: Iterable<string>): readonly string[] => [
  ...new Set([...ids].filter((id) => !Object.hasOwn(WORKSPACE_PACKAGE_CATALOG, id))),
];

export class UnknownWorkspacePackageError extends Error {
  readonly unknown: readonly string[];
  constructor(unknown: readonly string[]) {
    super(
      `Unknown workspace package${unknown.length === 1 ? "" : "s"} ${unknown.map((id) => `'${id}'`).join(", ")}. A managed OS family installs the catalog's packages only: ${knownWorkspacePackageIds().join(", ")}. A custom base image takes any name its own package manager knows.`,
    );
    this.name = "UnknownWorkspacePackageError";
    this.unknown = unknown;
  }
}

/** What the family's own repositories must provide for the release installs to run. */
export const RELEASE_INSTALL_PACKAGES: Readonly<Record<CatalogOsFamily, readonly string[]>> = {
  fedora: ["curl", "tar", "ca-certificates"],
  arch: ["curl", "tar"],
  ubuntu: ["curl", "tar", "ca-certificates"],
  nix: ["curl", "gnutar", "cacert"],
};

const shellSingleQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * One `RUN` per release: picks the archive for the machine's architecture, downloads it, checks
 * the SHA-256 against the pinned value, and installs the named members to /usr/local/bin (or the
 * release's own directory). Nothing is unpacked before the checksum matches, and a machine of
 * another architecture fails the step.
 */
export const renderReleaseInstall = (release: ReleaseInstall): string => {
  const branch = (arch: ReleaseArchitecture): string => {
    const archive = release.archives[arch];
    const members = release.members[arch];
    return `${arch}) url=${shellSingleQuote(archive.url)}; sha=${archive.sha256}; members=${shellSingleQuote(members.join(" "))};;`;
  };
  const installOne =
    release.directory === undefined
      ? `install -m 0755 "$d/$m" "/usr/local/bin/$(basename "$m")"`
      : `install -D -m 0644 "$d/$m" ${shellSingleQuote(release.directory)}"/$(basename "$m")"`;
  const installAll = `for m in $members; do ${installOne}; done`;
  return [
    `# ${release.name} ${release.version}: the project's own release, pinned by checksum, since the`,
    "# repositories of this family or this architecture have no package for it.",
    "RUN set -eu; \\",
    `    case "$(uname -m)" in ${branch("x86_64")} ${branch("aarch64")} *) echo "${release.name}: no release for $(uname -m)" >&2; exit 1;; esac; \\`,
    '    d="$(mktemp -d)"; \\',
    `    curl -fsSL --retry 3 -o "$d/archive.tar.gz" "$url"; \\`,
    '    echo "$sha  $d/archive.tar.gz" | sha256sum -c - >/dev/null; \\',
    '    tar -xzf "$d/archive.tar.gz" -C "$d"; \\',
    `    ${installAll}; \\`,
    '    rm -rf "$d"',
  ].join("\n");
};
