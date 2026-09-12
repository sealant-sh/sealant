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
  /**
   * Confirmed-termination fencing (sealantd ADR-0015): skip the daemon's graceful window and
   * kill the runtime outright, so a replacement executor can claim the worktree knowing the old
   * one cannot write again. Absent = a planned stop, which lets the daemon flush first where the
   * runtime distinguishes the two (today: Cloudflare `stop()` versus `destroy()`).
   */
  fence: z.boolean().optional(),
});

export const runtimeAdapterStopResultSchema = z.strictObject({
  adapter: runtimeAdapterIdSchema,
  resourceId: z.string().trim().min(1),
  outcome: z.enum(["stopped", "not-found"]),
});

/**
 * What a runtime knows about a launched executor when asked (optional port method `inspect`).
 * Runtimes without an event stream (Lambda MicroVMs) answer this by polling their platform API;
 * the engine above uses it to notice an executor that ended without a stop and to schedule a
 * replacement before a platform-imposed lifetime cap.
 *
 * - `running`: the executor exists and has not ended. `startedAt` / `deadline` are ISO-8601
 *   instants and `maxDurationSeconds` the platform cap they derive from — all optional, present
 *   only where the runtime imposes a lifetime (a MicroVM ends at `startedAt + maxDuration`,
 *   suspended time included). `platformState` is the runtime's own word for the state (for logs
 *   and evidence; never branch on it — a suspended VM is still `running` here).
 * - `exited`: the executor ended. `exitCode` where the runtime reports one (a container), `detail`
 *   the runtime's reason text when it has one.
 * - `missing`: the runtime no longer knows the resource at all.
 */
const runtimeAdapterRunningSchema = z.strictObject({
  state: z.literal("running"),
  startedAt: z.string().datetime({ offset: true }).optional(),
  deadline: z.string().datetime({ offset: true }).optional(),
  maxDurationSeconds: z.number().int().positive().optional(),
  platformState: z.string().trim().min(1).optional(),
});

const runtimeAdapterEndedSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("exited"),
    exitCode: z.number().int().optional(),
    detail: z.string().trim().min(1).optional(),
  }),
  z.strictObject({
    state: z.literal("missing"),
  }),
]);

export const runtimeAdapterInspectResultSchema = z.discriminatedUnion("state", [
  runtimeAdapterRunningSchema,
  ...runtimeAdapterEndedSchema.options,
]);

export const runtimeAdapterInspectInputSchema = z.strictObject({
  resourceId: z.string().trim().min(1),
});

/** One exit observed by `watchExits`: the resource and what `inspect` last saw for it. */
export const runtimeAdapterExitEventSchema = z.strictObject({
  resourceId: z.string().trim().min(1),
  result: runtimeAdapterEndedSchema,
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

export const parseRuntimeAdapterInspectResult = (input: unknown): RuntimeAdapterInspectResult => {
  return runtimeAdapterInspectResultSchema.parse(input);
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

export type RuntimeAdapterInspectInput = z.infer<typeof runtimeAdapterInspectInputSchema>;

export type RuntimeAdapterInspectResult = z.infer<typeof runtimeAdapterInspectResultSchema>;

export type RuntimeAdapterExitEvent = z.infer<typeof runtimeAdapterExitEventSchema>;

export interface RuntimeAdapterExitWatchInput {
  /**
   * Restrict the watch to these resources. Absent = every resource this adapter launched (the
   * worker's exit reconciler opens one watch per adapter for the life of the process, so the set
   * cannot be fixed up front). A runtime with no event stream and no cheap enumeration (MicroVM)
   * needs the list and reports nothing without one; the reconciler's poll still covers it.
   */
  readonly resourceIds?: readonly string[];
  /** Called at most once per resource, the first time it is seen `exited` or `missing`. */
  readonly onExit: (event: RuntimeAdapterExitEvent) => void;
  /**
   * A poll for one resource failed (`resourceId` names it) or the runtime's event stream dropped
   * (no resource; the adapter is already reconnecting). The watch keeps going either way.
   */
  readonly onError?: (error: unknown, resourceId?: string) => void;
}

/** A running exit watch; `close` stops it and releases its timer. Idempotent. */
export interface RuntimeAdapterExitWatch {
  readonly close: () => void;
}

export interface RuntimeAdapter {
  readonly id: RuntimeAdapterId;

  supports(input: RuntimeAdapterSupportInput): RuntimeAdapterSupport;
  launch(input: RuntimeAdapterLaunchInput): Promise<RuntimeAdapterLaunchResult>;
  stop(input: RuntimeAdapterStopInput): Promise<RuntimeAdapterStopResult>;
  /**
   * Optional: what the runtime knows about a launched executor right now. Adapters that cannot
   * answer cheaply leave it undefined; callers treat an absent method as "no liveness signal
   * from this runtime" rather than as `missing`.
   */
  inspect?(input: RuntimeAdapterInspectInput): Promise<RuntimeAdapterInspectResult>;
  /**
   * Optional: report when an executor ends, as the runtime announces it (`docker events`, a Pod
   * watch). Runtimes with no event stream poll `inspect` on their own cadence; the watch owns
   * that timer or connection until `close`, reconnecting on its own when the stream drops. Exits
   * announced while a stream is down are not replayed — the caller's poll is the convergence net.
   */
  watchExits?(input: RuntimeAdapterExitWatchInput): RuntimeAdapterExitWatch;
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
