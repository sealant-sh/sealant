/**
 * A person's logins in one home of a running workspace (docs/connected-accounts-design.md §6c).
 *
 * `POST /v1/workspaces/:id/credentials` puts one person's Claude, Codex and GitHub logins into one
 * home: copies written the way a launch writes them (no Claude refresh token, a placeholder Codex
 * one, GitHub as the CLI's `hosts.yml`), owned by the home's owner, mode 0600, and kept refreshed
 * there. pi's and opencode's ChatGPT logins are made from the person's Codex account and merged
 * into each tool's `auth.json` as one entry, leaving the person's own logins there alone. A home
 * holds one person's logins for as long as it is held: a put naming anyone else is refused
 * (`home-held`), never written over. `DELETE` releases the home (its files are removed and its
 * record deleted), after which the home can be taken again. `GET` lists the homes, and `prune`
 * removes the logins no running process holds.
 *
 * Each login written is a placement, answered as a receipt. A put names the placements running
 * processes hold (`live`): a provider whose file one of them holds is not written over.
 *
 * Every write into a home runs under that home's lock (`WorkspaceCredentialHomeRepo
 * .withLockedHome`), as the refresh push and the sweep do: the decision (who holds it, what it
 * holds) is made on the home as it is under the lock, and no other write into the home lands in
 * between.
 */
import {
  WorkspaceBadGatewayError,
  WorkspaceBadRequestError,
  WorkspaceConflictError,
  WorkspaceForbiddenError,
  WorkspaceInternalServerError,
  WorkspaceNotFoundError,
  WorkspaceServiceUnavailableError,
  connectedAccountRefusalCodes,
  workspaceCredentialHomeAccountProvider,
  workspaceCredentialHomeProviders,
  type ListWorkspaceCredentialsQuery,
  type ListWorkspaceCredentialsResponse,
  type PutWorkspaceCredentialsRequest,
  type PutWorkspaceCredentialsResponse,
  type ReleaseWorkspaceCredentialsQuery,
  type ReleaseWorkspaceCredentialsResponse,
  type WorkspaceCredentialHome,
  type ConnectedAccountRefusalCode,
  type WorkspaceCredentialHomeProvider,
  type WorkspaceCredentialSkip,
  type WorkspaceHomeAccount,
  type WorkspaceCredentialPlacementReceipt,
  type PruneWorkspaceCredentialsRequest,
  type PruneWorkspaceCredentialsResponse,
} from "@sealant/api-contracts";
import {
  chatgptLoginEntry,
  claudeApiKeyUnsupported,
  claudeCredentialsFile,
  codexLoginFile,
  CredentialCipher,
  githubHostsYml,
  parseClaudeCredentialPayload,
  parseCodexCredentialPayload,
  parseGitHubCredentialPayload,
} from "@sealant/credentials";
import {
  CredentialPlacementRepo,
  planHomePut,
  pruneHome,
  releaseHome,
  settleInDoubt,
  WorkspaceCredentialHomeRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type ConnectedAccount,
  type HomeState,
  type WorkspaceCredentialHome as WorkspaceCredentialHomeRow,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import {
  buildHomeCredentialScript,
  homeLoginOfRefusal,
  homePathProblem,
  HOME_SCRIPT_EXIT,
  liveHomeCredentialChannel,
  newHomeGeneration,
  removeLeftovers,
  runHomeScript,
  sealantTargetForRuntimeInstance,
  targetDerivationOptionsFromEnv,
  writeIntoHome,
  type HomeCredentialChannel,
} from "@sealant/workspaces";
import { Duration, Effect, Option, Result, Semaphore } from "effect";

import { env } from "../../runtime-env.js";
import { CurrentPrincipal } from "../../services/service-principals.js";
import { resolveSelectedConnectedAccount } from "./connected-account-selection.js";

/**
 * Locked home writes run at most two at a time per workspace run in this process, each holding a
 * database connection while it writes (or waits for another write into the same home). The limit
 * is per run, so one hung executor holds back only its own workspace's writes, and a write waits
 * for a permit at most `PERMIT_WAIT` before it is answered `home-busy` (retryable).
 */
const PERMITS_PER_RUN = 2;
const PERMIT_WAIT = Duration.seconds(10);
const runPermits = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();

const homeBusy = (home: string) =>
  new WorkspaceConflictError({
    message: `Another write into ${home} is still running; nothing was done. Try again.`,
    code: "home-busy",
  });

export const withRunPermit = <A, E, R>(
  runId: string,
  home: string,
  effect: Effect.Effect<A, E, R>,
  /** For tests; defaults to `PERMIT_WAIT`. */
  permitWait: Duration.Input = PERMIT_WAIT,
): Effect.Effect<A, E | WorkspaceConflictError, R> =>
  Effect.uninterruptibleMask((restore) => {
    const entry = runPermits.get(runId) ?? {
      semaphore: Semaphore.makeUnsafe(PERMITS_PER_RUN),
      users: 0,
    };
    entry.users += 1;
    runPermits.set(runId, entry);
    const leave = Effect.sync(() => {
      entry.users -= 1;
      if (entry.users === 0) runPermits.delete(runId);
    });
    return restore(entry.semaphore.take(1).pipe(Effect.timeoutOption(permitWait))).pipe(
      Effect.flatMap(
        (taken): Effect.Effect<A, E | WorkspaceConflictError, R> =>
          Option.isNone(taken)
            ? Effect.fail(homeBusy(home))
            : restore(effect).pipe(Effect.ensuring(entry.semaphore.release(1))),
      ),
      Effect.ensuring(leave),
    );
  });

/** The home a launch wrote its own logins into when it named none (`$HOME`, root's home). */
const LAUNCH_HOME = "/root";

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const withInternalError = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: string) =>
  effect.pipe(
    Effect.mapError(
      (error) => new WorkspaceInternalServerError({ message: toErrorMessage(error, fallback) }),
    ),
  );

/**
 * Who may write logins into a workspace's homes: only a caller that may act for every person
 * involved. A service key asserts any owner, so it may name both the workspace's owner and the
 * person whose logins are written; the SSH gateway's secret and a user access token act for at most
 * one person and are refused, so a gate change cannot widen them. Mend enforces the rest: a login
 * goes only into its own person's home, or a conversation home while that person's process is
 * about to run there.
 */
const requireServiceKey = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  if (principal.kind === "gateway" || principal.kind === "bearer") {
    return yield* new WorkspaceForbiddenError({
      message:
        "Writing a person's logins into a workspace names two people; only a service key may act for both.",
    });
  }
});

const requireHome = (home: string) => {
  const problem = homePathProblem(home);
  return problem === undefined
    ? Effect.void
    : Effect.fail(new WorkspaceBadRequestError({ message: `Home '${home}': ${problem}` }));
};

/** The owner's workspace and the instance of its latest run (ready or not). */
export const loadInstance = (input: {
  readonly workspaceId: string;
  readonly ownerUserId: string;
}) =>
  Effect.gen(function* () {
    const workspace = yield* withInternalError(
      (yield* WorkspaceRepo).getWorkspaceById(input.workspaceId),
      "Failed to load workspace.",
    );
    if (workspace === undefined || workspace.ownerUserId !== input.ownerUserId) {
      return yield* new WorkspaceNotFoundError({
        message: `Workspace not found: ${input.workspaceId}`,
      });
    }
    const runId = workspace.latestRunId;
    const instance =
      runId === null
        ? undefined
        : yield* withInternalError(
            (yield* WorkspaceRuntimeInstanceRepo).getRuntimeInstanceByRunId(runId),
            "Failed to load the workspace runtime.",
          );
    return { workspace, instance };
  });

export const notRunning = (workspaceId: string) =>
  new WorkspaceConflictError({
    message: `Workspace ${workspaceId} has no running executor.`,
    code: "workspace-not-running",
  });

export const targetFor = (workspaceId: string, instance: WorkspaceRuntimeInstance) => {
  const target = sealantTargetForRuntimeInstance(instance, targetDerivationOptionsFromEnv(env));
  return target === undefined
    ? Effect.fail(
        new WorkspaceServiceUnavailableError({
          message: `Core has no way to reach workspace ${workspaceId}'s executor from here (its control client is not configured for this runtime).`,
        }),
      )
    : Effect.succeed(target);
};

/**
 * A launch that named no home wrote its own logins at `$HOME`, root's home: that home is the
 * launch's for the executor's life, and no put or release may take it from under it.
 */
const requireNotLaunchHome = (
  workspaceId: string,
  home: string,
  instance: WorkspaceRuntimeInstance,
) =>
  home === LAUNCH_HOME &&
  (instance.launchCredentialInjections ?? []).some(
    (entry) => entry.injection === "file" && entry.home === undefined,
  )
    ? Effect.fail(
        new WorkspaceConflictError({
          message: `${home} holds the logins workspace ${workspaceId} was launched with; it is not released while the executor runs.`,
          code: "home-held",
        }),
      )
    : Effect.void;

/**
 * The file one account's login is, as a launch would write it; for pi and opencode, the ChatGPT
 * entry the home script merges into the tool's own `auth.json`.
 */
const loginFileFor = (provider: WorkspaceCredentialHomeProvider, account: ConnectedAccount) =>
  Effect.gen(function* () {
    const accountProvider = workspaceCredentialHomeAccountProvider[provider];
    const cipher = yield* CredentialCipher;
    const plaintext = yield* cipher.decrypt(account.encryptedPayload).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceInternalServerError({
            message: `Connected ${accountProvider} account "${account.name}" could not be decrypted: ${error.message}`,
          }),
      ),
    );
    const unusable = new WorkspaceConflictError({
      message: `Connected ${accountProvider} account "${account.name}" holds an unusable credential — reconnect it.`,
      code: "connected-account-invalid",
      provider: accountProvider,
    });
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(plaintext),
      catch: () => unusable,
    });
    if (provider === "pi" || provider === "opencode") {
      const login = yield* Effect.try({
        try: () => parseCodexCredentialPayload(parsed),
        catch: () => unusable,
      });
      return yield* Effect.try({
        try: () => {
          if ("apiKey" in login) throw new Error("an API key is not a ChatGPT login");
          return chatgptLoginEntry(login.authJson);
        },
        catch: () =>
          new WorkspaceConflictError({
            message: `Connected codex account "${account.name}" is not a ChatGPT login (an API key, or a login with no account id), so it cannot be ${provider}'s login. Nothing was written.`,
            code: "connected-account-unsupported",
            provider: accountProvider,
          }),
      });
    }
    if (provider === "github") {
      return yield* Effect.try({
        try: () => {
          const login = account.metadata?.["login"];
          return githubHostsYml(
            parseGitHubCredentialPayload(parsed).token,
            typeof login === "string" ? login : undefined,
          );
        },
        catch: () => unusable,
      });
    }
    if (provider === "codex") {
      return yield* Effect.try({
        try: () => codexLoginFile(parseCodexCredentialPayload(parsed)),
        catch: () => unusable,
      });
    }
    const claude = yield* Effect.try({
      try: () => parseClaudeCredentialPayload(parsed),
      catch: () => unusable,
    });
    if ("apiKey" in claude) {
      return yield* new WorkspaceConflictError({
        message: claudeApiKeyUnsupported(account.name),
        code: "connected-account-unsupported",
        provider: accountProvider,
      });
    }
    // A setup token too goes in as the file: a home is one person's, a variable is everyone's.
    return yield* Effect.try({ try: () => claudeCredentialsFile(claude), catch: () => unusable });
  });

/** The stable code of a refused account (missing, invalid, unsupported), or `undefined`. */
const accountRefusalOf = (failure: unknown): ConnectedAccountRefusalCode | undefined => {
  if (
    !(failure instanceof WorkspaceNotFoundError) &&
    !(failure instanceof WorkspaceConflictError)
  ) {
    return undefined;
  }
  return connectedAccountRefusalCodes.find((code) => code === failure.code);
};

/** A home as the API shows it: a receipt for each login written there, and each account by name. */
const toHomeView = (
  held: { readonly home: string; readonly onBehalfOfUserId: string },
  state: HomeState,
  pinned: readonly string[] = [],
): WorkspaceCredentialHome => {
  const accounts: Partial<Record<WorkspaceCredentialHomeProvider, WorkspaceHomeAccount>> = {};
  const placements: WorkspaceCredentialPlacementReceipt[] = [];
  for (const row of state.placements) {
    if (row.state !== "ready") continue;
    const account = state.accounts.get(row.accountId);
    // An account that no longer exists (its owner was deleted) cannot be named; it is left out.
    if (account !== undefined) {
      accounts[row.provider] = { connectedAccountId: account.id, name: account.name };
    }
    placements.push({
      provider: row.provider,
      placementId: row.id,
      accountId: row.accountId,
      revision: row.revision,
      login: row.login,
      pinned: pinned.includes(row.id),
    });
  }
  return { home: held.home, onBehalfOfUserId: held.onBehalfOfUserId, accounts, placements };
};

/**
 * Refusals the owner's half answers, after a first take has made its marker: a login directory
 * linking out, a login file unusable (another hard link, a directory there) or really outside.
 */
const OWNER_HALF_REFUSALS: ReadonlySet<number> = new Set([
  HOME_SCRIPT_EXIT.linkOnTheWay,
  HOME_SCRIPT_EXIT.piLoginUnusable,
  HOME_SCRIPT_EXIT.opencodeLoginUnusable,
  HOME_SCRIPT_EXIT.piLoginOutside,
  HOME_SCRIPT_EXIT.opencodeLoginOutside,
  HOME_SCRIPT_EXIT.claudeLoginUnusable,
  HOME_SCRIPT_EXIT.codexLoginUnusable,
  HOME_SCRIPT_EXIT.githubLoginUnusable,
]);

/** Why a refused script is answered as it is: fenced → held, busy → busy, else unusable. */
const refusedCode = (exitCode: number | undefined) =>
  exitCode === HOME_SCRIPT_EXIT.fenced
    ? "home-held"
    : exitCode === HOME_SCRIPT_EXIT.busy
      ? "home-busy"
      : "home-unusable";

export const putWorkspaceCredentials = (input: {
  readonly workspaceId: string;
  readonly payload: PutWorkspaceCredentialsRequest;
  /** For tests; defaults to the live home channel. */
  readonly homeChannel?: HomeCredentialChannel;
}) =>
  Effect.gen(function* () {
    yield* requireServiceKey;
    const payload = input.payload;
    yield* requireHome(payload.home);
    const named = workspaceCredentialHomeProviders.flatMap((provider) => {
      const selection = payload[provider];
      return selection === undefined ? [] : [{ provider, selection }];
    });
    if (named.length === 0) {
      return yield* new WorkspaceBadRequestError({
        message:
          "Name the claude, codex or github account to put into the home, or null to remove one.",
      });
    }
    if ((payload.uid === undefined) !== (payload.gid === undefined)) {
      return yield* new WorkspaceBadRequestError({
        message: "Name both the home's uid and gid, or neither.",
      });
    }
    const createWithOwner =
      payload.uid === undefined || payload.gid === undefined
        ? undefined
        : { uid: payload.uid, gid: payload.gid };
    const toWrite = named.flatMap(({ provider, selection }) =>
      selection === null ? [] : [{ provider, selection }],
    );
    const toRemove = named.flatMap(({ provider, selection }) =>
      selection === null ? [provider] : [],
    );
    const key = env.SEALANT_CREDENTIALS_KEY?.trim();
    if (toWrite.length > 0 && (key === undefined || key.length === 0)) {
      return yield* new WorkspaceServiceUnavailableError({
        message:
          "Writing logins into a workspace requires SEALANT_CREDENTIALS_KEY to be configured.",
      });
    }

    const { workspace, instance } = yield* loadInstance({
      workspaceId: input.workspaceId,
      ownerUserId: payload.ownerUserId,
    });
    if (instance === undefined || instance.status !== "ready") {
      return yield* notRunning(input.workspaceId);
    }
    yield* requireNotLaunchHome(input.workspaceId, payload.home, instance);
    // Root's home serves the workspace's owner alone: processes nobody started run as root.
    if (payload.home === LAUNCH_HOME && payload.onBehalfOfUserId !== workspace.ownerUserId) {
      return yield* new WorkspaceConflictError({
        message: `${LAUNCH_HOME} holds only the workspace owner's logins: processes Mend did not start run as root.`,
        code: "home-held",
      });
    }
    const target = yield* targetFor(input.workspaceId, instance);

    const channel = input.homeChannel ?? liveHomeCredentialChannel;
    const homes = yield* WorkspaceCredentialHomeRepo;
    const placements = yield* CredentialPlacementRepo;
    const homeKey = { runId: instance.runId, home: payload.home };
    const person = payload.onBehalfOfUserId;
    const answer = yield* withRunPermit(
      instance.runId,
      payload.home,
      homes.withLockedHome(homeKey, (held, nextFence) => {
        // A first take that fails leaves nothing of its own in the home: its row goes with it.
        let releaseTake = false;
        const releaseMarker = (generation: string) =>
          Effect.gen(function* () {
            const ran = yield* runHomeScript({
              channel,
              target,
              home: payload.home,
              script: buildHomeCredentialScript({
                home: payload.home,
                fence: { kind: "release", generation },
                token: yield* nextFence,
                writes: [],
                removes: [],
              }),
            });
            if (ran.kind !== "done") return false;
            yield* placements.transact(homeKey, [], () => ({ result: undefined, placements: [] }));
            return true;
          });
        return Effect.gen(function* () {
          if (held !== undefined && held.onBehalfOfUserId !== person) {
            return yield* new WorkspaceConflictError({
              message: `${payload.home} holds another person's logins in workspace ${input.workspaceId}; it is released before anyone else's are put there. Nothing was written.`,
              code: "home-held",
            });
          }
          if (held?.releasing === true) {
            return yield* new WorkspaceConflictError({
              message: `${payload.home} is being released; nothing was written. Try again once the release is done.`,
              code: "home-busy",
            });
          }
          const generation = held?.generation ?? newHomeGeneration();
          let taking = held === undefined;
          // A login file the home refused (unusable, another hard link, really outside it) is left
          // out of a partial put from then on, and its stale login removed with the rest.
          const unusable: WorkspaceCredentialSkip[] = [];
          for (let moves = 0; ; ) {
            // Under the lock: each account resolved and decrypted as it is stored now, so a
            // refresh that persisted while this put waited is what is written.
            const selected: Array<{
              readonly provider: WorkspaceCredentialHomeProvider;
              readonly account: ConnectedAccount;
              readonly content: string;
            }> = [];
            const refused: WorkspaceCredentialSkip[] = [];
            for (const { provider, selection } of toWrite) {
              if (unusable.some((skip) => skip.provider === provider)) continue;
              const resolved = yield* Effect.gen(function* () {
                // pi's and opencode's logins are made from the person's Codex account.
                const account = yield* resolveSelectedConnectedAccount({
                  ownerUserId: person,
                  provider: workspaceCredentialHomeAccountProvider[provider],
                  selection,
                });
                return { provider, account, content: yield* loginFileFor(provider, account) };
              }).pipe(Effect.result);
              if (Result.isSuccess(resolved)) {
                selected.push(resolved.success);
                continue;
              }
              const refusal = accountRefusalOf(resolved.failure);
              if (payload.partial !== true || refusal === undefined) {
                return yield* resolved.failure;
              }
              refused.push({ provider, code: refusal, message: resolved.failure.message });
            }
            const skipped = [...refused, ...unusable];
            const plan = planHomePut({
              placements: settleInDoubt((yield* placements.state(homeKey)).placements),
              live: payload.live,
              selected: selected.map(({ provider, account, content }) => ({
                provider,
                accountId: account.id,
                revision: account.credentialRevision,
                content,
              })),
              removed: [...toRemove, ...skipped.map(({ provider }) => provider)],
            });
            const ran = yield* writeIntoHome({
              key: homeKey,
              onBehalfOfUserId: person,
              target,
              channel,
              nextFence,
              fence: { kind: taking ? "take" : "held", generation },
              ...(createWithOwner === undefined ? {} : { createWithOwner }),
              writes: plan.writes,
              removes: plan.removes,
            });
            if (ran.kind === "moved") {
              moves += 1;
              if (moves < PUT_ROUNDS) continue;
              releaseTake = taking;
              return yield* accountsMoved(payload.home);
            }
            if (ran.kind === "unconfirmed") {
              // An unconfirmed write may still land. A first take releases its hold at once; a
              // later write's slots are left for removal by whoever holds the lock next.
              if (taking) releaseTake = yield* releaseMarker(generation);
              return yield* new WorkspaceBadGatewayError({
                message: `The workspace's executor did not confirm the write into ${payload.home}: ${ran.message}. Core removes whatever of it landed; put again${taking ? "" : ", or release the home"}.`,
              });
            }
            if (ran.kind === "refused") {
              // The owner's half refuses after a first take made its marker: that marker is
              // released, so the home can be taken again once it is fixed, never as `home-held`.
              const marked = taking && OWNER_HALF_REFUSALS.has(ran.exitCode);
              const cleared = marked ? yield* releaseMarker(generation) : !marked;
              const refusedLogin = homeLoginOfRefusal(ran.exitCode);
              if (
                payload.partial === true &&
                refusedLogin !== undefined &&
                plan.writes.some(({ provider }) => provider === refusedLogin)
              ) {
                unusable.push({
                  provider: refusedLogin,
                  code: "login-file-unusable",
                  message: ran.message,
                });
                continue;
              }
              releaseTake = taking && cleared;
              return yield* new WorkspaceConflictError({
                message: `${ran.message} Nothing was written.`,
                code: refusedCode(ran.exitCode),
              });
            }
            taking = false;
            // A login archive cancelled while it was written, or one this write took the slot
            // from, is removed now; failing that, the sweep removes it.
            yield* removeLeftovers({
              key: homeKey,
              fence: { generation, releasing: false },
              target,
              channel,
              nextFence,
            }).pipe(Effect.ignore);
            if (ran.stale) {
              moves += 1;
              if (moves < PUT_ROUNDS) continue;
            }
            return {
              generation,
              skipped,
              home: toHomeView(
                { home: payload.home, onBehalfOfUserId: person },
                yield* placements.state(homeKey),
                plan.pinned,
              ),
            };
          }
        }).pipe(
          Effect.result,
          Effect.map((result) => ({
            result,
            outcome: Result.isSuccess(result)
              ? {
                  kind: "hold" as const,
                  onBehalfOfUserId: person,
                  generation: result.success.generation,
                }
              : releaseTake
                ? { kind: "release" as const }
                : { kind: "keep" as const },
          })),
        );
      }),
    ).pipe(
      Effect.flatMap((result) =>
        Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure),
      ),
      // A lock timeout is busy (retryable); any other repository failure a 500.
      Effect.catchTag("WorkspaceCredentialHomeBusyError", () =>
        Effect.fail(homeBusy(payload.home)),
      ),
      Effect.catchTag(
        ["WorkspaceCredentialHomeRepoError", "CredentialPlacementRepoError"],
        (error) => Effect.fail(new WorkspaceInternalServerError({ message: error.message })),
      ),
    );

    return {
      workspaceId: workspace.id,
      runId: instance.runId,
      home: answer.home,
      ...(payload.partial === true ? { skipped: answer.skipped } : {}),
    } satisfies PutWorkspaceCredentialsResponse;
  });

/**
 * A put writes again when an account's stored bytes move while its copy is written (a refresh or a
 * reconnect). One whose accounts keep moving before anything is written is answered busy.
 */
const PUT_ROUNDS = 3;

const accountsMoved = (home: string) =>
  new WorkspaceConflictError({
    message: `The logins named for ${home} kept changing while they were written (refreshed, reconnected or removed); nothing was written. Try again.`,
    code: "home-busy",
  });

export const releaseWorkspaceCredentials = (input: {
  readonly workspaceId: string;
  readonly query: ReleaseWorkspaceCredentialsQuery;
  /** For tests; defaults to the live home channel. */
  readonly homeChannel?: HomeCredentialChannel;
}) =>
  Effect.gen(function* () {
    yield* requireServiceKey;
    const { home, ownerUserId } = input.query;
    yield* requireHome(home);
    const { workspace, instance } = yield* loadInstance({
      workspaceId: input.workspaceId,
      ownerUserId,
    });
    if (instance === undefined) {
      return yield* notRunning(input.workspaceId);
    }
    const running = instance.status === "ready";
    if (running) yield* requireNotLaunchHome(input.workspaceId, home, instance);
    // A stopped executor took its files with it: only the record is left to delete.
    const target = running ? yield* targetFor(input.workspaceId, instance) : undefined;

    const channel = input.homeChannel ?? liveHomeCredentialChannel;
    const homes = yield* WorkspaceCredentialHomeRepo;
    const placements = yield* CredentialPlacementRepo;
    const key = { runId: instance.runId, home };
    const released = yield* withRunPermit(
      instance.runId,
      home,
      homes.withLockedHome(key, (held: WorkspaceCredentialHomeRow | undefined, nextFence) =>
        Effect.gen(function* () {
          if (target !== undefined) {
            // Every login file Core names is removed, recorded or not (an unconfirmed write may
            // have landed), fenced by the hold's generation: a release that runs late, after the
            // home was taken again, removes nothing of the new holder's. A home Core holds no
            // record of is released whatever its marker says.
            const ran = yield* runHomeScript({
              channel,
              target,
              home,
              script: buildHomeCredentialScript({
                home,
                fence:
                  held === undefined
                    ? { kind: "release" }
                    : { kind: "release", generation: held.generation },
                // A release of a home Core has no record of is unfenced by marker, never by
                // token: a late one finds the mark of every later write and removes nothing.
                token: yield* nextFence,
                writes: [],
                removes: [],
              }),
            });
            const gone = ran.kind === "refused" && ran.exitCode === HOME_SCRIPT_EXIT.missing;
            if (ran.kind === "refused" && !gone) {
              return yield* new WorkspaceConflictError({
                message: `${ran.message} Nothing was removed; the home stays held.`,
                code: refusedCode(ran.exitCode),
              });
            }
            if (ran.kind === "unconfirmed") {
              // It may have landed: the release is committed, and the sweep finishes it.
              if (held !== undefined) {
                yield* placements.transact(key, [], (state) => ({
                  result: undefined,
                  placements: releaseHome(state.placements),
                  releasing: true,
                }));
              }
              return yield* new WorkspaceBadGatewayError({
                message:
                  held === undefined
                    ? `The workspace's executor did not confirm the removal from ${home}: ${ran.message}. Release it again.`
                    : `The workspace's executor did not confirm the removal from ${home}: ${ran.message}. Core finishes the release once the executor answers; nothing is written into the home until then.`,
              });
            }
          }
          return { result: held !== undefined, outcome: { kind: "release" as const } };
        }),
      ),
    ).pipe(
      // A lock timeout is busy (retryable); any other repository failure a 500.
      Effect.catchTag("WorkspaceCredentialHomeBusyError", () => Effect.fail(homeBusy(home))),
      Effect.catchTag(
        ["WorkspaceCredentialHomeRepoError", "CredentialPlacementRepoError"],
        (error) => Effect.fail(new WorkspaceInternalServerError({ message: error.message })),
      ),
    );

    return {
      workspaceId: workspace.id,
      runId: instance.runId,
      home,
      released,
    } satisfies ReleaseWorkspaceCredentialsResponse;
  });

export const listWorkspaceCredentials = (input: {
  readonly workspaceId: string;
  readonly query: ListWorkspaceCredentialsQuery;
}) =>
  Effect.gen(function* () {
    yield* requireServiceKey;
    const { workspace, instance } = yield* loadInstance({
      workspaceId: input.workspaceId,
      ownerUserId: input.query.ownerUserId,
    });
    if (instance === undefined || instance.status !== "ready") {
      return yield* notRunning(input.workspaceId);
    }
    const placements = yield* CredentialPlacementRepo;
    const homes: WorkspaceCredentialHome[] = [];
    for (const row of yield* withInternalError(
      (yield* WorkspaceCredentialHomeRepo).listByRunId(instance.runId),
      "Failed to load the workspace's homes.",
    )) {
      const state = yield* withInternalError(
        placements.state(row),
        "Failed to load the home's logins.",
      );
      homes.push(toHomeView(row, state));
    }
    return {
      workspaceId: workspace.id,
      runId: instance.runId,
      homes,
    } satisfies ListWorkspaceCredentialsResponse;
  });

/**
 * Removes every login of one home that is neither live nor the ready one of the person's default
 * (Mend calls it when a process stops). Running it again changes nothing.
 */
export const pruneWorkspaceCredentials = (input: {
  readonly workspaceId: string;
  readonly payload: PruneWorkspaceCredentialsRequest;
  readonly homeChannel?: HomeCredentialChannel;
}) =>
  Effect.gen(function* () {
    yield* requireServiceKey;
    const { home, live } = input.payload;
    yield* requireHome(home);
    const { workspace, instance } = yield* loadInstance({
      workspaceId: input.workspaceId,
      ownerUserId: input.payload.ownerUserId,
    });
    if (instance?.status !== "ready") return yield* notRunning(input.workspaceId);
    yield* requireNotLaunchHome(input.workspaceId, home, instance);
    const target = yield* targetFor(input.workspaceId, instance);
    const placements = yield* CredentialPlacementRepo;
    const key = { runId: instance.runId, home };
    const pruned = yield* withRunPermit(
      instance.runId,
      home,
      (yield* WorkspaceCredentialHomeRepo).withLockedHome(key, (held, nextFence) =>
        Effect.gen(function* () {
          if (held === undefined) return { result: undefined, outcome: { kind: "keep" as const } };
          yield* placements.transact(key, [], (state) => ({
            result: undefined,
            placements: pruneHome({ ...state, placements: settleInDoubt(state.placements) }, live),
          }));
          const released = yield* removeLeftovers({
            key,
            fence: { generation: held.generation, releasing: held.releasing },
            target,
            channel: input.homeChannel ?? liveHomeCredentialChannel,
            nextFence,
          }).pipe(
            Effect.catchTag("HomeRemovalUnconfirmedError", (error) =>
              Effect.fail(
                new WorkspaceBadGatewayError({
                  message: `${error.message} Core removes them once the executor answers.`,
                }),
              ),
            ),
          );
          return released
            ? { result: undefined, outcome: { kind: "release" as const } }
            : {
                result: toHomeView(held, yield* placements.state(key)),
                outcome: { kind: "keep" as const },
              };
        }),
      ),
    ).pipe(
      Effect.catchTag("WorkspaceCredentialHomeBusyError", () => Effect.fail(homeBusy(home))),
      Effect.catchTag(
        ["WorkspaceCredentialHomeRepoError", "CredentialPlacementRepoError"],
        (error) => Effect.fail(new WorkspaceInternalServerError({ message: error.message })),
      ),
    );
    return {
      workspaceId: workspace.id,
      runId: instance.runId,
      ...(pruned === undefined ? {} : { home: pruned }),
    } satisfies PruneWorkspaceCredentialsResponse;
  });
