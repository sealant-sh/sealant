import {
  formatWorkspaceEnvIssue,
  parseWorkspaceEnv,
} from "@sealant/api-contracts/workspace-environment";
import { z } from "zod";

import { runtimeAdapterIds } from "./runtime-adapter-ids.js";

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

export const workspaceTargetOsFamilySchema = z.enum([
  "auto",
  "nix",
  "fedora",
  "arch",
  "ubuntu",
  // A caller-supplied base image instead of a managed distro family; requires target.os.baseImage.
  "custom",
]);
export const workspaceTargetOsModeSchema = z.enum(["prefer", "require"]);
export const workspaceTargetRuntimeFamilySchema = z.enum(["auto", ...runtimeAdapterIds]);
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

// An absolute, normalized path: no relative segments, no trailing slash tricks. This is a SHAPE
// check only — allowlist policy (which roots are mountable) is enforced by the control plane, not
// here, because policy is deployment configuration.
const absoluteNormalizedPathSchema = (label: string) =>
  nonEmptyStringSchema
    .refine((value) => value.startsWith("/"), { message: `${label} must be absolute` })
    .refine((value) => value.split("/").every((segment) => segment !== "." && segment !== ".."), {
      message: `${label} must not contain '.' or '..' segments`,
    })
    .refine((value) => !value.includes("//") && (value === "/" ? true : !value.endsWith("/")), {
      message: `${label} must be normalized (no '//', no trailing slash)`,
    })
    .refine((value) => value !== "/", { message: `${label} must not be the filesystem root` });

export const workspaceHostPathSchema = absoluteNormalizedPathSchema("host path");
export const workspaceMountPathSchema = absoluteNormalizedPathSchema("mount path");

/**
 * A workspace sourced from a CALLER-OWNED host directory bind-mounted at the runtime working
 * directory instead of a fresh clone. The platform treats the path as caller-owned: writes persist
 * across workspace stop/restart/expiry and the path is never reprovisioned or deleted. The daemon
 * boots with `SEALANT_WORKSPACE_SOURCE=mount` and skips its clone-or-reset path entirely.
 */
export const workspaceMountSourceSchema = z.strictObject({
  kind: z.literal("mount"),
  hostPath: workspaceHostPathSchema,
});

// Order matters: git first, so legacy payloads that omit `kind` (relying on the default) still
// resolve as git; a mount payload fails the git shape (no `url`) and falls through to mount.
export const workspaceSourceSchema = z.union([
  workspaceGitSourceSchema,
  workspaceMountSourceSchema,
]);

/**
 * An ADDITIONAL caller-owned host directory bind-mounted beside the primary source — sibling
 * repositories, reference clones, scratch material. Read-only by default: extra mounts widen what
 * the workspace can see, not where its work product lands. Like the primary mount, the host path
 * is caller-owned — never reprovisioned, never cleaned. Shape only, as above; the control plane
 * enforces allowlist policy plus overlap rules against the resolved working directory (which only
 * it can see, because runtime defaults resolve at parse time).
 */
export const workspaceExtraMountSchema = z.strictObject({
  hostPath: workspaceHostPathSchema,
  mountPath: workspaceMountPathSchema,
  readOnly: z.boolean().default(true),
});

export const workspaceInputSourceSchema = z.strictObject({
  id: nonEmptyStringSchema,
  kind: z.literal("git").default("git"),
  purpose: workspaceInputPurposeSchema,
  provider: workspaceSourceProviderSchema.default("generic"),
  url: z.string().url(),
  // Absent means the remote's default branch — never assume `main`, same as the workspace source.
  ref: nonEmptyStringSchema.optional(),
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

export const workspaceDockerServiceSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
  })
  .prefault({});

export const workspaceServicesSchema = z.strictObject({
  docker: workspaceDockerServiceSchema.optional(),
});

export const workspaceToolingSchema = z
  .strictObject({
    packages: z.array(workspacePackageRequestSchema).default([]),
    services: workspaceServicesSchema.optional(),
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

/**
 * A caller-provided dotfiles archive: a gzipped tar the daemon extracts and applies at boot
 * through the same manager dispatch as a cloned repo. This is the transport for callers that
 * resolve dotfiles host-side (a checkout cloned with the caller's own ssh identity, or a scanned
 * selection of home files) instead of handing the workspace a URL plus credentials. Applied in
 * order, after any repo-based dotfiles.
 */
export const workspaceDotfilesArchiveSchema = z.strictObject({
  // base64 of a .tar.gz; ~5.6MB of base64 ≈ 4MB decoded. Dotfiles are text — anything larger
  // is almost certainly a mistake (bundled binaries, a .git directory) and deserves a loud no.
  data: z
    .string()
    .min(1)
    .max(6 * 1024 * 1024)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "data must be base64"),
  manager: workspaceDotfilesManagerSchema.optional(),
  target: workspaceDotfilesTargetSchema.optional(),
  bootstrap: z.boolean().default(true),
  bootstrapCommand: nonEmptyStringSchema.optional(),
});

/**
 * Caller-owned workspace environment, validated against the public policy in
 * `@sealant/api-contracts/workspace-environment` on EVERY parse — create, worker execution, and
 * restart alike (stored pre-feature specs simply decode to the empty default). Distinct from the
 * legacy `env` field below, which predates the policy and keeps its unrestricted semantics for
 * stored-spec compatibility; new callers and the fluent SDK use only `userEnv`.
 */
export const workspaceUserEnvSchema = z
  .record(z.string(), z.string())
  .default({})
  .superRefine((value, ctx) => {
    const result = parseWorkspaceEnv(value);
    if (!result.ok) {
      for (const issue of result.issues) {
        ctx.addIssue({ code: "custom", message: formatWorkspaceEnvIssue(issue) });
      }
    }
  });

/**
 * A Kubernetes object name (DNS-1123 subdomain). These are OBJECT names, not env names — a
 * cluster env source points at a whole Secret/ConfigMap; the platform worker resolves its keys
 * at workspace creation (cluster-env-sources design).
 */
const clusterObjectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, "must be a DNS-1123 subdomain name");

/**
 * One cluster env source: a Kubernetes Secret or ConfigMap in the platform's workspaces
 * namespace, opted in for workspace use with the `sealant.sh/workspace-env: "true"` label.
 * Ordered list, last wins across kinds. Resolved by the WORKER at workspace creation (never
 * kubelet `envFrom`): ConfigMap keys join the plain env list ahead of caller env, Secret keys
 * ride the transient secret channel as its lowest-precedence layer — so explicit env and
 * platform/channel names always win, and secret values seed the output redactor. Kubernetes
 * runtimes only: every other runtime refuses at create time (`runtime-env-references-unsupported`).
 */
export const workspaceEnvFromSourceSchema = z.strictObject({
  kind: z.enum(["secret", "configmap"]),
  name: clusterObjectNameSchema,
});

export const workspaceSpecKubernetesSchema = z
  .strictObject({
    /**
     * ServiceAccount the workspace Pod runs under — an explicit TRUST GRANT (IRSA/Workload
     * Identity hands the session agent that role for the whole session). Honored only against
     * the install's allowlist (`SEALANT_K8S_ALLOWED_WORKSPACE_SERVICE_ACCOUNTS`); names outside
     * it fail the launch readable. `automountServiceAccountToken` stays false regardless.
     */
    serviceAccountName: clusterObjectNameSchema.optional(),
  })
  .prefault({});

export const workspaceSpecRuntimeSchema = z
  .strictObject({
    env: z.record(z.string(), z.string()).default({}),
    userEnv: workspaceUserEnvSchema,
    credentialRefs: z.array(workspaceCredentialRefSchema).default([]),
    dotfilesArchives: z.array(workspaceDotfilesArchiveSchema).max(4).default([]),
    workspaceRoot: nonEmptyStringSchema.default("/workspace"),
    workingDirectory: nonEmptyStringSchema.default("/workspace/repo"),
    persistence: workspacePersistenceSchema.default("ephemeral"),
    ociRuntime: workspaceOciRuntimeSchema.default("runc"),
    network: workspaceSpecNetworkSchema.prefault({}),
    envFrom: z.array(workspaceEnvFromSourceSchema).max(16).default([]),
    kubernetes: workspaceSpecKubernetesSchema,
  })
  .prefault({});

export type WorkspaceEnvFromSource = z.infer<typeof workspaceEnvFromSourceSchema>;

export const workspaceTargetOsSchema = z
  .strictObject({
    family: workspaceTargetOsFamilySchema.default("auto"),
    mode: workspaceTargetOsModeSchema.default("prefer"),
    /**
     * Arbitrary OCI image reference the workspace image is built FROM instead of a managed
     * distro base. Only meaningful (and required) with family "custom": distro package installs
     * are skipped and the build overlays only sealantd + the harness CLIs + the static socat
     * relay. Contract: any Linux base (amd64/arm64) with a POSIX shell; node >= the harness
     * floor for node-based harness CLIs; git for clone/mount sources.
     */
    baseImage: z.string().trim().min(1).optional(),
  })
  .prefault({})
  .refine((os) => (os.family === "custom") === (os.baseImage !== undefined), {
    message: 'target.os.baseImage is required when family is "custom" (and only then).',
  });

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
    workspace: workspaceSourceSchema,
    inputs: z.array(workspaceInputSourceSchema).default([]),
    mounts: z.array(workspaceExtraMountSchema).default([]),
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
