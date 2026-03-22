import { z } from "zod";

// Versioning lets the composition layer evolve this contract safely over time.
// Without it, callers and executors would have to guess which shape they are
// interpreting whenever the blueprint grows new fields.
export const workspaceBlueprintVersion = "1" as const;

// Providers are kept symbolic in the blueprint so provider-specific behavior
// such as ref resolution or access flows can happen elsewhere without leaking
// GitHub- or GitLab-specific logic into every consumer.
export const workspaceSourceProviderSchema = z.enum(["github", "gitlab", "generic"]);

// The harness is a first-class product choice. Keeping it explicit in the
// blueprint means executor selection can validate support without re-parsing UI
// intent or inferring it from ad hoc commands.
export const workspaceHarnessIdSchema = z.enum(["opencode", "codex", "claude-code"]);

// A workspace can depend on more than the primary repo. These purposes let the
// blueprint carry extra repos such as dotfiles or config in a structured way so
// OS backends know why each source exists.
export const workspaceInputPurposeSchema = z.enum(["config", "dotfiles", "bootstrap"]);

// Lifecycle steps are limited to a small shell set so the contract stays easy to
// translate across backends instead of implicitly depending on one OS flavor.
export const workspaceShellSchema = z.enum(["sh", "bash"]);

// Login-shell customization is separate from command-step shells because users
// need environment-level control over the interactive shell regardless of how a
// particular lifecycle command executes.
export const workspaceLoginShellSchema = z.enum(["bash", "zsh", "fish"]);

// Persistence belongs in the shared blueprint because it is a user/runtime
// expectation, not an implementation detail of a specific executor.
export const workspacePersistenceSchema = z.enum(["ephemeral", "persistent"]);

// Target OS intent needs to exist before executor selection happens. The user is
// expressing what family they want while the composition layer remains free to
// choose the concrete backend implementation.
export const workspaceTargetOsFamilySchema = z.enum(["auto", "nix", "fedora", "arch"]);
export const workspaceTargetOsModeSchema = z.enum(["prefer", "require"]);
export const workspaceTargetRuntimeFamilySchema = z.enum(["auto", "docker", "k8s", "k3s"]);
export const workspaceTargetRuntimeModeSchema = z.enum(["prefer", "require"]);

const nonEmptyStringSchema = z.string().trim().min(1);

// This object represents the main repository the workspace is built around. We
// keep it separate from secondary inputs because every executor needs a single,
// unambiguous working repo to clone and enter.
export const workspaceGitSourceSchema = z.strictObject({
  kind: z.literal("git").default("git"),
  provider: workspaceSourceProviderSchema.default("generic"),
  url: z.string().url(),
  ref: nonEmptyStringSchema.default("main"),
  authRef: nonEmptyStringSchema.optional(),
});

// Extra input sources let the blueprint capture config repos, dotfiles, and
// bootstrap material without forcing those concerns into the main workspace repo
// object. This keeps dependency-like inputs explicit and typed.
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

// Harness config is intentionally small. The blueprint only needs to preserve
// which interactive tool should anchor the session plus an optional profile; the
// executor can translate that into packages and commands later.
export const workspaceHarnessSchema = z.strictObject({
  id: workspaceHarnessIdSchema,
  profile: nonEmptyStringSchema.optional(),
});

// SSH lives under access because it is about connectivity into the environment,
// not application behavior inside it. Normalizing it here lets executors reject
// unsupported access modes early.
export const workspaceSshAccessSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    listenPort: z.number().int().min(1).max(65535).default(2222),
    authorizedKeysRef: nonEmptyStringSchema.optional(),
  })
  .default({});

// Access gets its own object so new connection modes can be added later without
// scattering transport-specific fields across unrelated sections.
export const workspaceAccessSchema = z
  .strictObject({
    ssh: workspaceSshAccessSchema.default({}),
  })
  .default({});

// Package requests stay symbolic at this layer because the blueprint should say
// what tooling the user wants, not how a given OS installs it.
export const workspacePackageRequestSchema = z.strictObject({
  id: nonEmptyStringSchema,
  version: nonEmptyStringSchema.optional(),
});

// Tooling is its own object because package requests are part of environment
// composition, not process startup. Executors need this information while they
// compile the workspace, before anything actually launches.
export const workspaceToolingSchema = z
  .strictObject({
    packages: z.array(workspacePackageRequestSchema).default([]),
  })
  .default({});

// Customization keeps shell and dotfile behavior explicit in the shared
// blueprint so all OS backends can target the same user-facing feature set.
export const workspaceCustomizationSchema = z
  .strictObject({
    defaultShell: workspaceLoginShellSchema.default("bash"),
    dotfilesManager: z.enum(["chezmoi"]).optional(),
    applyDotfiles: z.boolean().default(true),
  })
  .default({});

// A structured command step gives the blueprint enough information to preserve
// shell and working-directory intent across backends instead of hiding it in a
// raw string.
export const workspaceCommandStepSchema = z.strictObject({
  id: nonEmptyStringSchema.optional(),
  run: nonEmptyStringSchema,
  shell: workspaceShellSchema.default("bash"),
  workingDirectory: nonEmptyStringSchema.optional(),
});

// Startup foreground is split out because the workspace needs a clear, typed way
// to say either "enter the selected harness" or "run this command instead".
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

// Lifecycle is a dedicated object because setup work and startup behavior are
// important parts of workspace intent, but they are distinct from source,
// tooling, and runtime configuration.
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

// Network requirements are grouped so executors and later runtime adapters can
// reason about connectivity needs from one stable location.
export const workspaceRuntimeNetworkSchema = z
  .strictObject({
    outbound: z.boolean().default(true),
  })
  .default({});

// Runtime holds the baseline process and filesystem expectations that any OS
// backend needs to understand, while intentionally avoiding backend-specific
// deployment details such as container flags or cluster settings.
export const workspaceRuntimeSchema = z
  .strictObject({
    env: z.record(z.string()).default({}),
    workspaceRoot: nonEmptyStringSchema.default("/workspace"),
    workingDirectory: nonEmptyStringSchema.default("/workspace/repo"),
    persistence: workspacePersistenceSchema.default("ephemeral"),
    network: workspaceRuntimeNetworkSchema.default({}),
  })
  .default({});

// Target OS is separated from runtime because it is about choosing a compatible
// implementation path, not about the behavior of processes once the workspace is
// running.
export const workspaceTargetOsSchema = z
  .strictObject({
    family: workspaceTargetOsFamilySchema.default("auto"),
    mode: workspaceTargetOsModeSchema.default("prefer"),
  })
  .default({});

// Runtime target is separated from OS target because the same compiled artifact
// can often run on more than one backend. Keeping runtime intent explicit gives
// adapter selection one stable place to look.
export const workspaceTargetRuntimeSchema = z
  .strictObject({
    family: workspaceTargetRuntimeFamilySchema.default("auto"),
    mode: workspaceTargetRuntimeModeSchema.default("prefer"),
  })
  .default({});

// The top-level target object leaves room for future selection constraints while
// keeping OS preference grouped under a clear executor-selection namespace.
export const workspaceTargetSchema = z
  .strictObject({
    os: workspaceTargetOsSchema.default({}),
    runtime: workspaceTargetRuntimeSchema.default({}),
  })
  .default({});

// This is the normalized handoff contract between user-facing input and the OS
// executors. Each top-level object exists because it answers a different class
// of question that the composition layer must preserve across backends:
// - sources: where the workspace content comes from
// - harness: which AI tool anchors the session
// - access: how a user can connect to the environment
// - tooling: which symbolic packages the environment should contain
// - customization: which shell and dotfile behavior should be applied
// - lifecycle: what setup and startup behavior should run
// - runtime: baseline process, filesystem, and network expectations
// - target: which OS family the composition layer should aim for
export const workspaceBlueprintSchema = z.strictObject({
  version: z.literal(workspaceBlueprintVersion).default(workspaceBlueprintVersion),
  sources: z.strictObject({
    workspace: workspaceGitSourceSchema,
    inputs: z.array(workspaceInputSourceSchema).default([]),
  }),
  harness: workspaceHarnessSchema,
  access: workspaceAccessSchema.default({}),
  tooling: workspaceToolingSchema.default({}),
  customization: workspaceCustomizationSchema.default({}),
  lifecycle: workspaceLifecycleSchema.default({}),
  runtime: workspaceRuntimeSchema.default({}),
  target: workspaceTargetSchema.default({}),
});

export type WorkspaceBlueprint = z.infer<typeof workspaceBlueprintSchema>;

export const parseWorkspaceBlueprint = (input: unknown): WorkspaceBlueprint =>
  workspaceBlueprintSchema.parse(input);
