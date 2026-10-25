import {
  chatgptLoginEntry,
  CLAUDE_CREDENTIALS_JSON_PATH,
  CODEX_AUTH_JSON_PATH,
  claudeCredentialsFile,
  codexAuthJsonCopy,
  loginClassOf,
  parseClaudeCredentialPayload,
  parseCodexCredentialPayload,
  type CredentialCipherService,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  CredentialPlacementRepo,
  settleInDoubt,
  WorkspaceCredentialHomeRepo,
  WorkspaceRuntimeInstanceRepo,
  type CredentialPlacementTarget,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { Duration, Effect } from "effect";

import {
  HOME_SCRIPT_EXIT,
  homeLoginOfRefusal,
  liveHomeCredentialChannel,
  type HomeCredentialChannel,
  type HomeCredentialProvider,
} from "../runtime/home-credentials.js";
import { liveControlChannel, type ControlChannel } from "../runtime/kubernetes/adapter.js";
import {
  sealantTargetForRuntimeInstance,
  type SealantTargetDerivationOptions,
} from "../sealantd/target.js";
import { writeIntoHome } from "./home-placements.js";

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

Homes (§6c): every placement of the account in a home gets the copy too, at `<home>/<file>`, owned
by the home's owner, ready or still being written by a put (which this push waits for). Each home is
written under its lock, its placements read again under it: a home released (or emptied of this
account) since the listing is left alone, so a refresh never lands in a home another person has
taken since.
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
   * Given, each copy is made from the account as it is stored when it is written, never from
   * `copyJson` captured before it: a later refresh that persisted while this push waited is what
   * lands, never the token it revoked, and an account that holds a key by then gets nothing. A home
   * reads it under its lock, the launches at `$HOME` once before they are written.
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
 * Running instances whose launch FILE-injected this account's subscription login at `$HOME`. A
 * launch that wrote into a `credentialsHome` is reached through that home's record instead (§6d),
 * never both; one that placed an API key (the account was replaced with one before it launched)
 * never takes a subscription copy.
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
        entry.home === undefined &&
        entry.login !== "api-key",
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
  const homes = yield* (yield* CredentialPlacementRepo).homesHoldingAccount(
    input.connectedAccountId,
  );
  if (holding.length === 0 && homes.length === 0) {
    return { written: 0, failed: 0, unreachable: 0, released: 0 } satisfies CredentialPushSummary;
  }

  const launchCopy: { readonly copyJson: string } | "released" | "failed" =
    input.credentialCipher === undefined || holding.length === 0
      ? { copyJson: input.copyJson }
      : yield* currentCopy(input).pipe(
          Effect.map((current) => (current === undefined ? "released" : current)),
          Effect.catchCause((cause) =>
            Effect.logWarning(`${describe}: the account could not be read again.`, cause).pipe(
              Effect.as("failed" as const),
            ),
          ),
        );

  // Launches and homes at once: a Claude refresh has just revoked the previous token everywhere.
  const [launchOutcomes, homeOutcomes] = yield* Effect.all(
    [
      Effect.forEach(
        holding,
        (instance) => {
          if (typeof launchCopy === "string") return Effect.succeed(launchCopy);
          const target = sealantTargetForRuntimeInstance(instance, input.targetOptions ?? {});
          if (target === undefined) return Effect.succeed("unreachable" as const);
          const file = {
            kind: "file" as const,
            path: input.provider === "claude" ? CLAUDE_CREDENTIALS_JSON_PATH : CODEX_AUTH_JSON_PATH,
            contentBase64: Buffer.from(launchCopy.copyJson, "utf8").toString("base64"),
            mode: "600",
          };
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

const pushIntoHome = (
  input: PushCredentialCopyInput & {
    readonly describe: string;
    readonly target: CredentialPlacementTarget;
  },
) =>
  Effect.gen(function* () {
    const homeRepo = yield* WorkspaceCredentialHomeRepo;
    const placements = yield* CredentialPlacementRepo;
    const { home, instance } = input.target;
    const target = sealantTargetForRuntimeInstance(instance, input.targetOptions ?? {});
    if (target === undefined) return "unreachable" as const;
    const channel = input.homeChannel ?? liveHomeCredentialChannel;
    const key = { runId: home.runId, home: home.home };
    return yield* homeRepo.withLockedHome(key, (held, nextFence) =>
      Effect.gen(function* () {
        const keep = { kind: "keep" as const };
        if (held === undefined || held.releasing)
          return { result: "released" as const, outcome: keep };
        const refused: HomeCredentialProvider[] = [];
        for (let round = 1; ; round += 1) {
          // The home's logins made from this account: its own provider's, and for a Codex login
          // pi's and opencode's ChatGPT entries too.
          const ready = settleInDoubt((yield* placements.state(key)).placements).filter(
            (row) =>
              row.state === "ready" &&
              row.accountId === input.connectedAccountId &&
              homeLoginSource(row.provider) === input.provider &&
              !refused.includes(row.provider),
          );
          if (ready.length === 0) return { result: "released" as const, outcome: keep };
          const current = yield* currentCopy(input);
          if (current === undefined) return { result: "released" as const, outcome: keep };
          // A Codex copy is also where pi's and opencode's entries come from; a login that is not
          // a ChatGPT login (an API key) has none, and those entries are left as they are.
          const writes = ready.flatMap((row) => {
            const write = {
              provider: row.provider,
              accountId: input.connectedAccountId,
              revision: current.revision,
              reuse: row.id,
            };
            if (row.provider !== "pi" && row.provider !== "opencode") {
              return [{ ...write, content: current.copyJson }];
            }
            try {
              return [{ ...write, content: chatgptLoginEntry(current.copyJson) }];
            } catch {
              return [];
            }
          });
          if (writes.length === 0) return { result: "written" as const, outcome: keep };
          // Fenced by the hold's generation, under the home's lock in the executor: a write the
          // executor runs after the timeout, once the home is released or retaken, writes nothing.
          const ran = yield* writeIntoHome({
            key,
            onBehalfOfUserId: held.onBehalfOfUserId,
            target,
            channel,
            nextFence,
            fence: { kind: "held", generation: held.generation },
            writes,
            removes: [],
          });
          if (ran.kind === "done") return { result: "written" as const, outcome: keep };
          if (ran.kind === "moved" && round < MAX_PUSH_RESOLUTIONS_WHILE_REVISIONS_MOVE) continue;
          if (ran.kind === "refused") {
            if (ran.exitCode === HOME_SCRIPT_EXIT.fenced) {
              return { result: "released" as const, outcome: keep };
            }
            const login = homeLoginOfRefusal(ran.exitCode);
            if (login !== undefined && writes.some(({ provider }) => provider === login)) {
              refused.push(login);
              yield* Effect.logWarning(
                `${input.describe}: ${ran.message} ${login}'s login in ${home.home} is not refreshed.`,
              );
              continue;
            }
          }
          return yield* Effect.fail(
            new Error(
              `The write into ${home.home} was not done: ${ran.kind === "moved" ? "the account kept changing" : ran.message}.`,
            ),
          );
        }
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

const MAX_PUSH_RESOLUTIONS_WHILE_REVISIONS_MOVE = 3;

/** The account's copy and revision as stored now; `undefined` when it is gone, archived, or a key. */
const currentCopy = (input: PushCredentialCopyInput) =>
  Effect.gen(function* () {
    const account = yield* (yield* ConnectedAccountRepo).getById(input.connectedAccountId);
    if (account === undefined || account.archivedAt !== null) return undefined;
    if (input.credentialCipher === undefined) {
      return { revision: account.credentialRevision, copyJson: input.copyJson };
    }
    const parsed: unknown = JSON.parse(
      yield* input.credentialCipher.decrypt(account.encryptedPayload),
    );
    const copyJson = subscriptionCopy(input.provider, parsed);
    return copyJson === undefined ? undefined : { revision: account.credentialRevision, copyJson };
  });

/** The subscription copy a stored payload makes; `undefined` for a key. */
const subscriptionCopy = (provider: CredentialPushProvider, parsed: unknown) => {
  if (provider === "claude") {
    const payload = parseClaudeCredentialPayload(parsed);
    return "apiKey" in payload ? undefined : claudeCredentialsFile(payload);
  }
  const payload = parseCodexCredentialPayload(parsed);
  return "authJson" in payload && loginClassOf("codex", payload) === "subscription"
    ? codexAuthJsonCopy(payload.authJson)
    : undefined;
};
