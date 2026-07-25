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
    installPackages: ["nodejs"],
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
