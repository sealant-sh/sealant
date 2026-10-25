import { posix } from "node:path";

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
  claudeCredentialsFile,
  codexLoginFile,
  CredentialCipher,
  githubHostsYml,
  parseStoredCredential,
  placedLoginOf,
  type ProviderCredentialPayload,
} from "@sealant/credentials";
import {
  CLAUDE_KEY_DIR,
  CredentialPlacementRepo,
  isClaudeKey,
  planHomePut,
  pruneHome,
  releaseHome,
  settleInDoubt,
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceCredentialHomeRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type ConnectedAccount,
  type HomeState,
  type WorkspaceCredentialHome as WorkspaceCredentialHomeRow,
  type WorkspaceCredentialPlacementLogin,
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

const pathsOverlap = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * Why a Claude key cannot be placed in `home`, or `undefined` when it can: never in the launch
 * home, whose `.claude` the shared layout links into saved state, and never where the run saves
 * state (its working directory, a capture's harness home). A run whose spec Core cannot read is
 * refused: nothing says where it saves.
 */
const claudeKeyHomeProblem = (runId: string, home: string) =>
  Effect.gen(function* () {
    if (home === LAUNCH_HOME) {
      return `${LAUNCH_HOME} is the launch's home, whose .claude the shared layout links into saved state; a Claude API key is placed only in a person's own home.`;
    }
    const snapshot = yield* withInternalError(
      (yield* WorkspaceAttemptRepo).getAttemptSnapshotByRunId(runId),
      "Failed to load the workspace attempt snapshot.",
    );
    const spec =
      snapshot?.resolvedSpecPayload ??
      (yield* withInternalError(
        (yield* WorkspaceBuildJobRepo).getLatestJobByRunId(runId),
        "Failed to load the latest workspace build job.",
      ))?.requestPayload;
    if (spec === undefined) {
      return `Core has no recorded spec for run ${runId}, so it cannot tell where the run saves state; a Claude API key is placed only where nothing saves it.`;
    }
    const source = spec.sources.workspace;
    const keys = `${home}/${CLAUDE_KEY_DIR}`;
    const saved = [
      spec.runtime.workingDirectory,
      ...(source.kind === "capture" && source.harnessHome !== undefined
        ? [source.harnessHome]
        : []),
    ]
      .map((root) => posix.normalize(root).replace(/\/+$/, "") || "/")
      .find((root) => pathsOverlap(keys, root));
    return saved === undefined
      ? undefined
      : `${keys} lies in ${saved}, which the workspace saves; a Claude API key is placed only where nothing saves it.`;
  });

const homeLoginFor = <E, R>(
  provider: WorkspaceCredentialHomeProvider,
  account: ConnectedAccount,
  keyHomeProblem: Effect.Effect<string | undefined, E, R>,
) =>
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
    const credential = yield* Effect.try({
      try: () => parseStoredCredential(accountProvider, plaintext),
      catch: () => unusable,
    });
    const login = yield* Effect.try({
      try: () => placedLoginOf(...credential),
      catch: () => unusable,
    });
    const [, payload] = credential;
    if (provider === "pi" || provider === "opencode") {
      return yield* Effect.try({
        try: () => {
          if ("apiKey" in payload || !("authJson" in payload)) {
            throw new Error("an API key is not a ChatGPT login");
          }
          return { content: chatgptLoginEntry(payload.authJson), login };
        },
        catch: () =>
          new WorkspaceConflictError({
            message: `Connected codex account "${account.name}" is not a ChatGPT login (an API key, or a login with no account id), so it cannot be ${provider}'s login. Nothing was written.`,
            code: "connected-account-unsupported",
            provider: accountProvider,
          }),
      });
    }
    if (isClaudeKey({ provider, login })) {
      const problem = yield* keyHomeProblem;
      if (problem !== undefined) {
        return yield* new WorkspaceConflictError({
          message: `Connected claude account "${account.name}" holds an API key. ${problem} Nothing was written.`,
          code: "connected-account-unsupported",
          provider: accountProvider,
        });
      }
    }
    return yield* Effect.try({
      try: () => ({ content: homeLoginFile(credential, account), login }),
      catch: () => unusable,
    });
  });

const homeLoginFile = (
  credential: ProviderCredentialPayload,
  account: ConnectedAccount,
): string => {
  const [provider, payload] = credential;
  switch (provider) {
    case "github": {
      const login = account.metadata?.["login"];
      return githubHostsYml(payload.token, typeof login === "string" ? login : undefined);
    }
    case "codex":
      return codexLoginFile(payload);
    case "claude":
      return "apiKey" in payload ? payload.apiKey : claudeCredentialsFile(payload);
  }
};

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
    if (account !== undefined) {
      accounts[row.provider] = { connectedAccountId: account.id, name: account.name };
    }
    placements.push({
      provider: row.provider,
      placementId: row.id,
      accountId: row.accountId,
      revision: row.revision,
      login: isClaudeKey(row) ? { ...row.login, keyPath: row.path } : row.login,
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
  HOME_SCRIPT_EXIT.claudeKeyUnusable,
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
    const keyHomeProblem = yield* Effect.cached(claudeKeyHomeProblem(instance.runId, payload.home));
    const answer = yield* withRunPermit(
      instance.runId,
      payload.home,
      homes.withLockedHome(homeKey, (held, nextFence) => {
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
          const unusable: WorkspaceCredentialSkip[] = [];
          for (let revisionMoves = 0; ; ) {
            const selected: Array<{
              readonly provider: WorkspaceCredentialHomeProvider;
              readonly account: ConnectedAccount;
              readonly content: string;
              readonly login: WorkspaceCredentialPlacementLogin;
            }> = [];
            const refused: WorkspaceCredentialSkip[] = [];
            for (const { provider, selection } of toWrite) {
              if (unusable.some((skip) => skip.provider === provider)) continue;
              const resolved = yield* Effect.gen(function* () {
                const account = yield* resolveSelectedConnectedAccount({
                  ownerUserId: person,
                  provider: workspaceCredentialHomeAccountProvider[provider],
                  selection,
                });
                return {
                  provider,
                  account,
                  ...(yield* homeLoginFor(provider, account, keyHomeProblem)),
                };
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
              selected: selected.map(({ provider, account, content, login }) => ({
                provider,
                accountId: account.id,
                revision: account.credentialRevision,
                login,
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
              keptKeys: plan.keptKeys,
              removes: plan.removes,
              removedKeys: plan.removedKeys,
            });
            if (ran.kind === "moved") {
              revisionMoves += 1;
              if (revisionMoves < MAX_PUT_RESOLUTIONS_WHILE_REVISIONS_MOVE) continue;
              return putFailed(accountsMoved(payload.home), taking ? "release" : "keep");
            }
            if (ran.kind === "unconfirmed") {
              const markerReleased = taking && (yield* releaseMarker(generation));
              return putFailed(
                new WorkspaceBadGatewayError({
                  message: `The workspace's executor did not confirm the write into ${payload.home}: ${ran.message}. Core removes whatever of it landed; put again${taking ? "" : ", or release the home"}.`,
                }),
                markerReleased ? "release" : "keep",
              );
            }
            if (ran.kind === "refused") {
              const takeMadeMarker = taking && OWNER_HALF_REFUSALS.has(ran.exitCode);
              const noMarkerLeft = takeMadeMarker ? yield* releaseMarker(generation) : true;
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
              return putFailed(
                new WorkspaceConflictError({
                  message: `${ran.message} Nothing was written.`,
                  code: refusedCode(ran.exitCode),
                }),
                taking && noMarkerLeft ? "release" : "keep",
              );
            }
            taking = false;
            yield* removeLeftovers({
              key: homeKey,
              fence: { generation, releasing: false },
              target,
              channel,
              nextFence,
            }).pipe(Effect.ignore);
            if (ran.stale) {
              revisionMoves += 1;
              if (revisionMoves < MAX_PUT_RESOLUTIONS_WHILE_REVISIONS_MOVE) continue;
            }
            return putWritten({
              generation,
              skipped,
              home: toHomeView(
                { home: payload.home, onBehalfOfUserId: person },
                yield* placements.state(homeKey),
                plan.pinned,
              ),
            });
          }
        }).pipe(
          Effect.result,
          Effect.map((ended) => ({
            result: Result.flatMap(
              ended,
              (end): Result.Result<PutAnswer, PutFailure> =>
                end.kind === "written" ? Result.succeed(end.answer) : Result.fail(end.error),
            ),
            outcome: Result.isFailure(ended)
              ? { kind: "keep" as const }
              : ended.success.kind === "written"
                ? {
                    kind: "hold" as const,
                    onBehalfOfUserId: person,
                    generation: ended.success.answer.generation,
                  }
                : { kind: ended.success.home },
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

const MAX_PUT_RESOLUTIONS_WHILE_REVISIONS_MOVE = 3;

interface PutAnswer {
  readonly generation: string;
  readonly skipped: readonly WorkspaceCredentialSkip[];
  readonly home: WorkspaceCredentialHome;
}

type PutFailure = WorkspaceConflictError | WorkspaceBadGatewayError;

type PutEnd =
  | { readonly kind: "written"; readonly answer: PutAnswer }
  | { readonly kind: "failed"; readonly error: PutFailure; readonly home: "release" | "keep" };

const putWritten = (answer: PutAnswer): PutEnd => ({ kind: "written", answer });

const putFailed = (error: PutFailure, home: "release" | "keep"): PutEnd => ({
  kind: "failed",
  error,
  home,
});

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
            const ran = yield* runHomeScript({
              channel,
              target,
              home,
              script: buildHomeCredentialScript({
                home,
                fence:
                  held === undefined
                    ? { kind: "release-unfenced" }
                    : { kind: "release", generation: held.generation },
                token: yield* nextFence,
                writes: [],
                removes: [],
              }),
            });
            const homeMissing = ran.kind === "refused" && ran.exitCode === HOME_SCRIPT_EXIT.missing;
            if (ran.kind === "refused" && !homeMissing) {
              return yield* new WorkspaceConflictError({
                message: `${ran.message} Nothing was removed; the home stays held.`,
                code: refusedCode(ran.exitCode),
              });
            }
            if (ran.kind === "unconfirmed") {
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
          const removal = yield* removeLeftovers({
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
          return removal.kind === "home-emptied"
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
