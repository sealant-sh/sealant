import { z } from "zod";

import {
  parseWorkspaceBlueprint,
  workspaceBlueprintVersion,
  workspaceHarnessIdSchema,
  workspaceInputPurposeSchema,
  workspacePersistenceSchema,
  workspaceShellSchema,
  workspaceSourceProviderSchema,
  workspaceTargetOsFamilySchema,
  workspaceTargetOsModeSchema,
  type WorkspaceBlueprint,
} from "./blueprint.js";

const nonEmptyStringSchema = z.string().trim().min(1);

const userWorkspaceSourceReferenceSchema = z.union([
  z.string().url(),
  z.strictObject({
    kind: z.literal("git").default("git"),
    provider: workspaceSourceProviderSchema.optional(),
    url: z.string().url(),
    ref: nonEmptyStringSchema.optional(),
  }),
]);

const userWorkspaceInputSourceSchema = z.strictObject({
  id: nonEmptyStringSchema.optional(),
  kind: z.literal("git").default("git"),
  purpose: workspaceInputPurposeSchema,
  provider: workspaceSourceProviderSchema.optional(),
  url: z.string().url(),
  ref: nonEmptyStringSchema.optional(),
  mountPath: nonEmptyStringSchema.optional(),
});

const userWorkspaceHarnessSchema = z.union([
  workspaceHarnessIdSchema,
  z.strictObject({
    id: workspaceHarnessIdSchema,
    profile: nonEmptyStringSchema.optional(),
  }),
]);

const userWorkspaceSshSchema = z.union([
  z.boolean(),
  z.strictObject({
    enabled: z.boolean().optional(),
    listenPort: z.number().int().min(1).max(65535).optional(),
    authorizedKeysRef: nonEmptyStringSchema.optional(),
  }),
]);

const userWorkspacePackageSchema = z.union([
  nonEmptyStringSchema,
  z.strictObject({
    id: nonEmptyStringSchema,
    version: nonEmptyStringSchema.optional(),
  }),
]);

const userWorkspaceCommandStepSchema = z.union([
  nonEmptyStringSchema,
  z.strictObject({
    id: nonEmptyStringSchema.optional(),
    run: nonEmptyStringSchema,
    shell: workspaceShellSchema.optional(),
    workingDirectory: nonEmptyStringSchema.optional(),
  }),
]);

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

const userWorkspaceStartupSchema = z.union([
  nonEmptyStringSchema,
  z.array(userWorkspaceCommandStepSchema),
  z.strictObject({
    steps: z.array(userWorkspaceCommandStepSchema).optional(),
    foreground: userWorkspaceStartupForegroundSchema.optional(),
  }),
]);

const userWorkspaceRuntimeSchema = z.strictObject({
  env: z.record(z.string()).optional(),
  workspaceRoot: nonEmptyStringSchema.optional(),
  workingDirectory: nonEmptyStringSchema.optional(),
  persistence: workspacePersistenceSchema.optional(),
  network: z
    .strictObject({
      outbound: z.boolean().optional(),
    })
    .optional(),
});

const userWorkspaceTargetOsSchema = z.union([
  workspaceTargetOsFamilySchema,
  z.strictObject({
    family: workspaceTargetOsFamilySchema.optional(),
    mode: workspaceTargetOsModeSchema.optional(),
  }),
]);

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
    os: userWorkspaceTargetOsSchema.optional(),
    target: z
      .strictObject({
        os: userWorkspaceTargetOsSchema.optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
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

    const conflictGroups: Array<{ message: string; values: Array<unknown>; path: Array<string> }> = [
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

export const parseUserWorkspaceSpec = (input: unknown): UserWorkspaceSpec =>
  userWorkspaceSpecSchema.parse(input);

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
  };
};

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
    ...(input.mountPath !== undefined ? { mountPath: input.mountPath } : {}),
  };
};

const normalizeHarness = (
  harness: UserWorkspaceSpec["harness"],
): WorkspaceBlueprint["harness"] => {
  if (typeof harness === "string") {
    return { id: harness };
  }

  return {
    id: harness.id,
    ...(harness.profile !== undefined ? { profile: harness.profile } : {}),
  };
};

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

const normalizeCommandSteps = (
  steps: Array<UserWorkspaceCommandStep> | undefined,
): WorkspaceBlueprint["lifecycle"]["setup"] => (steps ?? []).map(normalizeCommandStep);

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
    network: {
      outbound: runtime?.network?.outbound ?? true,
    },
  };
};

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

export const normalizeUserWorkspaceSpec = (input: unknown): WorkspaceBlueprint => {
  const spec = parseUserWorkspaceSpec(input);

  const workspaceSource = spec.sources?.workspace ?? spec.source ?? spec.repo;
  const inputs = spec.sources?.inputs ?? spec.inputs ?? [];
  const packages = spec.tooling?.packages ?? spec.packages ?? [];
  const ssh = spec.access?.ssh ?? spec.ssh;
  const setup = spec.lifecycle?.setup ?? spec.setup;
  const startup = spec.lifecycle?.startup ?? spec.startup;
  const os = spec.target?.os ?? spec.os;

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
    lifecycle: {
      setup: normalizeCommandSteps(setup),
      startup: normalizeStartup(startup),
    },
    runtime: normalizeRuntime(spec.runtime, spec.env),
    target: {
      os: normalizeTargetOs(os),
    },
  });
};
