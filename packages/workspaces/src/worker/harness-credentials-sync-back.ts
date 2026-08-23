import {
  CLAUDE_CREDENTIALS_JSON_PATH,
  CODEX_AUTH_JSON_PATH,
  type CredentialCipherService,
} from "@sealant/credentials";
import { WorkspaceAttemptRepo, type WorkspaceLaunchCredentialInjection } from "@sealant/db";
import { newWorkspaceSchema } from "@sealant/validators";
import { Effect, Schedule } from "effect";

import type { SealantTarget } from "../sealantd/runtime.js";
import { execInWorkspace } from "../sealantd/target.js";
import { syncBackClaudeCredentials } from "./claude-credentials-sync-back.js";
import { syncBackCodexAuthJson } from "./codex-auth-sync-back.js";

/*
Best-effort credential sync-back for a live workspace runtime (design doc §2 / §6): the official
CLIs in the workspace rotate their session files — codex rewrites auth.json (rotating its refresh
token), claude rewrites .credentials.json for session-file accounts — so the mutated files must be
persisted, newest-wins only, and never at the cost of the surrounding job. Invoked on EVERY path
that is about to lose the container: after run-exec jobs, on workspace stop (user stop, restart's
stop half), and by the expiry reaper — interactive/PTY sessions rotate tokens too, and their
workspaces may never run another exec job.

The blueprint is re-derived from the stored attempt snapshot; workspaces without a matching
credentialRef no-op immediately.
*/

/** The control transport can flake (socat bridge, WSS reconnect); retry the one-shot reads with a spaced window. */
const READ_RETRY = { schedule: Schedule.spaced("400 millis"), times: 5 };

/**
 * Isolates one provider's sync-back with its own catchCause: a DEFECT escaping one (the helpers
 * only catch their typed failures) must not skip the other provider's sync.
 */
const isolatedSyncBack = <E, R>(label: string, sync: Effect.Effect<void, E, R>) =>
  sync.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`${label} sync-back crashed; continuing.`, cause),
    ),
    Effect.asVoid,
  );

export interface SyncBackWorkspaceCredentialsInput {
  /** The attempt whose stored snapshot carries the launch blueprint (and thus the refs). */
  readonly attemptId: string;
  /** How to reach the still-running workspace runtime (any adapter). */
  readonly target: SealantTarget;
  /** Launch-time injection shapes from the runtime instance row; null/legacy means none. */
  readonly launchCredentialInjections: readonly WorkspaceLaunchCredentialInjection[];
  /** Undefined when SEALANT_CREDENTIALS_KEY is not configured on the worker. */
  readonly credentialCipher: CredentialCipherService | undefined;
}

/**
 * Read the rotated credential files out of a live workspace container and persist them
 * newest-wins. Never fails (warnings only) — callers may `yield*` it unconditionally on any
 * teardown path, BEFORE the container is destroyed.
 */
export const syncBackWorkspaceCredentials = Effect.fn("syncBackWorkspaceCredentials")(
  function* (input: SyncBackWorkspaceCredentialsInput) {
    const attempts = yield* WorkspaceAttemptRepo;
    const snapshot = yield* attempts.getAttemptSnapshotByRunId(input.attemptId);
    if (snapshot === undefined) {
      yield* Effect.logWarning(
        `Credential sync-back skipped for attempt ${input.attemptId}: no stored attempt snapshot to re-derive the blueprint from.`,
      );
      return;
    }
    const blueprint = newWorkspaceSchema.parse(snapshot.blueprintPayload);

    const target = input.target;

    // `$HOME` expands inside the container shell; a missing file surfaces as a non-zero exit.
    const readWorkspaceFile = (path: string) =>
      execInWorkspace(target, {
        executable: "sh",
        args: ["-c", `cat "${path}"`],
      }).pipe(
        Effect.retry(READ_RETRY),
        Effect.filterOrFail(
          (result) => result.exitCode === 0,
          (result) => new Error(`Reading ${path} exited with code ${result.exitCode}.`),
        ),
        Effect.map((result) => result.stdout),
      );

    yield* isolatedSyncBack(
      "Codex auth",
      syncBackCodexAuthJson({
        blueprint,
        credentialCipher: input.credentialCipher,
        readAuthJson: () => readWorkspaceFile(CODEX_AUTH_JSON_PATH),
      }),
    );

    yield* isolatedSyncBack(
      "Claude credentials",
      syncBackClaudeCredentials({
        blueprint,
        // Launch-time truth from the runtime instance row: only accounts Sealant seeded as a FILE
        // in THIS workspace may sync back (env-injected workspaces never do).
        launchFileInjectedAccountIds: input.launchCredentialInjections
          .filter((entry) => entry.provider === "claude" && entry.injection === "file")
          .map((entry) => entry.connectedAccountId),
        credentialCipher: input.credentialCipher,
        readCredentialsJson: () => readWorkspaceFile(CLAUDE_CREDENTIALS_JSON_PATH),
      }),
    );
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Credential sync-back failed; continuing.", cause).pipe(Effect.asVoid),
  ),
);
