/**
 * A person's logins in one home of a running workspace (docs/connected-accounts-design.md §6c).
 *
 * `POST /v1/workspaces/:id/credentials` puts one person's Claude, Codex and GitHub logins into one
 * home: copies written the way a launch writes them (no Claude refresh token, a placeholder Codex
 * one, GitHub as the CLI's `hosts.yml`), owned by the home's owner, mode 0600, and kept refreshed
 * there. A home holds one person's logins for as long as it is held: a put naming anyone else is
 * refused (`home-held`), never written over. `DELETE` releases the home (its files are removed and
 * its record deleted), after which the home can be taken again. `GET` lists the homes.
 *
 * Every write into a home runs under that home's row lock (`WorkspaceCredentialHomeRepo
 * .withLockedHome`), as the refresh push does: the decision (who holds it, what it holds) is made on
 * the row as it is under the lock, and no other write into the home lands in between.
 */
import {
  WorkspaceBadGatewayError,
  WorkspaceBadRequestError,
  WorkspaceConflictError,
  WorkspaceForbiddenError,
  WorkspaceInternalServerError,
  WorkspaceNotFoundError,
  WorkspaceServiceUnavailableError,
  workspaceCredentialHomeProviders,
  type ListWorkspaceCredentialsQuery,
  type ListWorkspaceCredentialsResponse,
  type PutWorkspaceCredentialsRequest,
  type PutWorkspaceCredentialsResponse,
  type ReleaseWorkspaceCredentialsQuery,
  type ReleaseWorkspaceCredentialsResponse,
  type WorkspaceCredentialHome,
  type WorkspaceCredentialHomeProvider,
  type WorkspaceHomeAccount,
} from "@sealant/api-contracts";
import {
  CredentialCipher,
  githubHostsYml,
  parseClaudeCredentialPayload,
  parseCodexCredentialPayload,
  parseGitHubCredentialPayload,
  planCredentialInjections,
  type CredentialInjection,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  WorkspaceCredentialHomeRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type ConnectedAccount,
  type WorkspaceCredentialHome as WorkspaceCredentialHomeRow,
  type WorkspaceCredentialHomeAccount,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import {
  buildHomeCredentialScript,
  homePathProblem,
  homeScriptRefusal,
  HOME_SCRIPT_EXIT,
  homeScriptStdin,
  liveHomeCredentialChannel,
  newHomeGeneration,
  sealantTargetForRuntimeInstance,
  targetDerivationOptionsFromEnv,
  type HomeCredentialChannel,
  type SealantTarget,
} from "@sealant/workspaces";
import { Duration, Effect, Result, Semaphore } from "effect";

import { env } from "../../runtime-env.js";
import { CurrentPrincipal } from "../../services/service-principals.js";
import { resolveSelectedConnectedAccount } from "./connected-account-selection.js";

const WRITE_TIMEOUT = Duration.seconds(15);

/**
 * At most this many locked home writes at once in this process: each holds a database connection
 * while it writes (or waits for another write into the same home), and the API's pool is shared.
 */
const homeWrites = Semaphore.makeUnsafe(4);

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
const loadInstance = (input: { readonly workspaceId: string; readonly ownerUserId: string }) =>
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

const notRunning = (workspaceId: string) =>
  new WorkspaceConflictError({
    message: `Workspace ${workspaceId} has no running executor.`,
    code: "workspace-not-running",
  });

const targetFor = (workspaceId: string, instance: WorkspaceRuntimeInstance) => {
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
  (instance.launchCredentialInjections ?? []).some((entry) => entry.injection === "file")
    ? Effect.fail(
        new WorkspaceConflictError({
          message: `${home} holds the logins workspace ${workspaceId} was launched with; it is not released while the executor runs.`,
          code: "home-held",
        }),
      )
    : Effect.void;

/** Runs one home script with the write timeout; a refusal the script answered is a 409. */
const runHomeScript = (input: {
  readonly channel: HomeCredentialChannel;
  readonly target: SealantTarget;
  readonly home: string;
  readonly script: string;
  readonly stdin?: string;
}) =>
  Effect.gen(function* () {
    // In this fiber: the timeout interrupts the exec itself, not only the wait for it.
    const ran = yield* input.channel
      .run(input.target, input.script, input.stdin ?? "")
      .pipe(Effect.timeout(WRITE_TIMEOUT), Effect.result);
    if (Result.isFailure(ran)) {
      return { kind: "unconfirmed" as const, message: toErrorMessage(ran.failure, "no answer") };
    }
    if (ran.success.exitCode === 0) return { kind: "done" as const };
    const refusal = homeScriptRefusal(input.home, ran.success.exitCode);
    if (refusal !== undefined) {
      return { kind: "refused" as const, exitCode: ran.success.exitCode, message: refusal };
    }
    return {
      kind: "unconfirmed" as const,
      message: `the write exited with ${String(ran.success.exitCode)}`,
    };
  });

/** The file one account's login is, as a launch would write it. */
const loginFileFor = (provider: WorkspaceCredentialHomeProvider, account: ConnectedAccount) =>
  Effect.gen(function* () {
    const cipher = yield* CredentialCipher;
    const plaintext = yield* cipher.decrypt(account.encryptedPayload).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceInternalServerError({
            message: `Connected ${provider} account "${account.name}" could not be decrypted: ${error.message}`,
          }),
      ),
    );
    return yield* Effect.try({
      try: () => {
        const parsed: unknown = JSON.parse(plaintext);
        if (provider === "github") {
          const login = account.metadata?.["login"];
          return githubHostsYml(
            parseGitHubCredentialPayload(parsed).token,
            typeof login === "string" ? login : undefined,
          );
        }
        const planned: readonly CredentialInjection[] =
          provider === "claude"
            ? planCredentialInjections("claude", parseClaudeCredentialPayload(parsed))
            : planCredentialInjections("codex", parseCodexCredentialPayload(parsed));
        const file = planned.find((injection) => injection.kind === "file");
        if (file === undefined) throw new Error("no credential file");
        return Buffer.from(file.contentBase64, "base64").toString("utf8");
      },
      catch: () =>
        new WorkspaceConflictError({
          message: `Connected ${provider} account "${account.name}" holds an unusable credential — reconnect it.`,
          code: "connected-account-invalid",
        }),
    });
  });

/** A home row as the API shows it, each account named as it is now. */
const toHomeView = (row: {
  readonly home: string;
  readonly onBehalfOfUserId: string;
  readonly accounts: readonly WorkspaceCredentialHomeAccount[];
}) =>
  Effect.gen(function* () {
    const repo = yield* ConnectedAccountRepo;
    const accounts: Partial<Record<WorkspaceCredentialHomeProvider, WorkspaceHomeAccount>> = {};
    for (const entry of row.accounts) {
      const account = yield* withInternalError(
        repo.getById(entry.connectedAccountId),
        "Failed to load connected account.",
      );
      // A row that no longer exists (its owner was deleted) cannot be named; it is left out.
      if (account === undefined) continue;
      accounts[entry.provider] = { connectedAccountId: account.id, name: account.name };
    }
    return {
      home: row.home,
      onBehalfOfUserId: row.onBehalfOfUserId,
      accounts,
    } satisfies WorkspaceCredentialHome;
  });

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
    const target = yield* targetFor(input.workspaceId, instance);

    // Resolve every account and prepare every file before the home is locked: a refusal for one
    // provider leaves the home as it was.
    const writes: Array<{
      readonly provider: WorkspaceCredentialHomeProvider;
      readonly account: ConnectedAccount;
      readonly content: string;
    }> = [];
    for (const { provider, selection } of toWrite) {
      const account = yield* resolveSelectedConnectedAccount({
        ownerUserId: payload.onBehalfOfUserId,
        provider,
        selection,
      });
      writes.push({ provider, account, content: yield* loginFileFor(provider, account) });
    }

    const channel = input.homeChannel ?? liveHomeCredentialChannel;
    const homes = yield* WorkspaceCredentialHomeRepo;
    const written = yield* homeWrites
      .withPermit(
        homes.withLockedHome({ runId: instance.runId, home: payload.home }, (held) =>
          Effect.gen(function* () {
            if (held !== undefined && held.onBehalfOfUserId !== payload.onBehalfOfUserId) {
              return yield* new WorkspaceConflictError({
                message: `${payload.home} holds another person's logins in workspace ${input.workspaceId}; it is released before anyone else's are put there. Nothing was written.`,
                code: "home-held",
              });
            }
            // A first take writes a fresh marker and clears any login file it does not write (an
            // earlier unconfirmed write's leftovers); a write under a hold checks the hold's marker.
            const generation = held?.generation ?? newHomeGeneration();
            const writing = writes.map(({ provider }) => provider);
            const ran = yield* runHomeScript({
              channel,
              target,
              home: payload.home,
              script: buildHomeCredentialScript({
                home: payload.home,
                fence:
                  held === undefined ? { kind: "take", generation } : { kind: "held", generation },
                writes: writing,
                removes:
                  held === undefined
                    ? workspaceCredentialHomeProviders.filter(
                        (provider) => !writing.includes(provider),
                      )
                    : toRemove,
              }),
              stdin: homeScriptStdin(writes.map(({ content }) => content)),
            });
            if (ran.kind === "refused") {
              return yield* new WorkspaceConflictError({
                message: `${ran.message} Nothing was written.`,
                code: ran.exitCode === HOME_SCRIPT_EXIT.fenced ? "home-held" : "home-unusable",
              });
            }
            if (ran.kind === "unconfirmed") {
              // An unconfirmed write may still land. A home that held nothing must not keep a login
              // nobody records: release it, once, before answering. A late take that lands after
              // that finds no marker and writes; the next take then finds its marker and is refused
              // until the home is released, so nobody else's process ever runs on it.
              if (held === undefined) {
                yield* runHomeScript({
                  channel,
                  target,
                  home: payload.home,
                  script: buildHomeCredentialScript({
                    home: payload.home,
                    fence: { kind: "release" },
                    writes: [],
                    removes: [],
                  }),
                });
              }
              return yield* new WorkspaceBadGatewayError({
                message: `The workspace's executor did not confirm the write into ${payload.home}: ${ran.message}. The home's record is unchanged${held === undefined ? " (it holds nothing)" : ""}; put again, or release it.`,
              });
            }
            const changed = new Set<WorkspaceCredentialHomeProvider>([
              ...toRemove,
              ...writes.map(({ provider }) => provider),
            ]);
            const accounts: WorkspaceCredentialHomeAccount[] = [
              ...(held?.accounts ?? []).filter((entry) => !changed.has(entry.provider)),
              ...writes.map(({ provider, account }) => ({
                provider,
                connectedAccountId: account.id,
              })),
            ];
            return {
              result: { home: payload.home, onBehalfOfUserId: payload.onBehalfOfUserId, accounts },
              outcome: {
                kind: "hold" as const,
                onBehalfOfUserId: payload.onBehalfOfUserId,
                accounts,
                generation,
              },
            };
          }),
        ),
      )
      .pipe(
        Effect.catchTag("WorkspaceCredentialHomeRepoError", (error) =>
          Effect.fail(new WorkspaceInternalServerError({ message: error.message })),
        ),
      );

    return {
      workspaceId: workspace.id,
      runId: instance.runId,
      home: yield* toHomeView(written),
    } satisfies PutWorkspaceCredentialsResponse;
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
    const released = yield* homeWrites
      .withPermit(
        homes.withLockedHome(
          { runId: instance.runId, home },
          (held: WorkspaceCredentialHomeRow | undefined) =>
            Effect.gen(function* () {
              if (target !== undefined) {
                // Every login file Core names is removed, recorded or not: a write that was never
                // confirmed may have landed.
                const ran = yield* runHomeScript({
                  channel,
                  target,
                  home,
                  script: buildHomeCredentialScript({
                    home,
                    fence: { kind: "release" },
                    writes: [],
                    removes: [],
                  }),
                });
                const gone = ran.kind === "refused" && ran.exitCode === HOME_SCRIPT_EXIT.missing;
                if (ran.kind === "refused" && !gone) {
                  return yield* new WorkspaceConflictError({
                    message: `${ran.message} Nothing was removed; the home stays held.`,
                    code: "home-unusable",
                  });
                }
                if (ran.kind === "unconfirmed") {
                  return yield* new WorkspaceBadGatewayError({
                    message: `The workspace's executor did not confirm the removal from ${home}: ${ran.message}. The home stays held; release it again.`,
                  });
                }
              }
              return { result: held !== undefined, outcome: { kind: "release" as const } };
            }),
        ),
      )
      .pipe(
        Effect.catchTag("WorkspaceCredentialHomeRepoError", (error) =>
          Effect.fail(new WorkspaceInternalServerError({ message: error.message })),
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
    const rows = yield* withInternalError(
      (yield* WorkspaceCredentialHomeRepo).listByRunId(instance.runId),
      "Failed to load the workspace's homes.",
    );
    const homes: WorkspaceCredentialHome[] = [];
    for (const row of rows) homes.push(yield* toHomeView(row));
    return {
      workspaceId: workspace.id,
      runId: instance.runId,
      homes,
    } satisfies ListWorkspaceCredentialsResponse;
  });
