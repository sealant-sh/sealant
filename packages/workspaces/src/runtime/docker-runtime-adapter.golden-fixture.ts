/**
 * Launch inputs shared by the Docker golden test and the mount-intent cross-check. Three shapes
 * cover the adapter's argv surface: a git-sourced launch with every env channel populated, a
 * Mend-style mount-sourced launch with launch material + extra mounts + the control-socket fast
 * path, and a launch with the DinD sidecar enabled.
 */
import { parseRuntimeAdapterLaunchInput } from "./runtime-adapter.js";

export const baseBlueprint = (overrides: Record<string, unknown> = {}) => ({
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
  harness: { id: "opencode" },
  access: { ssh: { enabled: false, listenPort: 2222 } },
  tooling: { packages: [] },
  customization: {
    defaultShell: "bash",
    dotfilesManager: "auto",
    dotfilesTarget: "home",
    applyDotfiles: true,
    dotfilesBootstrap: true,
  },
  lifecycle: { setup: [], startup: { steps: [], foreground: { kind: "harness" } } },
  runtime: {
    env: {},
    workspaceRoot: "/workspace",
    workingDirectory: "/workspace/repo",
    persistence: "ephemeral",
    ociRuntime: "runc",
    network: { outbound: true },
  },
  target: { runtime: { family: "auto", mode: "prefer" }, os: { family: "auto", mode: "prefer" } },
  ...overrides,
});

export const publishedImage = {
  repository: "sealant/workspaces/demo",
  tag: "opencode",
  reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
  digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
  digest: "sha256:test",
};

export const cases = {
  gitSource: parseRuntimeAdapterLaunchInput({
    blueprint: baseBlueprint({
      runtime: {
        env: { NODE_ENV: "development" },
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace/repo",
        persistence: "ephemeral",
        ociRuntime: "runc",
        network: { outbound: true },
      },
    }),
    publishedImage,
    runId: "run-golden-1",
    workspaceCloneAuth: { type: "http-token", username: "x-access-token", token: "ghs_secret" },
    platformEnv: { SEALANT_DOTFILES_HTTP_TOKEN: "dot_secret" },
    credentialEnv: { GITHUB_TOKEN: "gh_secret", CLAUDE_CODE_OAUTH_TOKEN: "cc_secret" },
  }),
  mendMount: parseRuntimeAdapterLaunchInput({
    blueprint: baseBlueprint({
      sources: {
        workspace: { kind: "mount", hostPath: "/var/lib/mend/store/acme/worktrees/session-1" },
        inputs: [],
        mounts: [
          {
            hostPath: "/var/lib/mend/store/acme/repo.git",
            mountPath: "/var/lib/mend/store/acme/repo.git",
            readOnly: false,
          },
          {
            hostPath: "/var/lib/mend/store/_references/lib",
            mountPath: "/workspace/ref/lib",
            readOnly: true,
          },
          { hostPath: "/var/lib/mend/store/_run/sessions/1", mountPath: "/run/mend" },
        ],
      },
      runtime: {
        env: { MEND_SESSION_ID: "1" },
        userEnv: { EDITOR: "vim" },
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace/repo",
        persistence: "ephemeral",
        ociRuntime: "runsc",
        network: { outbound: true },
      },
      harness: { id: "claude-code" },
    }),
    publishedImage,
    runId: "run-golden-2",
    dotfilesArchiveDir: "/run/sealant/sockets/_dotfiles/sealant-dotfiles-run-golden-2",
    secretEnvDir: "/run/sealant/sockets/_dotfiles/sealant-secret-env-run-golden-2",
  }),
  dind: parseRuntimeAdapterLaunchInput({
    blueprint: baseBlueprint({
      tooling: { packages: [], services: { docker: { enabled: true } } },
    }),
    publishedImage,
    runId: "run-golden-3",
  }),
};
