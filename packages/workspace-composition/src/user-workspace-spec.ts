import { z } from "zod";

import {
  parseWorkspaceBlueprint,
  workspaceBlueprintVersion,
  workspaceDotfilesManagerSchema,
  workspaceDotfilesTargetSchema,
  workspaceHarnessIdSchema,
  workspaceInputPurposeSchema,
  workspaceLoginShellSchema,
  workspaceOciRuntimeSchema,
  workspacePersistenceSchema,
  workspaceShellSchema,
  workspaceSourceProviderSchema,
  workspaceTargetOsFamilySchema,
  workspaceTargetOsModeSchema,
  workspaceTargetRuntimeFamilySchema,
  workspaceTargetRuntimeModeSchema,
  type WorkspaceBlueprint,
} from "./blueprint.js";

const nonEmptyStringSchema = z.string().trim().min(1);

// The user-facing source reference is intentionally ergonomic. Product surfaces
// should be able to pass either a plain repo URL or a small object without
// having to construct the fully normalized blueprint shape up front.
const userWorkspaceSourceReferenceSchema = z.union([
  z.string().url(),
  z.strictObject({
    kind: z.literal("git").default("git"),
    provider: workspaceSourceProviderSchema.optional(),
    url: z.string().url(),
    ref: nonEmptyStringSchema.optional(),
    authRef: nonEmptyStringSchema.optional(),
  }),
]);

// Extra input sources stay separate from the main workspace source because they
// represent supporting material such as dotfiles or bootstrap repos. The raw
// user contract keeps them lightweight while still preserving purpose.
const userWorkspaceInputSourceSchema = z.strictObject({
  id: nonEmptyStringSchema.optional(),
  kind: z.literal("git").default("git"),
  purpose: workspaceInputPurposeSchema,
  provider: workspaceSourceProviderSchema.optional(),
  url: z.string().url(),
  ref: nonEmptyStringSchema.optional(),
  authRef: nonEmptyStringSchema.optional(),
  mountPath: nonEmptyStringSchema.optional(),
});

// Harness selection accepts either a shorthand string or a richer object so the
// API can stay easy to use while still leaving room for optional profile-level
// tuning.
const userWorkspaceHarnessSchema = z.union([
  workspaceHarnessIdSchema,
  z.strictObject({
    id: workspaceHarnessIdSchema,
    profile: nonEmptyStringSchema.optional(),
  }),
]);

// SSH is modeled as a shorthand-friendly union because this is one of the most
// common toggles a user will flip. A simple boolean should work, but we also
// need an object form for port and authorized-key references.
const userWorkspaceSshSchema = z.union([
  z.boolean(),
  z.strictObject({
    enabled: z.boolean().optional(),
    listenPort: z.number().int().min(1).max(65535).optional(),
    authorizedKeysRef: nonEmptyStringSchema.optional(),
  }),
]);

// Package requests mirror the design of other user-facing fields: accept the
// simple form most callers want, but preserve an object form for future version
// pinning or other package-level hints.
const userWorkspacePackageSchema = z.union([
  nonEmptyStringSchema,
  z.strictObject({
    id: nonEmptyStringSchema,
    version: nonEmptyStringSchema.optional(),
  }),
]);

// Setup and startup commands are allowed as raw strings because that is the most
// natural way for users to express shell work. We still support a structured
// form so shell and working-directory intent can be carried through when needed.
const userWorkspaceCommandStepSchema = z.union([
  nonEmptyStringSchema,
  z.strictObject({
    id: nonEmptyStringSchema.optional(),
    run: nonEmptyStringSchema,
    shell: workspaceShellSchema.optional(),
    workingDirectory: nonEmptyStringSchema.optional(),
  }),
]);

// Foreground startup behavior needs its own shorthand-friendly shape because a
// user may either want to launch directly into the chosen harness or override it
// with one explicit command.
const userWorkspaceStartupForegroundSchema = z.union([
  z.literal("harness"),
  nonEmptyStringSchema,
  z.strictObject({
    kind: z.literal("harness"),
  }),
  z.strictObject({
    kind: z.literal("command"),
    run: nonEmptyStringSchema,
    shell: workspaceShellSchema.optional(),
    workingDirectory: nonEmptyStringSchema.optional(),
  }),
]);

// Startup is flexible on purpose: some callers only want a foreground command,
// some want a list of preflight steps, and some want both. The normalizer turns
// these forms into one consistent lifecycle shape.
const userWorkspaceStartupSchema = z.union([
  nonEmptyStringSchema,
  z.array(userWorkspaceCommandStepSchema),
  z.strictObject({
    steps: z.array(userWorkspaceCommandStepSchema).optional(),
    foreground: userWorkspaceStartupForegroundSchema.optional(),
  }),
]);

// Runtime stays as a nested object even in the user spec because env, working
// directories, persistence, and network are conceptually one class of request:
// baseline execution requirements for the workspace once it is launched.
const userWorkspaceRuntimeSchema = z.strictObject({
  env: z.record(z.string()).optional(),
  workspaceRoot: nonEmptyStringSchema.optional(),
  workingDirectory: nonEmptyStringSchema.optional(),
  persistence: workspacePersistenceSchema.optional(),
  ociRuntime: workspaceOciRuntimeSchema.optional(),
  network: z
    .strictObject({
      outbound: z.boolean().optional(),
    })
    .optional(),
});

// User-facing customization keeps the most common sandbox-personalization knobs
// explicit without forcing the caller to encode shell or dotfiles behavior in
// ad hoc setup scripts.
const userWorkspaceCustomizationSchema = z.strictObject({
  defaultShell: workspaceLoginShellSchema.optional(),
  dotfilesManager: workspaceDotfilesManagerSchema.optional(),
  dotfilesTarget: workspaceDotfilesTargetSchema.optional(),
  applyDotfiles: z.boolean().optional(),
  dotfilesBootstrap: z.boolean().optional(),
  dotfilesBootstrapCommand: nonEmptyStringSchema.optional(),
});

// OS intent also supports shorthand because users usually think in terms like
// "use Fedora" rather than a structured executor-selection object. The richer
// object form still lets us carry preference vs requirement semantics.
const userWorkspaceTargetOsSchema = z.union([
  workspaceTargetOsFamilySchema,
  z.strictObject({
    family: workspaceTargetOsFamilySchema.optional(),
    mode: workspaceTargetOsModeSchema.optional(),
  }),
]);

// Runtime target is modeled separately from `runtime` because this value chooses
// where the workspace should run, not process-level env/fs/network behavior.
const userWorkspaceTargetRuntimeSchema = z.union([
  workspaceTargetRuntimeFamilySchema,
  z.strictObject({
    family: workspaceTargetRuntimeFamilySchema.optional(),
    mode: workspaceTargetRuntimeModeSchema.optional(),
  }),
]);

// This is the raw, user-facing contract that product surfaces submit before the
// composition layer produces a normalized blueprint. It deliberately supports
// aliases and ergonomic forms such as:
// - `source` or `repo` as shortcuts for the main workspace repo
// - `ssh: true` instead of a nested access object
// - `packages: ["pnpm"]` instead of structured package objects
// - `os: "fedora"` instead of a nested target object
// The normalizer resolves those into one canonical shape.
export const userWorkspaceSpecSchema = z
  .strictObject({
    version: z.literal(workspaceBlueprintVersion).optional(),
    source: userWorkspaceSourceReferenceSchema.optional(),
    repo: userWorkspaceSourceReferenceSchema.optional(),
    sources: z
      .strictObject({
        workspace: userWorkspaceSourceReferenceSchema.optional(),
        inputs: z.array(userWorkspaceInputSourceSchema).optional(),
      })
      .optional(),
    inputs: z.array(userWorkspaceInputSourceSchema).optional(),
    harness: userWorkspaceHarnessSchema,
    ssh: userWorkspaceSshSchema.optional(),
    access: z
      .strictObject({
        ssh: userWorkspaceSshSchema.optional(),
      })
      .optional(),
    packages: z.array(userWorkspacePackageSchema).optional(),
    tooling: z
      .strictObject({
        packages: z.array(userWorkspacePackageSchema).optional(),
      })
      .optional(),
    setup: z.array(userWorkspaceCommandStepSchema).optional(),
    startup: userWorkspaceStartupSchema.optional(),
    lifecycle: z
      .strictObject({
        setup: z.array(userWorkspaceCommandStepSchema).optional(),
        startup: userWorkspaceStartupSchema.optional(),
      })
      .optional(),
    env: z.record(z.string()).optional(),
    runtime: userWorkspaceRuntimeSchema.optional(),
    customization: userWorkspaceCustomizationSchema.optional(),
    os: userWorkspaceTargetOsSchema.optional(),
    target: z
      .strictObject({
        os: userWorkspaceTargetOsSchema.optional(),
        runtime: userWorkspaceTargetRuntimeSchema.optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    // The user spec is intentionally ergonomic, which means it has aliases.
    // These checks keep that ergonomics from becoming ambiguity by enforcing
    // that callers pick exactly one spelling for each concern.
    const workspaceSourceCount = [value.source, value.repo, value.sources?.workspace].filter(
      (candidate) => candidate !== undefined,
    ).length;

    if (workspaceSourceCount === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A workspace source is required via source, repo, or sources.workspace.",
        path: ["source"],
      });
    }

    if (workspaceSourceCount > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Use only one of source, repo, or sources.workspace.",
        path: ["source"],
      });
    }

    const conflictGroups: Array<{ message: string; values: Array<unknown>; path: Array<string> }> =
      [
        {
          message: "Use only one of inputs or sources.inputs.",
          values: [value.inputs, value.sources?.inputs],
          path: ["inputs"],
        },
        {
          message: "Use only one of ssh or access.ssh.",
          values: [value.ssh, value.access?.ssh],
          path: ["ssh"],
        },
        {
          message: "Use only one of packages or tooling.packages.",
          values: [value.packages, value.tooling?.packages],
          path: ["packages"],
        },
        {
          message: "Use only one of setup or lifecycle.setup.",
          values: [value.setup, value.lifecycle?.setup],
          path: ["setup"],
        },
        {
          message: "Use only one of startup or lifecycle.startup.",
          values: [value.startup, value.lifecycle?.startup],
          path: ["startup"],
        },
        {
          message: "Use only one of env or runtime.env.",
          values: [value.env, value.runtime?.env],
          path: ["env"],
        },
        {
          message: "Use only one of os or target.os.",
          values: [value.os, value.target?.os],
          path: ["os"],
        },
      ];

    for (const group of conflictGroups) {
      if (group.values.filter((candidate) => candidate !== undefined).length > 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: group.message,
          path: group.path,
        });
      }
    }
  });

export type UserWorkspaceSpec = z.infer<typeof userWorkspaceSpecSchema>;

type UserWorkspaceSourceReference = z.infer<typeof userWorkspaceSourceReferenceSchema>;
type UserWorkspaceInputSource = z.infer<typeof userWorkspaceInputSourceSchema>;
type UserWorkspacePackage = z.infer<typeof userWorkspacePackageSchema>;
type UserWorkspaceCommandStep = z.infer<typeof userWorkspaceCommandStepSchema>;
type UserWorkspaceStartup = z.infer<typeof userWorkspaceStartupSchema>;
type UserWorkspaceSsh = z.infer<typeof userWorkspaceSshSchema>;
type UserWorkspaceTargetOs = z.infer<typeof userWorkspaceTargetOsSchema>;
type UserWorkspaceTargetRuntime = z.infer<typeof userWorkspaceTargetRuntimeSchema>;

export const parseUserWorkspaceSpec = (input: unknown): UserWorkspaceSpec =>
  userWorkspaceSpecSchema.parse(input);

// Provider inference exists because users should not need to say "github" when
// they already gave us a GitHub URL. This keeps raw input terse while still
// giving the normalized blueprint a provider-aware shape.
const inferSourceProvider = (
  url: string,
  provider?: z.infer<typeof workspaceSourceProviderSchema>,
): z.infer<typeof workspaceSourceProviderSchema> => {
  if (provider !== undefined) {
    return provider;
  }

  const hostname = new URL(url).hostname.toLowerCase();

  if (hostname === "github.com" || hostname.endsWith(".github.com")) {
    return "github";
  }

  if (hostname === "gitlab.com" || hostname.endsWith(".gitlab.com")) {
    return "gitlab";
  }

  return "generic";
};

// The main workspace source is normalized separately because it is the anchor of
// the whole environment. Every executor expects one consistent object here even
// if the raw input came in as a plain string.
const normalizeWorkspaceSource = (
  source: UserWorkspaceSourceReference,
): WorkspaceBlueprint["sources"]["workspace"] => {
  if (typeof source === "string") {
    return {
      kind: "git",
      provider: inferSourceProvider(source),
      url: source,
      ref: "main",
    };
  }

  return {
    kind: "git",
    provider: inferSourceProvider(source.url, source.provider),
    url: source.url,
    ref: source.ref ?? "main",
    ...(source.authRef !== undefined ? { authRef: source.authRef } : {}),
  };
};

// Supporting input sources are normalized with generated ids when needed so the
// blueprint always has stable references for config, dotfiles, or bootstrap
// material even if the user omitted a custom identifier.
const normalizeInputSource = (
  input: UserWorkspaceInputSource,
  index: number,
): WorkspaceBlueprint["sources"]["inputs"][number] => {
  const id = input.id ?? `${input.purpose}-${index + 1}`;

  return {
    id,
    kind: "git",
    purpose: input.purpose,
    provider: inferSourceProvider(input.url, input.provider),
    url: input.url,
    ref: input.ref ?? "main",
    ...(input.authRef !== undefined ? { authRef: input.authRef } : {}),
    ...(input.mountPath !== undefined ? { mountPath: input.mountPath } : {}),
  };
};

// Harness normalization converts shorthand into the small explicit object the
// blueprint uses everywhere else.
const normalizeHarness = (harness: UserWorkspaceSpec["harness"]): WorkspaceBlueprint["harness"] => {
  if (typeof harness === "string") {
    return { id: harness };
  }

  return {
    id: harness.id,
    ...(harness.profile !== undefined ? { profile: harness.profile } : {}),
  };
};

// SSH normalization centralizes the rule that the presence of SSH-related config
// implies the user wants SSH enabled unless they explicitly disable it.
const normalizeSsh = (ssh: UserWorkspaceSsh | undefined): WorkspaceBlueprint["access"]["ssh"] => {
  if (typeof ssh === "boolean") {
    return {
      enabled: ssh,
      listenPort: 2222,
    };
  }

  const enabled =
    ssh?.enabled ?? (ssh?.listenPort !== undefined || ssh?.authorizedKeysRef !== undefined);

  return {
    enabled,
    listenPort: ssh?.listenPort ?? 2222,
    ...(ssh?.authorizedKeysRef !== undefined ? { authorizedKeysRef: ssh.authorizedKeysRef } : {}),
  };
};

// Package normalization keeps symbolic package intent intact while converting the
// raw shorthand forms into one consistent package-request object shape.
const normalizePackage = (
  pkg: UserWorkspacePackage,
): WorkspaceBlueprint["tooling"]["packages"][number] => {
  if (typeof pkg === "string") {
    return { id: pkg };
  }

  return {
    id: pkg.id,
    ...(pkg.version !== undefined ? { version: pkg.version } : {}),
  };
};

// Dedupe happens here because user-facing input should be forgiving; callers can
// repeat packages accidentally and still get a stable normalized blueprint.
const dedupePackages = (
  packages: Array<WorkspaceBlueprint["tooling"]["packages"][number]>,
): Array<WorkspaceBlueprint["tooling"]["packages"][number]> => {
  const seen = new Set<string>();

  return packages.filter((pkg) => {
    if (seen.has(pkg.id)) {
      return false;
    }

    seen.add(pkg.id);
    return true;
  });
};

// Command-step normalization is shared by both setup and startup so the same raw
// shorthand expands consistently no matter where command steps appear.
const normalizeCommandStep = (
  step: UserWorkspaceCommandStep,
): WorkspaceBlueprint["lifecycle"]["setup"][number] => {
  if (typeof step === "string") {
    return {
      run: step,
      shell: "bash",
    };
  }

  return {
    run: step.run,
    shell: step.shell ?? "bash",
    ...(step.id !== undefined ? { id: step.id } : {}),
    ...(step.workingDirectory !== undefined ? { workingDirectory: step.workingDirectory } : {}),
  };
};

// This helper keeps the lifecycle normalization code readable by turning a maybe
// array into a guaranteed list of normalized step objects.
const normalizeCommandSteps = (
  steps: Array<UserWorkspaceCommandStep> | undefined,
): WorkspaceBlueprint["lifecycle"]["setup"] => (steps ?? []).map(normalizeCommandStep);

// Foreground normalization is separated because startup has two conceptual paths:
// enter the selected harness, or replace it with one explicit foreground command.
const normalizeStartupForeground = (
  foreground: z.infer<typeof userWorkspaceStartupForegroundSchema> | undefined,
): WorkspaceBlueprint["lifecycle"]["startup"]["foreground"] => {
  if (foreground === undefined || foreground === "harness") {
    return { kind: "harness" };
  }

  if (typeof foreground === "string") {
    return {
      kind: "command",
      run: foreground,
      shell: "bash",
    };
  }

  if (foreground.kind === "harness") {
    return { kind: "harness" };
  }

  return {
    kind: "command",
    run: foreground.run,
    shell: foreground.shell ?? "bash",
    ...(foreground.workingDirectory !== undefined
      ? { workingDirectory: foreground.workingDirectory }
      : {}),
  };
};

// Startup normalization collects all the shorthand forms into one consistent
// object so executors never have to understand the user-facing aliases directly.
const normalizeStartup = (
  startup: UserWorkspaceStartup | undefined,
): WorkspaceBlueprint["lifecycle"]["startup"] => {
  if (startup === undefined) {
    return {
      steps: [],
      foreground: { kind: "harness" },
    };
  }

  if (typeof startup === "string") {
    return {
      steps: [],
      foreground: normalizeStartupForeground(startup),
    };
  }

  if (Array.isArray(startup)) {
    return {
      steps: normalizeCommandSteps(startup),
      foreground: { kind: "harness" },
    };
  }

  return {
    steps: normalizeCommandSteps(startup.steps),
    foreground: normalizeStartupForeground(startup.foreground),
  };
};

// Runtime normalization is where implicit defaults such as workspace paths are
// finalized. This ensures every executor sees the same resolved execution
// expectations even when the user provided only a partial runtime object.
const normalizeRuntime = (
  runtime: UserWorkspaceSpec["runtime"] | undefined,
  env: UserWorkspaceSpec["env"] | undefined,
): WorkspaceBlueprint["runtime"] => {
  const workspaceRoot = runtime?.workspaceRoot ?? "/workspace";

  return {
    env: runtime?.env ?? env ?? {},
    workspaceRoot,
    workingDirectory: runtime?.workingDirectory ?? `${workspaceRoot}/repo`,
    persistence: runtime?.persistence ?? "ephemeral",
    ociRuntime: runtime?.ociRuntime ?? "runc",
    network: {
      outbound: runtime?.network?.outbound ?? true,
    },
  };
};

const normalizeCustomization = (
  customization: UserWorkspaceSpec["customization"] | undefined,
): WorkspaceBlueprint["customization"] => {
  return {
    defaultShell: customization?.defaultShell ?? "bash",
    dotfilesManager: customization?.dotfilesManager ?? "auto",
    dotfilesTarget: customization?.dotfilesTarget ?? "home",
    applyDotfiles: customization?.applyDotfiles ?? true,
    dotfilesBootstrap: customization?.dotfilesBootstrap ?? true,
    ...(customization?.dotfilesBootstrapCommand !== undefined
      ? { dotfilesBootstrapCommand: customization.dotfilesBootstrapCommand }
      : {}),
  };
};

// Target OS normalization converts shorthand user intent into the explicit form
// executor selection logic expects.
const normalizeTargetOs = (
  os: UserWorkspaceTargetOs | undefined,
): WorkspaceBlueprint["target"]["os"] => {
  if (os === undefined) {
    return {
      family: "auto",
      mode: "prefer",
    };
  }

  if (typeof os === "string") {
    return {
      family: os,
      mode: "prefer",
    };
  }

  return {
    family: os.family ?? "auto",
    mode: os.mode ?? "prefer",
  };
};

// Runtime target normalization mirrors OS target shorthand handling so adapter
// selection receives one explicit shape.
const normalizeTargetRuntime = (
  runtime: UserWorkspaceTargetRuntime | undefined,
): WorkspaceBlueprint["target"]["runtime"] => {
  if (runtime === undefined) {
    return {
      family: "auto",
      mode: "prefer",
    };
  }

  if (typeof runtime === "string") {
    return {
      family: runtime,
      mode: "prefer",
    };
  }

  return {
    family: runtime.family ?? "auto",
    mode: runtime.mode ?? "prefer",
  };
};

// This is the full user-input to blueprint boundary. It exists so the rest of
// the system can rely on one strict internal contract while product surfaces
// keep a friendlier request shape.
export const normalizeUserWorkspaceSpec = (input: unknown): WorkspaceBlueprint => {
  const spec = parseUserWorkspaceSpec(input);

  const workspaceSource = spec.sources?.workspace ?? spec.source ?? spec.repo;
  const inputs = spec.sources?.inputs ?? spec.inputs ?? [];
  const packages = spec.tooling?.packages ?? spec.packages ?? [];
  const ssh = spec.access?.ssh ?? spec.ssh;
  const setup = spec.lifecycle?.setup ?? spec.setup;
  const startup = spec.lifecycle?.startup ?? spec.startup;
  const os = spec.target?.os ?? spec.os;
  const runtimeTarget = spec.target?.runtime;

  return parseWorkspaceBlueprint({
    version: workspaceBlueprintVersion,
    sources: {
      workspace: normalizeWorkspaceSource(workspaceSource!),
      inputs: inputs.map(normalizeInputSource),
    },
    harness: normalizeHarness(spec.harness),
    access: {
      ssh: normalizeSsh(ssh),
    },
    tooling: {
      packages: dedupePackages(packages.map(normalizePackage)),
    },
    customization: normalizeCustomization(spec.customization),
    lifecycle: {
      setup: normalizeCommandSteps(setup),
      startup: normalizeStartup(startup),
    },
    runtime: normalizeRuntime(spec.runtime, spec.env),
    target: {
      os: normalizeTargetOs(os),
      runtime: normalizeTargetRuntime(runtimeTarget),
    },
  });
};
