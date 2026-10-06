export type HarnessId = "opencode" | "codex" | "claude-code" | "pi";

/** The one-shot invocation for a prompt, resolved SERVER-SIDE (the single source of truth). */
export interface HarnessRunCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface HarnessIntegration {
  readonly id: HarnessId;
  readonly installPackages: readonly string[];
  readonly installCommand: string;
  readonly launchCommand: string;
  /**
   * Builds the one-shot headless invocation for a prompt. This is the invoke knowledge that used
   * to live client-side in the SDK's harness factories — held here so every surface (SDK with a
   * re-fetched handle, web app, API) shares one construction.
   */
  readonly buildRunCommand: (prompt: string) => HarnessRunCommand;
}

/**
 * The harness versions every workspace image installs. Pinned, not `@latest`: Docker caches a
 * harness layer by its text, so `@latest` installed whatever was current when some earlier layer
 * last changed. Adding two packages to the package layer (#327) upgraded the OS and moved claude
 * 2.1.287 → 2.1.291, codex 0.160.0 → 0.160.1 and pi 1.0.0 → 1.0.4 with it, unannounced, in the
 * middle of a benchmark. A pinned version changes only here, in a pull request of its own, and
 * changing one rebuilds only its own layer. How to bump: apps/docs/contents/concepts/harnesses.md.
 */
export const HARNESS_VERSIONS = {
  opencode: "1.18.34",
  codex: "0.160.1",
  "claude-code": "2.1.292",
  pi: "1.0.4",
} as const satisfies Record<HarnessId, string>;

/** pi's release for this machine, checked against the release's own SHA256SUMS. */
const PI_INSTALL_COMMAND = [
  "set -eu",
  'case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "pi: no release for $(uname -m)" >&2; exit 1 ;; esac',
  `release="https://github.com/earendil-works/pi/releases/download/v${HARNESS_VERSIONS.pi}"`,
  'tmp="$(mktemp -d)"',
  'curl -fsSL -o "$tmp/pi.tar.gz" "$release/pi-linux-$arch.tar.gz"',
  'curl -fsSL -o "$tmp/SHA256SUMS" "$release/SHA256SUMS"',
  'echo "$(awk -v f="pi-linux-$arch.tar.gz" \'$2 == f { print $1 }\' "$tmp/SHA256SUMS")  $tmp/pi.tar.gz" | sha256sum -c -',
  "rm -rf /opt/pi && mkdir -p /opt /usr/local/bin",
  'tar -xzf "$tmp/pi.tar.gz" -C /opt',
  "ln -sf /opt/pi/pi /usr/local/bin/pi",
  'rm -rf "$tmp"',
  "pi --version",
].join("; ");

const harnessIntegrations: Record<HarnessId, HarnessIntegration> = {
  opencode: {
    id: "opencode",
    installPackages: ["nodejs"],
    // --allow-scripts, as for claude-code below: opencode's postinstall is what fetches the native
    // binary for the platform, and a recent npm skips it unless allowed. Observed on Arch Linux
    // ARM on 2026-09-20: "opencode-ai's postinstall script was not run".
    installCommand: `npm install -g --allow-scripts=opencode-ai opencode-ai@${HARNESS_VERSIONS.opencode}`,
    launchCommand: "opencode",
    buildRunCommand: (prompt) => ({ executable: "opencode", args: ["run", prompt] }),
  },
  codex: {
    id: "codex",
    // bubblewrap: Codex's Linux sandbox wants a system `bwrap` and prints an amber "could not find
    // bubblewrap on PATH … using the bundled bubblewrap" banner on every launch without it. The
    // package is named `bubblewrap` on fedora, arch, ubuntu and nixpkgs alike, so no distro map.
    installPackages: ["nodejs", "bubblewrap"],
    installCommand: `npm install -g @openai/codex@${HARNESS_VERSIONS.codex}`,
    launchCommand: "codex",
    buildRunCommand: (prompt) => ({ executable: "codex", args: ["exec", prompt] }),
  },
  "claude-code": {
    id: "claude-code",
    installPackages: ["nodejs"],
    // --allow-scripts: recent npm blocks install scripts by default (supply-chain gate), and
    // claude-code's postinstall is what links the native binary — without it the launcher dies
    // with "claude native binary not installed". Older npm treats the unknown config as a warning.
    installCommand: `npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@${HARNESS_VERSIONS["claude-code"]}`,
    launchCommand: "claude",
    buildRunCommand: (prompt) => ({ executable: "claude", args: ["-p", prompt] }),
  },
  pi: {
    id: "pi",
    // pi ships a self-contained binary per platform with a SHA256SUMS beside it, so it needs no
    // node: the npm package wants node >= 22.19, newer than Ubuntu 24.04's (18). The binary needs
    // the files it ships with, so the tree goes to /opt/pi and only the command is linked.
    installPackages: ["curl", "tar", "ca-certificates"],
    installCommand: PI_INSTALL_COMMAND,
    launchCommand: "pi",
    buildRunCommand: (prompt) => ({ executable: "pi", args: ["-p", prompt] }),
  },
};

/**
 * The harness CLIs baked into EVERY workspace image. One image carries all
 * supported agents, so a workspace (or a shell inside one) can open any of
 * them against the same state — harness identity is a launch-time fact, not
 * an image fact. Every supported harness is baked: a session can switch to any of them, and a
 * standby or a shell workspace has them all.
 */
const bakedHarnessIds: readonly HarnessId[] = ["codex", "claude-code", "opencode", "pi"];

export const isBakedHarnessId = (id: string): boolean =>
  bakedHarnessIds.some((baked) => baked === id);

/**
 * The integrations an image build installs: the baked set, plus the
 * blueprint's own harness when it is not already baked (an opencode
 * blueprint still gets a working opencode).
 */
export const imageHarnessIntegrations = (
  primary: HarnessIntegration,
): readonly HarnessIntegration[] => {
  const baked = bakedHarnessIds.map((id) => harnessIntegrations[id]);
  return baked.some((integration) => integration.id === primary.id) ? baked : [...baked, primary];
};

const harnessIds = new Set<HarnessId>(Object.keys(harnessIntegrations) as HarnessId[]);

export const isHarnessId = (value: string): value is HarnessId => {
  return harnessIds.has(value as HarnessId);
};

export const listHarnessIntegrations = (): readonly HarnessIntegration[] => {
  return Object.values(harnessIntegrations);
};

export const getHarnessIntegration = (harnessId: string): HarnessIntegration | undefined => {
  if (!isHarnessId(harnessId)) {
    return undefined;
  }

  return harnessIntegrations[harnessId];
};
