import { z } from "zod";

export const workspaceBlueprintVersion = "1" as const;

export const workspaceSourceProviderSchema = z.enum(["github", "gitlab", "generic"]);

export const workspaceHarnessIdSchema = z.enum(["opencode", "codex", "claude-code"]);

export const workspaceInputPurposeSchema = z.enum(["config", "dotfiles", "bootstrap"]);

export const workspaceShellSchema = z.enum(["sh", "bash"]);

export const workspaceLoginShellSchema = z.enum(["bash", "zsh", "fish"]);

export const workspaceDotfilesManagerSchema = z.enum(["auto", "chezmoi", "stow", "copy"]);

export const workspaceDotfilesTargetSchema = z.enum(["home", "config"]);

export const workspacePersistenceSchema = z.enum(["ephemeral", "persistent"]);
export const workspaceOciRuntimeSchema = z.enum(["runc", "runsc"]);

export const workspaceTargetOsFamilySchema = z.enum(["auto", "nix", "fedora", "arch"]);
export const workspaceTargetOsModeSchema = z.enum(["prefer", "require"]);
export const workspaceTargetRuntimeFamilySchema = z.enum(["auto", "docker", "k8s", "k3s"]);
export const workspaceTargetRuntimeModeSchema = z.enum(["prefer", "require"]);

const nonEmptyStringSchema = z.string().trim().min(1);

export const workspaceGitSourceSchema = z.strictObject({
  kind: z.literal("git").default("git"),
  provider: workspaceSourceProviderSchema.default("generic"),
  url: z.string().url(),
  // Absent means the remote's default branch — never assume `main`; sealantd clones HEAD.
  ref: nonEmptyStringSchema.optional(),
  authRef: nonEmptyStringSchema.optional(),
});

export const workspaceInputSourceSchema = z.strictObject({
  id: nonEmptyStringSchema,
  kind: z.literal("git").default("git"),
  purpose: workspaceInputPurposeSchema,
  provider: workspaceSourceProviderSchema.default("generic"),
  url: z.string().url(),
  ref: nonEmptyStringSchema.default("main"),
  authRef: nonEmptyStringSchema.optional(),
  mountPath: nonEmptyStringSchema.optional(),
});

export const workspaceHarnessSchema = z.strictObject({
  id: workspaceHarnessIdSchema,
  profile: nonEmptyStringSchema.optional(),
});

export const workspaceSshAccessSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    listenPort: z.number().int().min(1).max(65535).default(2222),
    authorizedKeysRef: nonEmptyStringSchema.optional(),
  })
  .prefault({});

export const workspaceAccessSchema = z
  .strictObject({
    ssh: workspaceSshAccessSchema.prefault({}),
  })
  .prefault({});

export const workspacePackageRequestSchema = z.strictObject({
  id: nonEmptyStringSchema,
  version: nonEmptyStringSchema.optional(),
});

export const workspaceToolingSchema = z
  .strictObject({
    packages: z.array(workspacePackageRequestSchema).default([]),
  })
  .prefault({});

export const workspaceCustomizationSchema = z
  .strictObject({
    defaultShell: workspaceLoginShellSchema.default("bash"),
    dotfilesManager: workspaceDotfilesManagerSchema.default("auto"),
    dotfilesTarget: workspaceDotfilesTargetSchema.default("home"),
    applyDotfiles: z.boolean().default(true),
    dotfilesBootstrap: z.boolean().default(true),
    dotfilesBootstrapCommand: nonEmptyStringSchema.optional(),
    // Bakes + launches the sealantd runtime daemon. Optional and defaults to disabled when absent,
    // so existing blueprints/callers stay source-compatible and the disabled build path renders
    // byte-identically to before.
    enableSealantd: z.boolean().optional(),
  })
  .prefault({});

export const workspaceCommandStepSchema = z.strictObject({
  id: nonEmptyStringSchema.optional(),
  run: nonEmptyStringSchema,
  shell: workspaceShellSchema.default("bash"),
  workingDirectory: nonEmptyStringSchema.optional(),
});

export const workspaceStartupForegroundSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("harness"),
    }),
    z.strictObject({
      kind: z.literal("command"),
      run: nonEmptyStringSchema,
      shell: workspaceShellSchema.default("bash"),
      workingDirectory: nonEmptyStringSchema.optional(),
    }),
  ])
  .default({ kind: "harness" });

export const workspaceLifecycleSchema = z
  .strictObject({
    setup: z.array(workspaceCommandStepSchema).default([]),
    startup: z
      .strictObject({
        steps: z.array(workspaceCommandStepSchema).default([]),
        foreground: workspaceStartupForegroundSchema.default({ kind: "harness" }),
      })
      .prefault({}),
  })
  .prefault({});

export const workspaceSpecNetworkSchema = z
  .strictObject({
    outbound: z.boolean().default(true),
  })
  .prefault({});

export const workspaceCredentialProviderSchema = z.enum(["claude", "codex", "github"]);

// Opaque connected-account pointer (`connected-account:<id>`), resolved and decrypted by the
// worker just before launch. Blueprints never carry credential material itself.
export const workspaceCredentialRefSchema = z.strictObject({
  provider: workspaceCredentialProviderSchema,
  ref: nonEmptyStringSchema,
});

export const workspaceSpecRuntimeSchema = z
  .strictObject({
    env: z.record(z.string(), z.string()).default({}),
    credentialRefs: z.array(workspaceCredentialRefSchema).default([]),
    workspaceRoot: nonEmptyStringSchema.default("/workspace"),
    workingDirectory: nonEmptyStringSchema.default("/workspace/repo"),
    persistence: workspacePersistenceSchema.default("ephemeral"),
    ociRuntime: workspaceOciRuntimeSchema.default("runc"),
    network: workspaceSpecNetworkSchema.prefault({}),
  })
  .prefault({});

export const workspaceTargetOsSchema = z
  .strictObject({
    family: workspaceTargetOsFamilySchema.default("auto"),
    mode: workspaceTargetOsModeSchema.default("prefer"),
  })
  .prefault({});

export const workspaceTargetRuntimeSchema = z
  .strictObject({
    family: workspaceTargetRuntimeFamilySchema.default("auto"),
    mode: workspaceTargetRuntimeModeSchema.default("prefer"),
  })
  .prefault({});

export const workspaceTargetSchema = z
  .strictObject({
    os: workspaceTargetOsSchema.prefault({}),
    runtime: workspaceTargetRuntimeSchema.prefault({}),
  })
  .prefault({});

export const workspaceBlueprintSchema = z.strictObject({
  version: z.literal(workspaceBlueprintVersion).default(workspaceBlueprintVersion),
  sources: z.strictObject({
    workspace: workspaceGitSourceSchema,
    inputs: z.array(workspaceInputSourceSchema).default([]),
  }),
  harness: workspaceHarnessSchema,
  access: workspaceAccessSchema.prefault({}),
  tooling: workspaceToolingSchema.prefault({}),
  customization: workspaceCustomizationSchema.prefault({}),
  lifecycle: workspaceLifecycleSchema.prefault({}),
  runtime: workspaceSpecRuntimeSchema.prefault({}),
  target: workspaceTargetSchema.prefault({}),
});

export type WorkspaceBlueprint = z.infer<typeof workspaceBlueprintSchema>;

export const parseWorkspaceBlueprint = (input: unknown): WorkspaceBlueprint => {
  return workspaceBlueprintSchema.parse(input);
};
