import {
  chatgptLoginEntry,
  CLAUDE_CREDENTIALS_JSON_PATH,
  CODEX_AUTH_JSON_PATH,
  claudeCredentialsFile,
  codexAuthJsonCopy,
  parseClaudeCredentialPayload,
  parseCodexCredentialPayload,
  type CredentialCipherService,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  WorkspaceCredentialHomeRepo,
  WorkspaceRuntimeInstanceRepo,
  type WorkspaceCredentialHomeTarget,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { Duration, Effect, Option } from "effect";

import {
  buildHomeCredentialScript,
  HOME_SCRIPT_EXIT,
  homeLoginOfRefusal,
  homeScriptRefusal,
  homeScriptStdin,
  liveHomeCredentialChannel,
  type HomeCredentialChannel,
  type HomeCredentialProvider,
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

/** The stored login a home's provider is made from: pi's and opencode's are the Codex login. */
const homeLoginSource = (provider: string): CredentialPushProvider | "github" | undefined =>
  provider === "pi" || provider === "opencode"
    ? "codex"
    : provider === "claude" || provider === "codex" || provider === "github"
      ? provider
      : undefined;

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
  /**
   * Given, each home's copy is made from the account as it is stored under that home's lock, never
   * from `copyJson` captured before it: a later refresh that persisted while this push waited is
   * what lands, never the token it revoked.
   */
  readonly credentialCipher?: CredentialCipherService;
}

export interface CredentialPushSummary {
  readonly written: number;
  readonly failed: number;
  readonly unreachable: number;
  /** Homes listed holding the account that no longer held it under their lock (left alone). */
  readonly released: number;
}

/**
 * Running instances whose launch FILE-injected this account at `$HOME`. A launch that wrote into a
 * `credentialsHome` is reached through that home's record instead (§6d), never both.
 */
export const instancesHoldingAccount = (
  instances: readonly WorkspaceRuntimeInstance[],
  connectedAccountId: string,
): readonly WorkspaceRuntimeInstance[] =>
  instances.filter((instance) =>
    (instance.launchCredentialInjections ?? []).some(
      (entry) =>
        entry.connectedAccountId === connectedAccountId &&
        entry.injection === "file" &&
        entry.home === undefined,
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

  // Launches and homes at once: a Claude refresh has just revoked the previous token everywhere.
  const [launchOutcomes, homeOutcomes] = yield* Effect.all(
    [
      Effect.forEach(
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
      ),
      Effect.forEach(homes, (target) => pushIntoHome({ ...input, describe, target }), {
        concurrency: HOME_PUSH_CONCURRENCY,
      }),
    ],
    { concurrency: 2 },
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
    return yield* homeRepo.withLockedHome(
      { runId: home.runId, home: home.home },
      (held, nextFence) =>
        Effect.gen(function* () {
          // The home's logins made from this account: its own provider's, and for a Codex login
          // pi's and opencode's ChatGPT entries too.
          const providers = (held?.accounts ?? []).flatMap((account) =>
            account.connectedAccountId === input.connectedAccountId &&
            homeLoginSource(account.provider) === input.provider
              ? [account.provider]
              : [],
          );
          if (held === undefined || providers.length === 0) {
            return { result: "released" as const, outcome: { kind: "keep" as const } };
          }
          const copyJson =
            input.credentialCipher === undefined
              ? input.copyJson
              : yield* currentCopy(
                  input.connectedAccountId,
                  input.provider,
                  input.credentialCipher,
                );
          if (copyJson === undefined) {
            return { result: "released" as const, outcome: { kind: "keep" as const } };
          }
          // A Codex copy is also where pi's and opencode's entries come from; a login that is not
          // a ChatGPT login (an API key) has none, and those entries are left as they are.
          const writes = providers.flatMap(
            (
              provider,
            ): Array<{ readonly provider: HomeCredentialProvider; readonly content: string }> => {
              if (provider !== "pi" && provider !== "opencode") {
                return [{ provider, content: copyJson }];
              }
              try {
                return [{ provider, content: chatgptLoginEntry(copyJson) }];
              } catch {
                return [];
              }
            },
          );
          if (writes.length === 0) {
            return { result: "written" as const, outcome: { kind: "keep" as const } };
          }
          // Fenced by the hold's generation, under the home's lock in the executor: a write the
          // executor runs after the timeout, once the home is released or retaken, writes nothing.
          // A login file the home refuses (pi's or opencode's unusable, any with another hard link)
          // is left out and the rest written once more, as a partial put does: one bad file never
          // keeps the home's other logins from this refresh.
          let writing = writes;
          for (;;) {
            const exit = yield* homeChannel
              .run(
                target,
                buildHomeCredentialScript({
                  home: home.home,
                  fence: { kind: "held", generation: held.generation },
                  token: yield* nextFence,
                  writes: writing.map(({ provider }) => provider),
                  removes: [],
                }),
                homeScriptStdin(writing.map(({ content }) => content)),
              )
              .pipe(Effect.timeout(PUSH_TIMEOUT));
            if (exit.exitCode === HOME_SCRIPT_EXIT.fenced) {
              return { result: "released" as const, outcome: { kind: "keep" as const } };
            }
            const refusedLogin = homeLoginOfRefusal(exit.exitCode);
            if (
              refusedLogin !== undefined &&
              writing.some(({ provider }) => provider === refusedLogin)
            ) {
              writing = writing.filter(({ provider }) => provider !== refusedLogin);
              yield* Effect.logWarning(
                `${input.describe}: ${homeScriptRefusal(home.home, exit.exitCode) ?? `${refusedLogin}'s login file was refused`} ${refusedLogin}'s login in ${home.home} is not refreshed.`,
              );
              if (writing.length > 0) continue;
            }
            if (exit.exitCode !== 0) {
              return yield* Effect.fail(
                new Error(`The write into ${home.home} exited with ${String(exit.exitCode)}.`),
              );
            }
            break;
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

/** The account's copy as it is stored now; `undefined` when it is gone or archived. */
const currentCopy = (
  connectedAccountId: string,
  provider: CredentialPushProvider,
  cipher: CredentialCipherService,
) =>
  Effect.gen(function* () {
    // Read through the service only where a cipher asks for it, so a push without one needs no
    // account repository.
    const repo = yield* Effect.serviceOption(ConnectedAccountRepo);
    if (Option.isNone(repo)) {
      return yield* Effect.fail(
        new Error("A push that re-reads the account needs its repository."),
      );
    }
    const account = yield* repo.value.getById(connectedAccountId);
    if (account === undefined || account.archivedAt !== null) return undefined;
    const plaintext = yield* cipher.decrypt(account.encryptedPayload);
    const parsed: unknown = JSON.parse(plaintext);
    return provider === "claude"
      ? claudeCredentialsFile(parseClaudeCredentialPayload(parsed))
      : codexAuthJsonCopy(parseCodexCredentialPayload(parsed).authJson);
  });
