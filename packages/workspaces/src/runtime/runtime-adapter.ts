import {
  workspaceBindSchema,
  newWorkspaceSchema,
  runtimeAdapterIdSchema,
} from "@sealant/validators";
import { z } from "zod";

import type { RuntimeAdapterLaunchHooks, RuntimeLaunchIdentity } from "./launch-retention.js";

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
  /**
   * The home the file belongs to (a launch's `credentialsHome`): the home is made for this owner
   * when missing, reached without a symbolic link, and the file and the directories made for it
   * are the owner's. `path` is then `<home>/<one of Core's login files>`.
   */
  home: z
    .strictObject({
      path: z.string().trim().min(1),
      uid: z.number().int().min(0),
      gid: z.number().int().min(0),
    })
    .optional(),
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
   * The launch identity the create named for this executor (cross-repo decisions 5 and 11): a
   * capture-sourced executor boots with it (`SEALANT_CAPTURE_LAUNCH_ID`), names it from its first
   * `plan.get`, and refuses a plan that answers another executor. Absent when the create named none.
   */
  launchId: z.string().trim().min(1).optional(),
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
  /**
   * ISO-8601 instant the runtime itself ends this executor, whatever anyone asks (a Lambda
   * MicroVM's maximum duration from its start). Absent where the runtime imposes no lifetime.
   * Recorded on the runtime instance and reported on the workspace, so a caller holding unsaved
   * work can drain before it.
   */
  deadline: z.string().datetime({ offset: true }).optional(),
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
  /**
   * Which part of the stop to do, sent only to a runtime that declares `keepsRemains`. `end` ends
   * the executor (the planned SIGTERM and its grace, or the fenced kill) and returns once nothing
   * of it runs any more, leaving its remains (the exited container's disk, its sidecar) in place;
   * `remove` takes the remains, idempotent over an executor already ended or gone. Absent: both,
   * as one call — the only form a runtime without remains ever receives. The worker's stop records
   * `stopped` between the two, so a stop is reported the moment the executor has ended, not after
   * its disk is removed too (4 s of every Stop on Docker, 2026-10-03).
   */
  phase: z.enum(["end", "remove"]).optional(),
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
 *   and evidence; never branch on it — a suspended VM is still `running` here). `detail` reports
 *   a guest service that failed while the executor itself survived (a MicroVM's guest Docker):
 *   reported, never a reason to end the executor — its daemon, and the work on it, are intact.
 * - `exited`: the executor ended. `exitCode` where the runtime reports one (a container), `detail`
 *   the runtime's reason text when it has one. `platformEnded` says what the platform itself
 *   reports of the machine under it, where the two can differ (a MicroVM whose sealantd exited
 *   while the VM runs on with its disk): `true` the platform ended the machine (its disk is gone
 *   with it), `false` the machine is still up (only its daemon ended), absent the runtime does not
 *   separate them. `platformState` is the platform's own word, for reports.
 * - `missing`: the runtime no longer knows the resource at all.
 */
const runtimeAdapterRunningSchema = z.strictObject({
  state: z.literal("running"),
  startedAt: z.string().datetime({ offset: true }).optional(),
  deadline: z.string().datetime({ offset: true }).optional(),
  maxDurationSeconds: z.number().int().positive().optional(),
  platformState: z.string().trim().min(1).optional(),
  detail: z.string().trim().min(1).optional(),
});

const runtimeAdapterEndedSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("exited"),
    exitCode: z.number().int().optional(),
    detail: z.string().trim().min(1).optional(),
    platformEnded: z.boolean().optional(),
    platformState: z.string().trim().min(1).optional(),
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

/** Which retained executor to recover (`RuntimeAdapter.recover`). */
export interface RuntimeAdapterRecoverInput {
  readonly resourceId: string;
  readonly reference?: string;
  /** The run the executor was launched for (a runtime that checks it, MicroVM). */
  readonly runId?: string;
  /**
   * The recovery boot's secret env (the capture token the executor was launched with), for a
   * runtime that hands it to the restarted daemon itself (MicroVM: pushed to its agent). Docker
   * reads it from the host directory the worker stages it into again.
   */
  readonly secretEnv?: Readonly<Record<string, string>>;
}

/**
 * What a recovery attempt did:
 *
 *  - `restarted`: the executor had ended and the runtime started it again ON ITS OWN DISK
 *    (Docker `docker start` of the kept container). sealantd boots, finds its staging at or past
 *    the head and resumes it without materializing over it; the caller then asks for a FINAL
 *    flush, which stops every writer the reboot started, snapshots both classes and ships.
 *  - `running`: it is running already; nothing was done (drain it).
 *  - `missing`: nothing of it is left to recover.
 *  - `nothing-to-save`: the recovery boot found nothing to save and exited without starting
 *    (sealantd exit 76, `EXIT_NOTHING_TO_SAVE`): the executor never materialized a capture —
 *    its worktree is absent or holds only the daemon's boot lock — and since capture starts
 *    before any user code, no user code ever ran on it. `detail` is the daemon's own words. The
 *    only evidence that lets an executor whose recovery never completed go; exit 75 stays kept.
 *  - `unsupported`: this runtime cannot restart an ended executor on its own disk; `detail`
 *    says why and what, if anything, can still be done by hand. The executor stays retained.
 */
export type RuntimeAdapterRecoverResult =
  | { readonly outcome: "restarted" | "running" | "missing" }
  | { readonly outcome: "unsupported" | "nothing-to-save"; readonly detail: string };

/** sealantd's exit when its recovery boot finds nothing to save (`EXIT_NOTHING_TO_SAVE`). */
export const SEALANTD_EXIT_NOTHING_TO_SAVE = 76;

/** The daemon's own line saying why there is nothing to save, from its output; else a summary. */
export const nothingToSaveDetail = (output: string | undefined): string => {
  const line = /sealantd boot: nothing to save[^\n]*/.exec(output ?? "")?.[0];
  return (
    line?.trim() ??
    "sealantd's recovery boot exited 76: nothing to save (the executor never materialized a capture)"
  );
};

/**
 * Mark an error from a removal call (`stop`) as the runtime's DEFINITIVE refusal (review 9 #5,
 * decision 27): the provider answered and did not act, or nothing was sent to it at all. Only
 * such a failure gives up a removal that was issued (`removeUnderDeletion`); any other failure —
 * a transport error after the request may have gone out, a timeout, an abort — is an outcome
 * nobody knows, and the removal stays issued and exclusionary until the runtime is inspected.
 */
export const removalRefused = <T extends Error>(error: T): T & { readonly removalRefused: true } =>
  Object.assign(error, { removalRefused: true as const });

/** Whether an error (or any error it was caused by) is the runtime's definitive refusal. */
export const isRemovalRefusal = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    if ("removalRefused" in current && current.removalRefused === true) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
};

export interface RuntimeAdapter {
  readonly id: RuntimeAdapterId;
  /**
   * Optional: the provider's own bound on a removal request (review 9 #5, decision 27): once this
   * long has passed since a removal was issued, nothing that removal sent can still act on the
   * runtime (the provider rejects the request or has settled it), so an executor the runtime still
   * has was not removed by it and never will be. An issued removal whose outcome is unknown and
   * whose evidence changed since is given up only past it. Absent: the runtime gives no such
   * bound, and such a removal stays issued (the executor kept, nothing observed or recovered)
   * until the runtime no longer has the executor or the evidence it was authorized on stands
   * again.
   */
  readonly removalFenceMs?: number;
  /**
   * Optional: an ended executor leaves remains on this runtime (Docker: the exited container's
   * disk, its sidecar and network) whose removal costs more than its end. The worker then stops it
   * in two phases (`RuntimeAdapterStopInput.phase`: `end`, the record, `remove`) and the exit
   * reconciler removes the remains of a `stopped` instance whose removal was never recorded. Absent
   * (Kubernetes, MicroVM, Cloudflare): one `stop` call, no phase, as always.
   */
  readonly keepsRemains?: boolean;

  supports(input: RuntimeAdapterSupportInput): RuntimeAdapterSupport;
  /**
   * Launch the executor. `hooks.onReady` is called once its daemon answers, before any later
   * step; a capture-sourced launch that fails after that keeps its executor and throws
   * `LaunchRetainedError` (`launch-retention.ts`).
   */
  launch(
    input: RuntimeAdapterLaunchInput,
    hooks?: RuntimeAdapterLaunchHooks,
  ): Promise<RuntimeAdapterLaunchResult>;
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
  /**
   * Optional: bring a RETAINED executor — kept because its disk holds work not confirmed saved —
   * back up on its own disk so its daemon can finish shipping (see
   * `RuntimeAdapterRecoverResult`). Absent = the runtime cannot; the executor stays retained.
   */
  recover?(input: RuntimeAdapterRecoverInput): Promise<RuntimeAdapterRecoverResult>;
  /**
   * Optional: stop what a RETAINED executor that ENDED no longer needs while it waits for its
   * recovery — never its disk. Docker: the workspace's Docker sidecar (`<name>-docker`, its own
   * dockerd), which otherwise runs on for as long as the executor is kept. Idempotent; answers
   * what it stopped (nothing, when there was nothing running beside the executor).
   */
  parkRetained?(input: RuntimeAdapterParkInput): Promise<RuntimeAdapterParkResult>;
  /**
   * Optional: the executor a launch of `runId` created, found by the identity the runtime gives
   * every executor of a run (Docker: the per-run container name) — for a launch whose worker was
   * lost between creating the executor and recording it. `undefined` = the runtime knows none;
   * a failed read throws (unknown is never taken for none). Absent = the runtime cannot tell.
   */
  locate?(input: { readonly runId: string }): Promise<RuntimeLaunchIdentity | undefined>;
}

export interface RuntimeAdapterParkInput {
  readonly resourceId: string;
  readonly reference?: string;
}

export interface RuntimeAdapterParkResult {
  /** What was stopped (e.g. the Docker sidecar's name); empty when nothing was running. */
  readonly stopped: readonly string[];
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
