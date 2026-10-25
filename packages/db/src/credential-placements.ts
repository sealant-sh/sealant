import type { ConnectedAccountStatus } from "./schema/control-plane.js";
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
  readonly status: ConnectedAccountStatus;
}

export const placementAccountStatus = (account: {
  readonly status: ConnectedAccountStatus;
  readonly archivedAt: Date | null;
}): ConnectedAccountStatus => (account.archivedAt === null ? account.status : "archived");

const accountUnarchived = (state: HomeState, accountId: string): boolean => {
  const status = state.accounts.get(accountId)?.status;
  return status !== undefined && status !== "archived";
};

export interface HomeState {
  readonly held: WorkspaceCredentialHome | undefined;
  readonly placements: Placements;
  readonly accounts: ReadonlyMap<string, PlacementAccount>;
  readonly defaults: ReadonlySet<string>;
}

export interface HomeChange<A> {
  readonly result: A;
  readonly placements: Placements;
  readonly insertHome?: {
    readonly onBehalfOfUserId: string;
    readonly generation: string;
    readonly releasing: boolean;
  };
  readonly releasing?: true;
}

const sourceOf = (provider: Provider): string =>
  provider === "pi" || provider === "opencode" ? "codex" : provider;

const removing = (placement: Placement): Placement => ({ ...placement, state: "removing" });

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
  readonly revision: number;
}

export interface PlannedWrite extends HomeSelection {
  readonly reuse: string | undefined;
}

export interface HomeWrite extends PlannedWrite {
  readonly path: string;
}

export interface HomePutPlan<S extends HomeSelection> {
  readonly writes: ReadonlyArray<S & { readonly reuse: string | undefined }>;
  readonly removes: readonly Provider[];
  readonly pinned: readonly string[];
}

export const planHomePut = <S extends HomeSelection>(input: {
  readonly placements: Placements;
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

export interface HomeWriteIntent {
  readonly writes: ReadonlyArray<{
    readonly provider: Provider;
    readonly id: string;
    readonly revision: number;
    readonly inserted: boolean;
  }>;
  readonly retired: readonly string[];
}

export type HomeWriteStart =
  | { readonly kind: "begun"; readonly placements: Placements; readonly intent: HomeWriteIntent }
  | { readonly kind: "accounts-moved" };

export const beginHomeWrite = (
  state: HomeState,
  input: {
    readonly key: { readonly runId: string; readonly home: string };
    readonly onBehalfOfUserId: string;
    readonly writes: readonly HomeWrite[];
    readonly removes: readonly Provider[];
    readonly newId: () => string;
  },
): HomeWriteStart => {
  let placements = state.placements;
  const writes: Array<HomeWriteIntent["writes"][number]> = [];
  for (const write of input.writes) {
    const account = state.accounts.get(write.accountId);
    if (
      account?.status !== "active" ||
      account.revision !== write.revision ||
      account.ownerUserId !== input.onBehalfOfUserId ||
      account.provider !== sourceOf(write.provider)
    ) {
      return { kind: "accounts-moved" };
    }
    if (write.reuse !== undefined) {
      const reused = placements.find((row) => row.id === write.reuse);
      if (reused?.state !== "ready") return { kind: "accounts-moved" };
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
  return { kind: "begun", placements, intent: { writes, retired } };
};

export type HomeWriteOutcome =
  | {
      readonly kind: "done";
      readonly written: readonly Provider[];
      readonly kept: readonly Provider[];
    }
  | { readonly kind: "refused"; readonly written: readonly Provider[] }
  | { readonly kind: "unconfirmed" };

export const settleHomeWrite = (
  state: HomeState,
  intent: HomeWriteIntent,
  outcome: HomeWriteOutcome,
): { readonly placements: Placements; readonly stale: boolean } => {
  if (outcome.kind === "unconfirmed") return { placements: state.placements, stale: false };
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
              state:
                row.state === "pending" && accountUnarchived(state, row.accountId)
                  ? "ready"
                  : "removing",
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
                row.state === "pending" &&
                accountUnarchived(state, row.accountId) &&
                !preserved.has(write.provider)
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
        row.id === id && accountUnarchived(state, row.accountId) ? { ...row, state: "ready" } : row,
      );
  }
  return { placements: placements.filter((row) => !forget.has(row.id)), stale };
};

export const releaseHome = (placements: Placements): Placements => placements.map(removing);

export const pruneHome = (state: HomeState, live: readonly string[]): Placements =>
  state.placements.map((row) =>
    live.includes(row.id) || (row.state === "ready" && state.defaults.has(row.accountId))
      ? row
      : removing(row),
  );

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
      state: accountUnarchived(state, login.accountId) ? "ready" : "removing",
      createdAt: new Date(),
    };
  }),
];
