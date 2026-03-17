import { z } from "zod";

export const workspaceBlueprintVersion = "1" as const;

export const workspaceSourceProviderSchema = z.enum(["github", "gitlab", "generic"]);
export const workspaceHarnessIdSchema = z.enum(["opencode", "codex", "claude-code"]);
export const workspaceInputPurposeSchema = z.enum(["config", "dotfiles", "bootstrap"]);
export const workspaceShellSchema = z.enum(["sh", "bash"]);
export const workspacePersistenceSchema = z.enum(["ephemeral", "persistent"]);
export const workspaceTargetOsFamilySchema = z.enum(["auto", "nix", "fedora", "arch"]);
export const workspaceTargetOsModeSchema = z.enum(["prefer", "require"]);

const nonEmptyStringSchema = z.string().trim().min(1);

export const workspaceGitSourceSchema = z.strictObject({
  kind: z.literal("git").default("git"),
  provider: workspaceSourceProviderSchema.default("generic"),
  url: z.string().url(),
  ref: nonEmptyStringSchema.default("main"),
});

export const workspaceInputSourceSchema = z.strictObject({
  id: nonEmptyStringSchema,
  kind: z.literal("git").default("git"),
  purpose: workspaceInputPurposeSchema,
  provider: workspaceSourceProviderSchema.default("github"),
  url: z.string().url(),
  ref: nonEmptyStringSchema.default("main"),
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
  .default({});

export const workspaceAccessSchema = z
  .strictObject({
    ssh: workspaceSshAccessSchema.default({}),
  })
  .default({});

export const workspacePackageRequestSchema = z.strictObject({
  id: nonEmptyStringSchema,
  version: nonEmptyStringSchema.optional(),
});

export const workspaceToolingSchema = z
  .strictObject({
    packages: z.array(workspacePackageRequestSchema).default([]),
  })
  .default({});

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
  .default({ kind: "command", run: "echo 'Hello World!'" });

export const workspaceLifecycleSchema = z
  .strictObject({
    setup: z.array(workspaceCommandStepSchema).default([]),
    startup: z
      .strictObject({
        steps: z.array(workspaceCommandStepSchema).default([]),
        foreground: workspaceStartupForegroundSchema.default({ kind: "harness" }),
      })
      .default({}),
  })
  .default({});

export const workspaceRuntimeNetworkSchema = z
  .strictObject({
    outbound: z.boolean().default(true),
  })
  .default({});

export const workspaceRuntimeSchema = z
  .strictObject({
    env: z.record(z.string()).default({}),
    workspaceRoot: nonEmptyStringSchema.default("/workspace"),
    workingDirectory: nonEmptyStringSchema.default("/workspace/repo"),
    persistence: workspacePersistenceSchema.default("ephemeral"),
    network: workspaceRuntimeNetworkSchema.default({}),
  })
  .default({});

export const workspaceTargetOsSchema = z
  .strictObject({
    family: workspaceTargetOsFamilySchema.default("auto"),
    mode: workspaceTargetOsModeSchema.default("prefer"),
  })
  .default({});

export const workspaceTargetSchema = z
  .strictObject({
    os: workspaceTargetOsSchema.default({}),
  })
  .default({});

export const workspaceBlueprintSchema = z.strictObject({
  version: z.literal(workspaceBlueprintVersion).default(workspaceBlueprintVersion),
  sources: z.strictObject({
    workspace: workspaceGitSourceSchema,
    inputs: z.array(workspaceInputSourceSchema).default([]),
  }),
  harness: workspaceHarnessSchema,
  access: workspaceAccessSchema.default({}),
  tooling: workspaceToolingSchema.default({}),
  lifecycle: workspaceLifecycleSchema.default({}),
  runtime: workspaceRuntimeSchema.default({}),
  target: workspaceTargetSchema.default({}),
});

export type WorkspaceBlueprint = z.infer<typeof workspaceBlueprintSchema>;

export const parseWorkspaceBlueprint = (input: unknown): WorkspaceBlueprint =>
  workspaceBlueprintSchema.parse(input);
