import { z } from "zod";

export const sandboxBlueprintVersion = "1" as const;

export const sandboxSourceProviderSchema = z.enum(["github", "gitlab", "generic"]);

export const sandboxHarnessIdSchema = z.enum(["opencode", "codex", "claude-code"]);

export const sandboxInputPurposeSchema = z.enum(["config", "dotfiles", "bootstrap"]);

export const sandboxShellSchema = z.enum(["sh", "bash"]);

export const sandboxLoginShellSchema = z.enum(["bash", "zsh", "fish"]);

export const sandboxDotfilesManagerSchema = z.enum(["auto", "chezmoi", "stow", "copy"]);

export const sandboxDotfilesTargetSchema = z.enum(["home", "config"]);

export const sandboxPersistenceSchema = z.enum(["ephemeral", "persistent"]);
export const sandboxOciRuntimeSchema = z.enum(["runc", "runsc"]);

export const sandboxTargetOsFamilySchema = z.enum(["auto", "nix", "fedora", "arch"]);
export const sandboxTargetOsModeSchema = z.enum(["prefer", "require"]);
export const sandboxTargetRuntimeFamilySchema = z.enum(["auto", "docker", "k8s", "k3s"]);
export const sandboxTargetRuntimeModeSchema = z.enum(["prefer", "require"]);

const nonEmptyStringSchema = z.string().trim().min(1);

export const sandboxGitSourceSchema = z.strictObject({
  kind: z.literal("git").default("git"),
  provider: sandboxSourceProviderSchema.default("generic"),
  url: z.string().url(),
  ref: nonEmptyStringSchema.default("main"),
  authRef: nonEmptyStringSchema.optional(),
});

export const sandboxInputSourceSchema = z.strictObject({
  id: nonEmptyStringSchema,
  kind: z.literal("git").default("git"),
  purpose: sandboxInputPurposeSchema,
  provider: sandboxSourceProviderSchema.default("generic"),
  url: z.string().url(),
  ref: nonEmptyStringSchema.default("main"),
  authRef: nonEmptyStringSchema.optional(),
  mountPath: nonEmptyStringSchema.optional(),
});

export const sandboxHarnessSchema = z.strictObject({
  id: sandboxHarnessIdSchema,
  profile: nonEmptyStringSchema.optional(),
});

export const sandboxSshAccessSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    listenPort: z.number().int().min(1).max(65535).default(2222),
    authorizedKeysRef: nonEmptyStringSchema.optional(),
  })
  .default({});

export const sandboxAccessSchema = z
  .strictObject({
    ssh: sandboxSshAccessSchema.default({}),
  })
  .default({});

export const sandboxPackageRequestSchema = z.strictObject({
  id: nonEmptyStringSchema,
  version: nonEmptyStringSchema.optional(),
});

export const sandboxToolingSchema = z
  .strictObject({
    packages: z.array(sandboxPackageRequestSchema).default([]),
  })
  .default({});

export const sandboxCustomizationSchema = z
  .strictObject({
    defaultShell: sandboxLoginShellSchema.default("bash"),
    dotfilesManager: sandboxDotfilesManagerSchema.default("auto"),
    dotfilesTarget: sandboxDotfilesTargetSchema.default("home"),
    applyDotfiles: z.boolean().default(true),
    dotfilesBootstrap: z.boolean().default(true),
    dotfilesBootstrapCommand: nonEmptyStringSchema.optional(),
  })
  .default({});

export const sandboxCommandStepSchema = z.strictObject({
  id: nonEmptyStringSchema.optional(),
  run: nonEmptyStringSchema,
  shell: sandboxShellSchema.default("bash"),
  workingDirectory: nonEmptyStringSchema.optional(),
});

export const sandboxStartupForegroundSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("harness"),
    }),
    z.strictObject({
      kind: z.literal("command"),
      run: nonEmptyStringSchema,
      shell: sandboxShellSchema.default("bash"),
      workingDirectory: nonEmptyStringSchema.optional(),
    }),
  ])
  .default({ kind: "harness" });

export const sandboxLifecycleSchema = z
  .strictObject({
    setup: z.array(sandboxCommandStepSchema).default([]),
    startup: z
      .strictObject({
        steps: z.array(sandboxCommandStepSchema).default([]),
        foreground: sandboxStartupForegroundSchema.default({ kind: "harness" }),
      })
      .default({}),
  })
  .default({});

export const sandboxSpecNetworkSchema = z
  .strictObject({
    outbound: z.boolean().default(true),
  })
  .default({});

export const sandboxSpecRuntimeSchema = z
  .strictObject({
    env: z.record(z.string()).default({}),
    sandboxRoot: nonEmptyStringSchema.default("/sandbox"),
    workingDirectory: nonEmptyStringSchema.default("/sandbox/repo"),
    persistence: sandboxPersistenceSchema.default("ephemeral"),
    ociRuntime: sandboxOciRuntimeSchema.default("runc"),
    network: sandboxSpecNetworkSchema.default({}),
  })
  .default({});

export const sandboxTargetOsSchema = z
  .strictObject({
    family: sandboxTargetOsFamilySchema.default("auto"),
    mode: sandboxTargetOsModeSchema.default("prefer"),
  })
  .default({});

export const sandboxTargetRuntimeSchema = z
  .strictObject({
    family: sandboxTargetRuntimeFamilySchema.default("auto"),
    mode: sandboxTargetRuntimeModeSchema.default("prefer"),
  })
  .default({});

export const sandboxTargetSchema = z
  .strictObject({
    os: sandboxTargetOsSchema.default({}),
    runtime: sandboxTargetRuntimeSchema.default({}),
  })
  .default({});

export const sandboxBlueprintSchema = z.strictObject({
  version: z.literal(sandboxBlueprintVersion).default(sandboxBlueprintVersion),
  sources: z.strictObject({
    sandbox: sandboxGitSourceSchema,
    inputs: z.array(sandboxInputSourceSchema).default([]),
  }),
  harness: sandboxHarnessSchema,
  access: sandboxAccessSchema.default({}),
  tooling: sandboxToolingSchema.default({}),
  customization: sandboxCustomizationSchema.default({}),
  lifecycle: sandboxLifecycleSchema.default({}),
  runtime: sandboxSpecRuntimeSchema.default({}),
  target: sandboxTargetSchema.default({}),
});

export type SandboxBlueprint = z.infer<typeof sandboxBlueprintSchema>;

export const parseSandboxBlueprint = (input: unknown): SandboxBlueprint => {
  return sandboxBlueprintSchema.parse(input);
};
