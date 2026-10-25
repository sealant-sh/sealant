import { randomUUID } from "node:crypto";

/**
 * The one way logins are written into and removed from a home (docs/connected-accounts-design.md
 * §6c), for a put, a refresh push, a prune and the sweep. Every call runs under the home's lock. A
 * write records its intent before the executor runs it, and what the executor answered after:
 * placements describe the files whether the write lands, is refused, or never answers.
 */
import {
  beginHomeWrite,
  CredentialPlacementRepo,
  removalWork,
  settleHomeWrite,
  settleInDoubt,
  WorkspaceCredentialHomeRepo,
  workspaceCredentialHomeProviderValues,
  type CredentialPlacementHome,
  type HomeState,
  type HomeWriteOutcome,
  type PlannedWrite,
  type WorkspaceCredentialHomeRepoError,
} from "@sealant/db";
import { Duration, Effect, Result, Schema } from "effect";

import {
  buildHomeCredentialScript,
  HOME_CREDENTIAL_FILES,
  HOME_SCRIPT_EXIT,
  homeCredentialProviderOf,
  homeLoginOfRefusal,
  homeLoginsKept,
  homeScriptRefusal,
  homeScriptStdin,
  liveHomeCredentialChannel,
  type HomeCredentialChannel,
  type HomeCredentialProvider,
  type HomeOwner,
} from "../runtime/home-credentials.js";
import type { SealantTarget } from "../sealantd/runtime.js";
import {
  sealantTargetForRuntimeInstance,
  type SealantTargetDerivationOptions,
} from "../sealantd/target.js";

const WRITE_TIMEOUT = Duration.seconds(15);

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export type HomeScriptRun =
  /** Ran to the end; `kept` are the merged logins it left as the person's own. */
  | { readonly kind: "done"; readonly kept: readonly HomeCredentialProvider[] }
  /** The script refused, in words. */
  | { readonly kind: "refused"; readonly exitCode: number; readonly message: string }
  /** No answer, or an exit nobody can read: what it did is not known. */
  | { readonly kind: "unconfirmed"; readonly message: string };

/** Runs one home script with the write timeout, in this fiber: the timeout interrupts the exec. */
export const runHomeScript = (input: {
  readonly channel: HomeCredentialChannel;
  readonly target: SealantTarget;
  readonly home: string;
  readonly script: string;
  readonly stdin?: string;
}): Effect.Effect<HomeScriptRun> =>
  input.channel.run(input.target, input.script, input.stdin ?? "").pipe(
    Effect.timeout(WRITE_TIMEOUT),
    Effect.result,
    Effect.map((ran): HomeScriptRun => {
      if (Result.isFailure(ran)) {
        return { kind: "unconfirmed", message: messageOf(ran.failure, "no answer") };
      }
      const exitCode = ran.success.exitCode;
      const kept = homeLoginsKept(exitCode);
      if (kept !== undefined) return { kind: "done", kept };
      const refusal = homeScriptRefusal(input.home, exitCode);
      return refusal === undefined || exitCode === undefined
        ? { kind: "unconfirmed", message: `the write exited with ${String(exitCode)}` }
        : { kind: "refused", exitCode, message: refusal };
    }),
  );

/**
 * What a refused script wrote before refusing: the whole-file logins are written before any merged
 * one, so a refused pi or opencode login leaves them written; any other refusal wrote nothing.
 */
const landedBeforeRefusal = (
  writes: readonly HomeCredentialProvider[],
  exitCode: number,
): readonly HomeCredentialProvider[] => {
  const refused = homeLoginOfRefusal(exitCode);
  return refused === "pi" || refused === "opencode"
    ? writes.filter(
        (provider) => homeCredentialProviderOf(HOME_CREDENTIAL_FILES[provider]) !== undefined,
      )
    : [];
};

export type HomeWriteResult =
  /** An account left the revision read (or the person) before anything was written. */
  | { readonly kind: "moved" }
  /** `stale`: an account moved past the revision written while it was written. */
  | { readonly kind: "done"; readonly stale: boolean; readonly state: HomeState }
  | {
      readonly kind: "refused";
      readonly exitCode: number;
      readonly message: string;
      readonly state: HomeState;
    }
  | { readonly kind: "unconfirmed"; readonly message: string };

/**
 * Writes logins into a home and removes others, in one exec: placements are recorded `pending`
 * first, then settled on what the executor answered. A first write (`take`) records the home
 * `releasing` until a caller confirms the hold, and removes every login file it does not write.
 */
export const writeIntoHome = (input: {
  readonly key: CredentialPlacementHome;
  readonly onBehalfOfUserId: string;
  readonly target: SealantTarget;
  readonly channel: HomeCredentialChannel;
  readonly nextFence: Effect.Effect<string, WorkspaceCredentialHomeRepoError>;
  readonly fence: { readonly kind: "take" | "held"; readonly generation: string };
  readonly createWithOwner?: HomeOwner;
  readonly writes: ReadonlyArray<PlannedWrite & { readonly content: string }>;
  readonly removes: readonly HomeCredentialProvider[];
}) =>
  Effect.gen(function* () {
    const repo = yield* CredentialPlacementRepo;
    const writes = input.writes.map((write) => ({
      ...write,
      path: `${input.key.home}/${HOME_CREDENTIAL_FILES[write.provider]}`,
    }));
    const begun = yield* repo.transact(
      input.key,
      writes.map((write) => write.accountId),
      (state) => {
        const placements = settleInDoubt(state.placements);
        const began = beginHomeWrite(
          { ...state, placements },
          {
            key: input.key,
            onBehalfOfUserId: input.onBehalfOfUserId,
            writes,
            removes: input.removes,
            newId: () => `cpl_${randomUUID()}`,
          },
        );
        return {
          result: began?.intent,
          placements: began?.placements ?? placements,
          ...(input.fence.kind === "take"
            ? {
                insertHome: {
                  onBehalfOfUserId: input.onBehalfOfUserId,
                  generation: input.fence.generation,
                  releasing: true,
                },
              }
            : {}),
        };
      },
    );
    const intent = begun.result;
    if (intent === undefined) return { kind: "moved" } satisfies HomeWriteResult;
    if (input.fence.kind === "held" && writes.length === 0 && input.removes.length === 0) {
      return { kind: "done", stale: false, state: begun.state } satisfies HomeWriteResult;
    }
    const providers = writes.map((write) => write.provider);
    const ran = yield* runHomeScript({
      channel: input.channel,
      target: input.target,
      home: input.key.home,
      script: buildHomeCredentialScript({
        home: input.key.home,
        fence: input.fence,
        token: yield* input.nextFence,
        ...(input.createWithOwner === undefined ? {} : { createWithOwner: input.createWithOwner }),
        writes: providers,
        removes:
          input.fence.kind === "take"
            ? workspaceCredentialHomeProviderValues.filter(
                (provider) => !providers.includes(provider),
              )
            : input.removes,
      }),
      stdin: homeScriptStdin(writes.map((write) => write.content)),
    });
    const outcome: HomeWriteOutcome =
      ran.kind === "done"
        ? {
            kind: "done",
            written: providers.filter((provider) => !ran.kept.includes(provider)),
            kept: ran.kept,
          }
        : ran.kind === "refused"
          ? { kind: "refused", written: landedBeforeRefusal(providers, ran.exitCode) }
          : { kind: "unconfirmed" };
    if (ran.kind === "unconfirmed") {
      return { kind: "unconfirmed", message: ran.message } satisfies HomeWriteResult;
    }
    const settled = yield* repo.transact(input.key, [], (state) => {
      const { placements, stale } = settleHomeWrite(state, intent, outcome);
      return { result: stale, placements };
    });
    return (
      ran.kind === "done"
        ? { kind: "done", stale: settled.result, state: settled.state }
        : { kind: "refused", exitCode: ran.exitCode, message: ran.message, state: settled.state }
    ) satisfies HomeWriteResult;
  });

/** The executor did not confirm a removal: the placements stay removing, for the sweep. */
export class HomeRemovalUnconfirmedError extends Schema.TaggedError<HomeRemovalUnconfirmedError>()(
  "HomeRemovalUnconfirmedError",
  { message: Schema.String },
) {}

/**
 * Removes the files a home's removing placements leave, and forgets those placements once the
 * executor answers. A releasing home loses every login file and its marker; the caller deletes its
 * row when this answers `true`. Without a target (the executor is gone) there is nothing to remove.
 */
export const removeLeftovers = (input: {
  readonly key: CredentialPlacementHome;
  readonly fence: { readonly generation: string; readonly releasing: boolean };
  readonly target: SealantTarget | undefined;
  readonly channel: HomeCredentialChannel;
  readonly nextFence: Effect.Effect<string, WorkspaceCredentialHomeRepoError>;
}) =>
  Effect.gen(function* () {
    const repo = yield* CredentialPlacementRepo;
    const { result: work } = yield* repo.transact(input.key, [], (state) => {
      const placements = settleInDoubt(state.placements);
      return { result: removalWork(placements), placements };
    });
    const releasing = input.fence.releasing;
    if (input.target !== undefined && (releasing || work.removes.length > 0)) {
      const ran = yield* runHomeScript({
        channel: input.channel,
        target: input.target,
        home: input.key.home,
        script: buildHomeCredentialScript({
          home: input.key.home,
          fence: {
            kind: releasing ? "release" : "held",
            generation: input.fence.generation,
          },
          token: yield* input.nextFence,
          writes: [],
          removes: work.removes,
        }),
      });
      // A missing home has nothing left, and a fenced one is another hold's now: neither has ours.
      const gone =
        ran.kind === "refused" &&
        (ran.exitCode === HOME_SCRIPT_EXIT.missing || ran.exitCode === HOME_SCRIPT_EXIT.fenced);
      if (ran.kind !== "done" && !gone) {
        return yield* new HomeRemovalUnconfirmedError({
          message: `The removal from ${input.key.home} was not confirmed: ${ran.message}`,
        });
      }
    }
    if (releasing) return true;
    yield* repo.transact(input.key, [], (state) => ({
      result: undefined,
      placements: state.placements.filter(
        (row) => !(work.forget.includes(row.id) && row.state === "removing"),
      ),
    }));
    return false;
  });

/** Failed homes are tried again after this, doubling per failure up to `MAX_BACKOFF`. */
const FIRST_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

/** When each home whose removal failed is tried next, by `${runId} ${home}`. */
export type PlacementSweepBackoff = Map<
  string,
  { readonly failures: number; readonly next: number }
>;

/**
 * One pass over the homes with removal work, in instances the sweep can reach or that are gone.
 * A failed home keeps its work and is tried again after a backoff; each attempt logs once.
 */
export const sweepCredentialPlacements = (
  input: {
    readonly targetOptions?: SealantTargetDerivationOptions;
    readonly homeChannel?: HomeCredentialChannel;
    readonly backoff?: PlacementSweepBackoff;
    readonly now?: () => number;
  } = {},
) =>
  Effect.gen(function* () {
    const placements = yield* CredentialPlacementRepo;
    const homes = yield* WorkspaceCredentialHomeRepo;
    const now = input.now?.() ?? Date.now();
    const backoff = input.backoff ?? new Map();
    const due = (yield* placements.targets()).flatMap(({ home, instance }) => {
      const key = `${home.runId} ${home.home}`;
      if ((backoff.get(key)?.next ?? 0) > now) return [];
      const gone =
        instance.status === "stopped" ||
        (instance.status === "failed" && instance.resourceId === null);
      const target = gone
        ? undefined
        : sealantTargetForRuntimeInstance(instance, input.targetOptions ?? {});
      return gone || target !== undefined ? [{ key, home, target }] : [];
    });
    yield* Effect.forEach(
      due,
      ({ key, home, target }) =>
        homes
          .withLockedHome(home, (held, nextFence) =>
            Effect.gen(function* () {
              if (held === undefined)
                return { result: undefined, outcome: { kind: "keep" as const } };
              const released = yield* removeLeftovers({
                key: home,
                fence: { generation: held.generation, releasing: held.releasing },
                target,
                channel: input.homeChannel ?? liveHomeCredentialChannel,
                nextFence,
              });
              return {
                result: undefined,
                outcome: released ? { kind: "release" as const } : { kind: "keep" as const },
              };
            }),
          )
          .pipe(
            Effect.tap(() => Effect.sync(() => backoff.delete(key))),
            Effect.catch((error) => {
              const failures = (backoff.get(key)?.failures ?? 0) + 1;
              const wait = Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
              backoff.set(key, { failures, next: now + wait });
              return Effect.logWarning(
                `Credential removal from ${home.home} of run ${home.runId} was not confirmed (attempt ${String(failures)}); trying again in ${String(Math.round(wait / 1000))} s.`,
                messageOf(error, "unknown failure"),
              );
            }),
          ),
      { concurrency: 4 },
    );
  });
