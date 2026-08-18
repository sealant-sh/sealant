export type HarnessId = "opencode" | "codex" | "claude-code";

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

const harnessIntegrations: Record<HarnessId, HarnessIntegration> = {
  opencode: {
    id: "opencode",
    installPackages: ["nodejs"],
    installCommand: "npm install -g opencode-ai@latest",
    launchCommand: "opencode",
    buildRunCommand: (prompt) => ({ executable: "opencode", args: ["run", prompt] }),
  },
  codex: {
    id: "codex",
    // bubblewrap: Codex's Linux sandbox wants a system `bwrap` and prints an amber "could not find
    // bubblewrap on PATH … using the bundled bubblewrap" banner on every launch without it. The
    // package is named `bubblewrap` on fedora, arch, ubuntu and nixpkgs alike, so no distro map.
    installPackages: ["nodejs", "bubblewrap"],
    installCommand: "npm install -g @openai/codex@latest",
    launchCommand: "codex",
    buildRunCommand: (prompt) => ({ executable: "codex", args: ["exec", prompt] }),
  },
  "claude-code": {
    id: "claude-code",
    installPackages: ["nodejs"],
    installCommand: "npm install -g @anthropic-ai/claude-code@latest",
    launchCommand: "claude",
    buildRunCommand: (prompt) => ({ executable: "claude", args: ["-p", prompt] }),
  },
};

/**
 * The harness CLIs baked into EVERY workspace image. One image carries all
 * supported agents, so a workspace (or a shell inside one) can open any of
 * them against the same state — harness identity is a launch-time fact, not
 * an image fact. Deliberately codex + claude-code for now.
 */
const bakedHarnessIds: readonly HarnessId[] = ["codex", "claude-code"];

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
