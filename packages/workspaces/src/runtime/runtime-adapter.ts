import {
  workspaceBindSchema,
  newWorkspaceSchema,
  runtimeAdapterIdSchema,
} from "@sealant/validators";
import { z } from "zod";

export const runtimeAdapterBlueprintSchema = newWorkspaceSchema;

// The id list lives in @sealant/validators (the one home); re-exported here so runtime code
// keeps importing it from the adapter seam.
export { runtimeAdapterIdSchema, runtimeAdapterIds } from "@sealant/validators";

export const runtimeAdapterSupportFailureReasonSchema = z.enum([
  "unsupported-runtime",
  "unsupported-access-mode",
  "unsupported-runtime-requirement",
  "adapter-unavailable",
]);

export const runtimeAdapterSupportSchema = z.discriminatedUnion("supported", [
  z.strictObject({
    supported: z.literal(true),
  }),
  z.strictObject({
    supported: z.literal(false),
    reason: runtimeAdapterSupportFailureReasonSchema,
    message: z.string().trim().min(1),
  }),
]);

export const publishedImageSchema = z.strictObject({
  repository: z.string().trim().min(1),
  tag: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  digestReference: z.string().trim().min(1),
  digest: z.string().trim().min(1),
});

export const workspaceCloneAuthSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("none"),
  }),
  z.strictObject({
    type: z.literal("file-ref"),
    path: z.string().trim().min(1),
  }),
  z.strictObject({
    type: z.literal("http-token"),
    username: z.string().trim().min(1),
    token: z.string().trim().min(1),
  }),
]);

export const runtimeAdapterSupportInputSchema = z.strictObject({
  blueprint: runtimeAdapterBlueprintSchema,
});

// Connected-account file injection (design doc §6): written AFTER the container is ready via
// `docker exec -i … base64 -d` with the content piped over stdin, so the bytes never appear in
// argv, image layers, or `docker inspect`. The path may contain `$HOME/…` — expansion happens
// inside the container shell.
export const credentialFileInjectionSchema = z.strictObject({
  path: z.string().trim().min(1),
  contentBase64: z.string().min(1),
  mode: z.string().regex(/^[0-7]{3,4}$/),
});

export const runtimeAdapterLaunchInputSchema = z.strictObject({
  blueprint: runtimeAdapterBlueprintSchema,
  publishedImage: publishedImageSchema,
  workspaceCloneAuth: workspaceCloneAuthSchema.optional(),
  // Connected-account env injections (e.g. CLAUDE_CODE_OAUTH_TOKEN); they join the existing `-e`
  // args, sharing the exposure profile of today's clone tokens (plaintext-argv hardening is a
  // tracked, pre-existing item).
  credentialEnv: z.record(z.string(), z.string()).optional(),
  credentialFiles: z.array(credentialFileInjectionSchema).optional(),
  // TRANSIENT platform-owned launch environment resolved by the worker just before launch (today:
  // dotfiles clone auth, `SEALANT_DOTFILES_HTTP_*`). Deliberately NOT part of the blueprint: the
  // blueprint is the persisted restart source, and worker-resolved tokens must never be conflated
  // with either caller env field or written to a job/attempt payload. Emitted after every
  // blueprint env so it cannot be shadowed, before `credentialEnv`.
  platformEnv: z.record(z.string(), z.string()).optional(),
  // Host directory staged by the worker with manifest.json + *.tar.gz dotfiles archives. The
  // adapter bind-mounts it read-only and points SEALANT_DOTFILES_ARCHIVE_DIR at the mount so
  // `sealantd boot` applies the archives before the control socket binds.
  dotfilesArchiveDir: z.string().trim().min(1).optional(),
  // Host directory holding the worker-staged `env.json` for the transient secret channel. The
  // adapter bind-mounts it read-only at /run/sealant/secrets and points SEALANT_SECRET_ENV_FILE at
  // the file so `sealantd boot` merges the entries into every child environment and seeds its
  // redactor. The worker deletes the staged file once the workspace is ready.
  secretEnvDir: z.string().trim().min(1).optional(),
  // The run (workspace attempt) this launch belongs to. When present the docker adapter derives a
  // DETERMINISTIC per-run container name, so a redelivered/reaper-republished or concurrent launch
  // for the same run adopts the existing container instead of spawning a duplicate (#4 double-launch).
  runId: z.string().trim().min(1).optional(),
  /**
   * Unsealed, policy-validated secret env for runtimes that cannot take a host directory
   * (Kubernetes projects it as the boot secret file). Docker ignores it and uses `secretEnvDir`.
   */
  secretEnv: z.record(z.string(), z.string()).optional(),
  /** Labelling only (never a secret): the workspace this run belongs to. */
  workspaceId: z.string().trim().min(1).optional(),
  /**
   * The workspace's live bindings (sealantd ADR-0014), re-supplied on every launch so a relaunch
   * boots with `/workspace/repo` (and any bindable mount) pointing where it did.
   */
  binds: z.array(workspaceBindSchema).optional(),
  /** Labelling only: an opaque principal id, when safe to stamp on resources. */
  principalId: z.string().trim().min(1).optional(),
  /** Hot-pool skeletons may get a different PriorityClass. */
  pool: z.enum(["hot"]).optional(),
});

export const runtimeAdapterLaunchResultSchema = z.strictObject({
  adapter: runtimeAdapterIdSchema,
  resourceId: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  status: z.enum(["pending", "running", "ready"]),
  endpoint: z.string().trim().min(1).optional(),
});

// Workspaces are ephemeral (built fresh from a published image), so stop = remove: there is no
// stopped-but-resumable container state to preserve. Stop is idempotent — a container that is
// already gone reports `not-found`, which callers treat as success.
export const runtimeAdapterStopInputSchema = z.strictObject({
  resourceId: z.string().trim().min(1),
  reference: z.string().trim().min(1).optional(),
});

export const runtimeAdapterStopResultSchema = z.strictObject({
  adapter: runtimeAdapterIdSchema,
  resourceId: z.string().trim().min(1),
  outcome: z.enum(["stopped", "not-found"]),
});

export const parseRuntimeAdapterSupport = (input: unknown): RuntimeAdapterSupport => {
  return runtimeAdapterSupportSchema.parse(input);
};

export const parseRuntimeAdapterSupportInput = (input: unknown): RuntimeAdapterSupportInput => {
  return runtimeAdapterSupportInputSchema.parse(input);
};

export const parseRuntimeAdapterLaunchInput = (input: unknown): RuntimeAdapterLaunchInput => {
  return runtimeAdapterLaunchInputSchema.parse(input);
};

export const parseRuntimeAdapterLaunchResult = (input: unknown): RuntimeAdapterLaunchResult => {
  return runtimeAdapterLaunchResultSchema.parse(input);
};

export const parseRuntimeAdapterStopInput = (input: unknown): RuntimeAdapterStopInput => {
  return runtimeAdapterStopInputSchema.parse(input);
};

export const parseRuntimeAdapterStopResult = (input: unknown): RuntimeAdapterStopResult => {
  return runtimeAdapterStopResultSchema.parse(input);
};

export type RuntimeAdapterId = z.infer<typeof runtimeAdapterIdSchema>;

export type RuntimeAdapterBlueprint = z.infer<typeof runtimeAdapterBlueprintSchema>;

export type RuntimeAdapterSupportFailureReason = z.infer<
  typeof runtimeAdapterSupportFailureReasonSchema
>;

export type RuntimeAdapterSupport = z.infer<typeof runtimeAdapterSupportSchema>;

export type RuntimeAdapterSupportInput = z.infer<typeof runtimeAdapterSupportInputSchema>;

export type PublishedImage = z.infer<typeof publishedImageSchema>;

export type WorkspaceCloneAuth = z.infer<typeof workspaceCloneAuthSchema>;

export type CredentialFileInjection = z.infer<typeof credentialFileInjectionSchema>;

export type RuntimeAdapterLaunchInput = z.infer<typeof runtimeAdapterLaunchInputSchema>;

export type RuntimeAdapterLaunchResult = z.infer<typeof runtimeAdapterLaunchResultSchema>;

export type RuntimeAdapterStopInput = z.infer<typeof runtimeAdapterStopInputSchema>;

export type RuntimeAdapterStopResult = z.infer<typeof runtimeAdapterStopResultSchema>;

export interface RuntimeAdapter {
  readonly id: RuntimeAdapterId;

  supports(input: RuntimeAdapterSupportInput): RuntimeAdapterSupport;
  launch(input: RuntimeAdapterLaunchInput): Promise<RuntimeAdapterLaunchResult>;
  stop(input: RuntimeAdapterStopInput): Promise<RuntimeAdapterStopResult>;
}

const createSelectionError = (code: string, message: string): Error & { code: string } => {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
};

const candidateAdapterIds = (
  blueprint: RuntimeAdapterBlueprint,
  defaultAdapterId: RuntimeAdapterId,
): Array<RuntimeAdapterId> => {
  const requested = blueprint.target.runtime.family;
  const mode = blueprint.target.runtime.mode;

  if (requested === "auto") {
    return [defaultAdapterId];
  }

  if (mode === "require") {
    return [requested];
  }

  return [...new Set([requested, defaultAdapterId])];
};

export interface SelectRuntimeAdapterInput {
  readonly blueprint: RuntimeAdapterBlueprint;
  readonly adapters: readonly RuntimeAdapter[];
  readonly defaultAdapterId: RuntimeAdapterId;
}

export interface RuntimeAdapterSelection {
  readonly adapter: RuntimeAdapter;
  readonly adapterId: RuntimeAdapterId;
}

export const selectRuntimeAdapter = (input: SelectRuntimeAdapterInput): RuntimeAdapterSelection => {
  const supportInput = parseRuntimeAdapterSupportInput({
    blueprint: input.blueprint,
  });

  const attemptedIds = candidateAdapterIds(input.blueprint, input.defaultAdapterId);
  let firstSupportFailure: RuntimeAdapterSupport | undefined;

  for (const adapterId of attemptedIds) {
    const adapter = input.adapters.find((candidate) => candidate.id === adapterId);

    if (adapter === undefined) {
      continue;
    }

    const support = adapter.supports(supportInput);
    if (support.supported) {
      return {
        adapter,
        adapterId,
      };
    }

    if (firstSupportFailure === undefined) {
      firstSupportFailure = support;
    }
  }

  const requestedRuntime = input.blueprint.target.runtime.family;
  const mode = input.blueprint.target.runtime.mode;

  if (firstSupportFailure !== undefined && !firstSupportFailure.supported) {
    throw createSelectionError(firstSupportFailure.reason, firstSupportFailure.message);
  }

  if (requestedRuntime !== "auto" && mode === "require") {
    throw createSelectionError(
      "unsupported-runtime",
      `No runtime adapter is registered for target.runtime.family '${requestedRuntime}'.`,
    );
  }

  throw createSelectionError(
    "unsupported-runtime",
    `No runtime adapter is available for the requested runtime preference. Attempted: ${attemptedIds.join(", ")}.`,
  );
};
