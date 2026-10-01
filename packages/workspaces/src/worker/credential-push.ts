import { CLAUDE_CREDENTIALS_JSON_PATH, CODEX_AUTH_JSON_PATH } from "@sealant/credentials";
import { WorkspaceRuntimeInstanceRepo, type WorkspaceRuntimeInstance } from "@sealant/db";
import { Duration, Effect } from "effect";

import { liveControlChannel, type ControlChannel } from "../runtime/kubernetes/adapter.js";
import {
  sealantTargetForRuntimeInstance,
  type SealantTargetDerivationOptions,
} from "../sealantd/target.js";

/*
Push a refreshed login into running workspaces (docs/connected-accounts-design.md §6a "One
refresher"). After the keep-fresh worker refreshes a login, every running workspace launched with it
gets the new COPY (no Claude refresh token / Codex placeholder) written over its credential file, in
parallel, over the executor's control connection — the same exec-with-stdin write a launch uses,
never the run-exec queue.

Claude Code reads its credentials file before every request, so the copy takes effect on the next
request; a Claude refresh revokes the previous access token at once, which is why this runs straight
after the refresh and writes every workspace at the same time. Codex reloads auth.json after a 401
(and near expiry); its previous token keeps working, so it has no deadline.

A workspace that cannot be written keeps its copy until its access token expires, then fails with a
401 and a clear reason. Never fails: every outcome is logged.
*/

const PUSH_TIMEOUT = Duration.seconds(15);

export type CredentialPushProvider = "claude" | "codex";

export interface PushCredentialCopyInput {
  readonly connectedAccountId: string;
  readonly provider: CredentialPushProvider;
  /** The copy to write: never a file that can refresh. */
  readonly copyJson: string;
  readonly targetOptions?: SealantTargetDerivationOptions;
  /** For tests; defaults to the live control channel. */
  readonly controlChannel?: ControlChannel;
}

export interface CredentialPushSummary {
  readonly written: number;
  readonly failed: number;
  readonly unreachable: number;
}

/** Running instances whose launch FILE-injected this account. */
export const instancesHoldingAccount = (
  instances: readonly WorkspaceRuntimeInstance[],
  connectedAccountId: string,
): readonly WorkspaceRuntimeInstance[] =>
  instances.filter((instance) =>
    (instance.launchCredentialInjections ?? []).some(
      (entry) => entry.connectedAccountId === connectedAccountId && entry.injection === "file",
    ),
  );

export const pushCredentialCopy = Effect.fn("pushCredentialCopy")(function* (
  input: PushCredentialCopyInput,
) {
  const describe = `Credential push (${input.provider}): account ${input.connectedAccountId}`;
  const channel = input.controlChannel ?? liveControlChannel;
  const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
  const holding = instancesHoldingAccount(
    yield* runtimeInstances.listRunningInstances(),
    input.connectedAccountId,
  );
  if (holding.length === 0) {
    return { written: 0, failed: 0, unreachable: 0 } satisfies CredentialPushSummary;
  }

  const file = {
    kind: "file" as const,
    path: input.provider === "claude" ? CLAUDE_CREDENTIALS_JSON_PATH : CODEX_AUTH_JSON_PATH,
    contentBase64: Buffer.from(input.copyJson, "utf8").toString("base64"),
    mode: "600",
  };

  const outcomes = yield* Effect.forEach(
    holding,
    (instance) => {
      const target = sealantTargetForRuntimeInstance(instance, input.targetOptions ?? {});
      if (target === undefined) return Effect.succeed("unreachable" as const);
      return Effect.tryPromise(() => channel.writeCredentialFiles(target, [file])).pipe(
        Effect.timeout(PUSH_TIMEOUT),
        Effect.as("written" as const),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `${describe}: workspace run ${instance.runId} was not written.`,
            cause,
          ).pipe(Effect.as("failed" as const)),
        ),
      );
    },
    { concurrency: "unbounded" },
  );

  const summary: CredentialPushSummary = {
    written: outcomes.filter((outcome) => outcome === "written").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    unreachable: outcomes.filter((outcome) => outcome === "unreachable").length,
  };
  yield* Effect.logInfo(
    `${describe}: pushed to ${summary.written} of ${holding.length} running workspace(s)` +
      (summary.failed + summary.unreachable > 0
        ? ` · ${summary.failed} failed · ${summary.unreachable} unreachable`
        : ""),
  );
  return summary;
});
