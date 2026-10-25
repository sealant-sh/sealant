/**
 * What a home's credential placements become under each operation (docs/connected-accounts-design.md
 * §6c). Each rule maps the placements as they are under the home's lock to what they become. The
 * repository persists the difference in one transaction and the in-memory repository applies it, so
 * both follow these rules and nothing else.
 *
 * A provider has one file slot in a home, which at most one placement holds `ready`. `pending` is a
 * write whose outcome is not known; `removing` is a file left for removal.
 */
import type {
  WorkspaceCredentialHome,
  WorkspaceCredentialHomeProvider as Provider,
  WorkspaceCredentialPlacement as Placement,
} from "./schema/workspace-build-jobs.js";

type Placements = readonly Placement[];

export interface PlacementAccount {
  readonly id: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly provider: string;
  readonly revision: number;
  /** Active and not archived: its login may be written. */
  readonly active: boolean;
  /** Archived: every file of its login goes. */
  readonly archived: boolean;
}

export interface HomeState {
  readonly held: WorkspaceCredentialHome | undefined;
  readonly placements: Placements;
  /** Every account the home's placements or the operation name, as stored now. */
  readonly accounts: ReadonlyMap<string, PlacementAccount>;
  /** The accounts the home's person chose as their defaults. */
  readonly defaults: ReadonlySet<string>;
}

/** What one operation leaves: every placement of the home, and its row. */
export interface HomeChange<A> {
  readonly result: A;
  readonly placements: Placements;
  /** Inserts the home's row when it has none. */
  readonly insertHome?: {
    readonly onBehalfOfUserId: string;
    readonly generation: string;
    readonly releasing: boolean;
  };
  readonly releasing?: true;
}

/** The stored login a provider's file is made from: pi's and opencode's are the Codex login. */
const sourceOf = (provider: Provider): string =>
  provider === "pi" || provider === "opencode" ? "codex" : provider;

const removing = (placement: Placement): Placement => ({ ...placement, state: "removing" });

/**
 * Once the home's lock is held, no write into it is in flight: a `pending` placement's slot holds
 * bytes nobody knows, so that placement and the slot's ready one are left for removal.
 */
export const settleInDoubt = (placements: Placements): Placements => {
  const doubtful = new Set(
    placements.filter((row) => row.state === "pending").map((row) => row.provider),
  );
  return placements.map((row) =>
    doubtful.has(row.provider) && row.state !== "removing" ? removing(row) : row,
  );
};

export interface HomeSelection {
  readonly provider: Provider;
  readonly accountId: string;
  /** The account's revision whose bytes are written. */
  readonly revision: number;
}

export interface PlannedWrite extends HomeSelection {
  /** The placement written again: the slot's ready one, or the one a refresh brings up to date. */
  readonly reuse: string | undefined;
}

export interface HomeWrite extends PlannedWrite {
  readonly path: string;
}

export interface HomePutPlan<S extends HomeSelection> {
  readonly writes: ReadonlyArray<S & { readonly reuse: string | undefined }>;
  readonly removes: readonly Provider[];
  /** Live placements whose slot the put leaves as it is. */
  readonly pinned: readonly string[];
}

/**
 * One put: every selection is written and every removed provider's file removed, except in a slot a
 * live placement holds. There a different selection leaves the file as it is (pinned), and a removal
 * never takes it from its process. The slot's ready placement of the same account and revision is
 * written again, so a put repairs a file that went missing.
 */
export const planHomePut = <S extends HomeSelection>(input: {
  readonly placements: Placements;
  /** Absent for a caller that predates live placements: nothing is pinned. */
  readonly live: readonly string[] | undefined;
  readonly selected: readonly S[];
  readonly removed: readonly Provider[];
}): HomePutPlan<S> => {
  const slot = (provider: Provider) =>
    input.placements.find((row) => row.state === "ready" && row.provider === provider);
  const pinnedSlot = (provider: Provider) => {
    const held = slot(provider);
    return held !== undefined && input.live?.includes(held.id) === true ? held : undefined;
  };
  const writes: Array<S & { readonly reuse: string | undefined }> = [];
  const removes: Provider[] = [];
  const pinned: string[] = [];
  for (const selection of input.selected) {
    const held = slot(selection.provider);
    const same =
      held !== undefined &&
      held.accountId === selection.accountId &&
      held.revision === selection.revision;
    const live = pinnedSlot(selection.provider);
    if (live !== undefined && !same) {
      pinned.push(live.id);
      continue;
    }
    writes.push({ ...selection, reuse: same ? held.id : undefined });
  }
  for (const provider of input.removed) {
    const live = pinnedSlot(provider);
    if (live === undefined) removes.push(provider);
    else pinned.push(live.id);
  }
  return { writes, removes, pinned };
};

/** A write in flight, as `settleHomeWrite` needs it. */
export interface HomeWriteIntent {
  readonly writes: ReadonlyArray<{
    readonly provider: Provider;
    readonly id: string;
    readonly revision: number;
    readonly inserted: boolean;
  }>;
  /** Ready placements whose files the write removes. */
  readonly retired: readonly string[];
}

/**
 * Records a write before the executor runs it: each written slot's placement becomes `pending` (a
 * new one, or the one written again) and each removed slot's ready placement `removing`. Undefined
 * when an account is no longer the person's, active, at the revision read, or a placement written
 * again is no longer ready: nothing changes, and the caller reads the accounts again.
 */
export const beginHomeWrite = (
  state: HomeState,
  input: {
    readonly key: { readonly runId: string; readonly home: string };
    readonly onBehalfOfUserId: string;
    readonly writes: readonly HomeWrite[];
    readonly removes: readonly Provider[];
    readonly newId: () => string;
  },
): { readonly placements: Placements; readonly intent: HomeWriteIntent } | undefined => {
  let placements = state.placements;
  const writes: Array<HomeWriteIntent["writes"][number]> = [];
  for (const write of input.writes) {
    const account = state.accounts.get(write.accountId);
    if (
      account?.active !== true ||
      account.revision !== write.revision ||
      account.ownerUserId !== input.onBehalfOfUserId ||
      account.provider !== sourceOf(write.provider)
    ) {
      return undefined;
    }
    if (write.reuse !== undefined) {
      const reused = placements.find((row) => row.id === write.reuse);
      if (reused?.state !== "ready") return undefined;
      placements = placements.map((row) =>
        row.id === write.reuse ? { ...row, state: "pending" } : row,
      );
      writes.push({
        provider: write.provider,
        id: reused.id,
        revision: write.revision,
        inserted: false,
      });
      continue;
    }
    const id = input.newId();
    placements = [
      ...placements,
      {
        id,
        ...input.key,
        provider: write.provider,
        accountId: write.accountId,
        revision: write.revision,
        path: write.path,
        login: { kind: "subscription" },
        state: "pending",
        createdAt: new Date(),
      },
    ];
    writes.push({ provider: write.provider, id, revision: write.revision, inserted: true });
  }
  const retired = placements
    .filter((row) => row.state === "ready" && input.removes.includes(row.provider))
    .map((row) => row.id);
  placements = placements.map((row) => (retired.includes(row.id) ? removing(row) : row));
  return { placements, intent: { writes, retired } };
};

/** How a write's script ended, per provider. */
export type HomeWriteOutcome =
  /** Ran to the end: `written` landed, `kept` found a login of the person's own and left it. */
  | {
      readonly kind: "done";
      readonly written: readonly Provider[];
      readonly kept: readonly Provider[];
    }
  /** Refused part way: `written` landed before the refusal, and no removal ran. */
  | { readonly kind: "refused"; readonly written: readonly Provider[] }
  /** No answer: every pending placement stays pending, for `settleInDoubt`. */
  | { readonly kind: "unconfirmed" };

/**
 * What a write's outcome leaves. A written placement is `ready` at the revision written, unless its
 * account was archived meanwhile (then `removing`), and every other placement of its slot is retired:
 * the file is no longer theirs. A placement written again but not written is as it was; a new one is
 * forgotten. A refusal puts back what the write meant to remove. `stale` when an account moved past
 * the revision written, or was archived while it was written.
 */
export const settleHomeWrite = (
  state: HomeState,
  intent: HomeWriteIntent,
  outcome: HomeWriteOutcome,
): { readonly placements: Placements; readonly stale: boolean } => {
  if (outcome.kind === "unconfirmed") return { placements: state.placements, stale: false };
  const kept = (row: Placement) => state.accounts.get(row.accountId)?.archived === false;
  const written = new Set(outcome.written);
  const preserved = new Set(outcome.kind === "done" ? outcome.kept : []);
  const forget = new Set<string>();
  let stale = false;
  let placements = state.placements;
  for (const write of intent.writes) {
    const landed = written.has(write.provider);
    if (landed || preserved.has(write.provider)) {
      placements = placements.map((row) =>
        row.provider === write.provider && row.id !== write.id && row.state === "ready"
          ? removing(row)
          : row,
      );
    }
    if (landed) {
      placements = placements.map((row) =>
        row.id === write.id
          ? {
              ...row,
              revision: write.revision,
              state: row.state === "pending" && kept(row) ? "ready" : "removing",
            }
          : row,
      );
      const settled = placements.find((row) => row.id === write.id);
      stale ||=
        settled?.state !== "ready" ||
        state.accounts.get(settled.accountId)?.revision !== write.revision;
    } else if (write.inserted) {
      forget.add(write.id);
    } else {
      placements = placements.map((row) =>
        row.id === write.id
          ? {
              ...row,
              state:
                row.state === "pending" && kept(row) && !preserved.has(write.provider)
                  ? "ready"
                  : "removing",
            }
          : row,
      );
    }
  }
  for (const id of intent.retired) {
    if (outcome.kind === "done") forget.add(id);
    else
      placements = placements.map((row) =>
        row.id === id && kept(row) ? { ...row, state: "ready" } : row,
      );
  }
  return { placements: placements.filter((row) => !forget.has(row.id)), stale };
};

/** A release: every placement is left for removal, and the home with them. */
export const releaseHome = (placements: Placements): Placements => placements.map(removing);

/** Every placement neither live nor the ready placement of one of the person's defaults. */
export const pruneHome = (state: HomeState, live: readonly string[]): Placements =>
  state.placements.map((row) =>
    live.includes(row.id) || (row.state === "ready" && state.defaults.has(row.accountId))
      ? row
      : removing(row),
  );

/**
 * The files a home's removing placements leave: each slot whose path no ready placement holds (a
 * newer login written over the same file keeps it). Once removed, `forget` is what goes.
 */
export const removalWork = (
  placements: Placements,
): { readonly removes: readonly Provider[]; readonly forget: readonly string[] } => {
  const held = new Set(placements.filter((row) => row.state === "ready").map((row) => row.path));
  const left = placements.filter((row) => row.state === "removing");
  return {
    removes: [...new Set(left.filter((row) => !held.has(row.path)).map((row) => row.provider))],
    forget: left.map((row) => row.id),
  };
};

/**
 * A launch's logins in the home it took, recorded once it is ready, at each account's revision as
 * stored now. One whose account went meanwhile is left for removal.
 */
export const recordLaunchHome = (
  state: HomeState,
  input: {
    readonly logins: ReadonlyArray<{
      readonly provider: Provider;
      readonly accountId: string;
      readonly path: string;
    }>;
    readonly newId: () => string;
    readonly key: { readonly runId: string; readonly home: string };
  },
): Placements => [
  ...state.placements,
  ...input.logins.map((login): Placement => {
    const account = state.accounts.get(login.accountId);
    return {
      id: input.newId(),
      ...input.key,
      provider: login.provider,
      accountId: login.accountId,
      revision: account?.revision ?? 1,
      path: login.path,
      login: { kind: "subscription" },
      state: account?.archived === false ? "ready" : "removing",
      createdAt: new Date(),
    };
  }),
];
