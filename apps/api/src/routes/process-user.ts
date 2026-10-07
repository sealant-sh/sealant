/**
 * Whether a process may start as the Linux user an exec or a session names (Mend ADR 0016
 * decision 1), decided before anything is created or started. `user` goes to the workspace's
 * sealantd (`exec.user`, 0.20.0-next.150 and later), which starts the process as that passwd entry;
 * Core allows it only for a person Mend made (a uid in 40001–49999 whose primary group is `mend`),
 * never root, on a workspace whose daemon reports the capability. Anything else is refused with
 * `user-unsupported`, worded by reason, and nothing is started. A request without `user` never
 * comes here.
 *
 * A yes is kept per executor and user for a few minutes, so a person's run of execs pays the
 * executor's answer once: the daemon's capabilities do not change while it runs, and a person's
 * passwd entry is made once at prepare.
 */
import type { WorkspaceRuntimeInstance } from "@sealant/db";
import {
  liveProcessUserChannel,
  PROCESS_USER_RANGE_RULE,
  processUserCheckOutcome,
  processUserProblem,
  runtimeRunsProcessesAsUser,
  type ProcessUserChannel,
  type ProcessUserRefusal,
  type SealantTarget,
} from "@sealant/workspaces";
import { Duration, Effect, Result } from "effect";

/** How long the executor may take to answer the check: one connection and one short exec. */
const CHECK_TIMEOUT = Duration.seconds(30);

/** How long a yes is kept, and for how many executor-user pairs. */
const ALLOWED_TTL_MS = 10 * 60_000;
const ALLOWED_MAX = 1024;

/** `<executor run id>\u0000<user>` → when the yes expires. */
const allowed = new Map<string, number>();

const allowedKey = (instance: WorkspaceRuntimeInstance, user: string) =>
  `${instance.runId}\u0000${user}`;

/** For tests: forget every kept yes. */
export const forgetProcessUserAnswers = (): void => allowed.clear();

/** The words a refusal is answered with, by reason. Nothing was started either way. */
export const processUserRefusalMessage = (
  workspaceId: string,
  user: string,
  refusal: ProcessUserRefusal,
): string => {
  switch (refusal.reason) {
    case "runtime-unsupported":
    case "sealantd-unsupported":
      return `Workspace ${workspaceId}'s sealantd doesn't run processes as another user (${refusal.detail}), so nothing was started as '${user}'.`;
    case "not-in-range":
      return `User '${user}' is not in range (${refusal.detail}): ${PROCESS_USER_RANGE_RULE}. Nothing was started.`;
    case "unknown-user":
      return `User '${user}' is not in workspace ${workspaceId} (${refusal.detail}). Nothing was started.`;
  }
};

/** What the check found: allowed, refused with a reason, or no answer from the executor. */
export type ProcessUserVerdict =
  | { readonly kind: "allowed" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "unanswered"; readonly message: string };

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "no answer";

/** The name alone (no I/O): root, a malformed user and a uid outside the range. */
export const processUserNameRefusal = (workspaceId: string, user: string): string | undefined => {
  const problem = processUserProblem(user);
  return problem === undefined ? undefined : processUserRefusalMessage(workspaceId, user, problem);
};

/**
 * Asks the workspace's executor whether `user` may run a process there. The caller has already
 * refused a malformed or out-of-range name (`processUserNameRefusal`) and holds the ready executor.
 */
export const checkProcessUser = (input: {
  readonly workspaceId: string;
  readonly instance: WorkspaceRuntimeInstance;
  /** How to reach the executor's daemon; undefined when this process has no way to. */
  readonly target: SealantTarget | undefined;
  readonly user: string;
  /** For tests; defaults to the live channel. */
  readonly channel?: ProcessUserChannel;
}): Effect.Effect<ProcessUserVerdict> =>
  Effect.gen(function* () {
    const { workspaceId, instance, user } = input;
    if (instance.adapter === null || !runtimeRunsProcessesAsUser(instance.adapter)) {
      return {
        kind: "refused",
        message: processUserRefusalMessage(workspaceId, user, {
          reason: "runtime-unsupported",
          detail:
            instance.adapter === null
              ? "its runtime is not recorded"
              : `the ${instance.adapter} runtime never starts a process as a user`,
        }),
      } satisfies ProcessUserVerdict;
    }
    const target = input.target;
    if (target === undefined) {
      return {
        kind: "unanswered",
        message: `Core has no way to reach workspace ${workspaceId}'s executor from here (its control client is not configured for this runtime), so it cannot check '${user}'. Nothing was started.`,
      } satisfies ProcessUserVerdict;
    }
    const key = allowedKey(instance, user);
    const now = Date.now();
    const until = allowed.get(key);
    if (until !== undefined && until > now) return { kind: "allowed" } satisfies ProcessUserVerdict;

    const channel = input.channel ?? liveProcessUserChannel;
    const answered = yield* channel
      .check(target, user)
      .pipe(Effect.timeout(CHECK_TIMEOUT), Effect.result);
    if (Result.isFailure(answered)) {
      return {
        kind: "unanswered",
        message: `The workspace's executor did not answer whether '${user}' may run a process: ${toErrorMessage(answered.failure)}. Nothing was started.`,
      } satisfies ProcessUserVerdict;
    }
    const outcome = processUserCheckOutcome(answered.success);
    if (outcome === "ok") {
      allowed.delete(key);
      if (allowed.size >= ALLOWED_MAX) {
        const oldest = allowed.keys().next();
        if (oldest.done !== true) allowed.delete(oldest.value);
      }
      allowed.set(key, now + ALLOWED_TTL_MS);
      return { kind: "allowed" } satisfies ProcessUserVerdict;
    }
    if (outcome === "unanswered") {
      return {
        kind: "unanswered",
        message: `The workspace's executor did not confirm whether '${user}' may run a process (the check exited ${String(answered.success.exitCode)}). Nothing was started.`,
      } satisfies ProcessUserVerdict;
    }
    allowed.delete(key);
    return {
      kind: "refused",
      message: processUserRefusalMessage(workspaceId, user, outcome),
    } satisfies ProcessUserVerdict;
  });
