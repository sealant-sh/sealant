import { CLAUDE_CREDENTIALS_JSON_PATH, CODEX_AUTH_JSON_PATH } from "@sealant/credentials";
import {
  WorkspaceCredentialHomeRepo,
  WorkspaceRuntimeInstanceRepo,
  type WorkspaceCredentialHomeTarget,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { Duration, Effect } from "effect";

import {
  buildHomeCredentialScript,
  liveHomeCredentialChannel,
  type HomeCredentialChannel,
} from "../runtime/home-credentials.js";
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

Homes (§6c): every home whose record names the account gets the copy too, at `<home>/<file>`, owned
by the home's owner. Each home is written under its row lock, re-read under that lock first: a home
released (or emptied of this account) since the listing is left alone, so a refresh never lands in a
home another person has taken since.
*/

/** At most this many homes are written at once: each holds a database connection while it writes. */
const HOME_PUSH_CONCURRENCY = 4;

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
  /** For tests; defaults to the live home channel. */
  readonly homeChannel?: HomeCredentialChannel;
}

export interface CredentialPushSummary {
  readonly written: number;
  readonly failed: number;
  readonly unreachable: number;
  /** Homes listed holding the account that no longer held it under their lock (left alone). */
  readonly released: number;
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
  const homeRepo = yield* WorkspaceCredentialHomeRepo;
  const holding = instancesHoldingAccount(
    yield* runtimeInstances.listRunningInstances(),
    input.connectedAccountId,
  );
  const homes = yield* homeRepo.listReadyHoldingAccount(input.connectedAccountId);
  if (holding.length === 0 && homes.length === 0) {
    return { written: 0, failed: 0, unreachable: 0, released: 0 } satisfies CredentialPushSummary;
  }

  const file = {
    kind: "file" as const,
    path: input.provider === "claude" ? CLAUDE_CREDENTIALS_JSON_PATH : CODEX_AUTH_JSON_PATH,
    contentBase64: Buffer.from(input.copyJson, "utf8").toString("base64"),
    mode: "600",
  };

  const launchOutcomes = yield* Effect.forEach(
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

  const homeOutcomes = yield* Effect.forEach(
    homes,
    (target) => pushIntoHome({ ...input, describe, target }),
    { concurrency: HOME_PUSH_CONCURRENCY },
  );

  const outcomes = [...launchOutcomes, ...homeOutcomes];
  const summary: CredentialPushSummary = {
    written: outcomes.filter((outcome) => outcome === "written").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    unreachable: outcomes.filter((outcome) => outcome === "unreachable").length,
    released: outcomes.filter((outcome) => outcome === "released").length,
  };
  yield* Effect.logInfo(
    `${describe}: pushed to ${summary.written} of ${outcomes.length} running workspace(s) and home(s)` +
      (summary.failed + summary.unreachable > 0
        ? ` · ${summary.failed} failed · ${summary.unreachable} unreachable`
        : "") +
      (summary.released > 0 ? ` · ${summary.released} no longer held it` : ""),
  );
  return summary;
});

/** One home's write, under its row lock, after reading the row again under it. */
const pushIntoHome = (
  input: PushCredentialCopyInput & {
    readonly describe: string;
    readonly target: WorkspaceCredentialHomeTarget;
  },
) =>
  Effect.gen(function* () {
    const homeRepo = yield* WorkspaceCredentialHomeRepo;
    const { home, instance } = input.target;
    const target = sealantTargetForRuntimeInstance(instance, input.targetOptions ?? {});
    if (target === undefined) return "unreachable" as const;
    const homeChannel = input.homeChannel ?? liveHomeCredentialChannel;
    return yield* homeRepo.withLockedHome({ runId: home.runId, home: home.home }, (held) =>
      Effect.gen(function* () {
        const stillHeld =
          held?.accounts.some(
            (account) =>
              account.provider === input.provider &&
              account.connectedAccountId === input.connectedAccountId,
          ) === true;
        if (!stillHeld) {
          return { result: "released" as const, outcome: { kind: "keep" as const } };
        }
        const exit = yield* Effect.tryPromise(() =>
          homeChannel.run(
            target,
            buildHomeCredentialScript({
              home: home.home,
              writes: [{ provider: input.provider, content: input.copyJson }],
              removes: [],
            }),
          ),
        ).pipe(Effect.timeout(PUSH_TIMEOUT));
        if (exit.exitCode !== 0) {
          return yield* Effect.fail(
            new Error(`The write into ${home.home} exited with ${String(exit.exitCode)}.`),
          );
        }
        return { result: "written" as const, outcome: { kind: "keep" as const } };
      }),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `${input.describe}: home ${input.target.home.home} of workspace run ${input.target.home.runId} was not written.`,
        cause,
      ).pipe(Effect.as("failed" as const)),
    ),
  );
