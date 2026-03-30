export type HarnessId = "opencode" | "codex" | "claude-code";

export interface HarnessIntegration {
  readonly id: HarnessId;
  readonly installPackages: readonly string[];
  readonly installCommand: string;
  readonly launchCommand: string;
}

const harnessIntegrations: Record<HarnessId, HarnessIntegration> = {
  opencode: {
    id: "opencode",
    installPackages: ["nodejs"],
    installCommand: "npm install -g opencode-ai@latest",
    launchCommand: "opencode",
  },
  codex: {
    id: "codex",
    installPackages: ["nodejs"],
    installCommand: "npm install -g @openai/codex@latest",
    launchCommand: "codex",
  },
  "claude-code": {
    id: "claude-code",
    installPackages: ["nodejs"],
    installCommand: "npm install -g @anthropic-ai/claude-code@latest",
    launchCommand: "claude",
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
