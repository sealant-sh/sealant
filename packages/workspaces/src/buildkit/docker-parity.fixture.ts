import type { NewWorkspace } from "@sealant/validators";

/** Baseline workspace inputs for the Docker serialization parity matrix. */
export const createWorkspaceBuildSpec = (overrides: Partial<NewWorkspace> = {}): NewWorkspace => {
  const base: NewWorkspace = {
    version: "1",
    sources: {
      workspace: {
        kind: "git",
        provider: "generic",
        url: "https://github.com/example/repo.git",
        ref: "main",
      },
      inputs: [],
      mounts: [],
    },
    harness: {
      id: "opencode",
    },
    access: {
      ssh: {
        enabled: false,
        listenPort: 2222,
      },
    },
    tooling: {
      packages: [],
    },
    customization: {
      defaultShell: "bash",
      dotfilesManager: "auto",
      dotfilesTarget: "home",
      applyDotfiles: true,
      dotfilesBootstrap: true,
    },
    lifecycle: {
      setup: [],
      startup: {
        steps: [],
        foreground: {
          kind: "harness",
        },
      },
    },
    runtime: {
      env: {},
      userEnv: {},
      credentialRefs: [],
      dotfilesArchives: [],
      workspaceRoot: "/workspace",
      workingDirectory: "/workspace/repo",
      persistence: "ephemeral",
      envFrom: [],
      kubernetes: {},
      ociRuntime: "runc",
      network: {
        outbound: true,
        cloudMetadata: false,
      },
    },
    target: {
      os: {
        family: "fedora",
        mode: "prefer",
      },
      runtime: {
        family: "auto",
        mode: "prefer",
      },
    },
  };

  return {
    ...base,
    ...overrides,
    sources: {
      ...base.sources,
      ...overrides.sources,
      workspace: {
        ...base.sources.workspace,
        ...overrides.sources?.workspace,
      },
      inputs: overrides.sources?.inputs ?? base.sources.inputs,
    },
    harness: {
      ...base.harness,
      ...overrides.harness,
    },
    access: {
      ...base.access,
      ...overrides.access,
      ssh: {
        ...base.access.ssh,
        ...overrides.access?.ssh,
      },
    },
    tooling: {
      ...base.tooling,
      ...overrides.tooling,
      packages: overrides.tooling?.packages ?? base.tooling.packages,
    },
    customization: {
      ...base.customization,
      ...overrides.customization,
    },
    lifecycle: {
      ...base.lifecycle,
      ...overrides.lifecycle,
      setup: overrides.lifecycle?.setup ?? base.lifecycle.setup,
      startup: {
        ...base.lifecycle.startup,
        ...overrides.lifecycle?.startup,
        steps: overrides.lifecycle?.startup?.steps ?? base.lifecycle.startup.steps,
        foreground: overrides.lifecycle?.startup?.foreground ?? base.lifecycle.startup.foreground,
      },
    },
    runtime: {
      ...base.runtime,
      ...overrides.runtime,
      env: {
        ...base.runtime.env,
        ...overrides.runtime?.env,
      },
      network: {
        ...base.runtime.network,
        ...overrides.runtime?.network,
      },
    },
    target: {
      ...base.target,
      ...overrides.target,
      os: {
        ...base.target.os,
        ...overrides.target?.os,
      },
      runtime: {
        ...base.target.runtime,
        ...overrides.target?.runtime,
      },
    },
  };
};
