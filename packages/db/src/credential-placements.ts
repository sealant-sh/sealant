import type { ConnectedAccountStatus } from "./schema/control-plane.js";
import type {
  WorkspaceCredentialHome,
  WorkspaceCredentialHomeProvider as Provider,
  WorkspaceCredentialPlacement as Placement,
  WorkspaceCredentialPlacementLogin as Login,
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

/**
 * Where a home's Claude keys live, relative to the home: Sealant's own directory, never under a
 * harness's config directory, which a dotfiles checkout or the shared layout may link elsewhere.
 */
export const CLAUDE_KEY_DIR = ".sealant/keys";

export const isClaudeKey = <L extends { readonly provider: Provider; readonly login: Login }>(
  placed: L,
): placed is L & {
  readonly provider: "claude";
  readonly login: Extract<Login, { readonly kind: "api-key" }>;
} => placed.provider === "claude" && placed.login.kind === "api-key";

export const settleInDoubt = (placements: Placements): Placements => {
  const doubtful = new Set(
    placements.filter((row) => row.state === "pending").map((row) => row.path),
  );
  return placements.map((row) =>
    doubtful.has(row.path) && row.state !== "removing" ? removing(row) : row,
  );
};

export interface HomeSelection {
  readonly provider: Provider;
  readonly accountId: string;
  readonly revision: number;
  readonly login: Login;
}

export interface PlannedWrite extends HomeSelection {
  readonly reuse: string | undefined;
}

export interface HomeWrite extends PlannedWrite {
  readonly id: string;
  readonly path: string;
}

export interface HomePutPlan<S extends HomeSelection> {
  readonly writes: ReadonlyArray<S & { readonly reuse: string | undefined }>;
  /**
   * Ready Claude key placements of the selected login, left ready as they are: a key file is
   * immutable, so a put only restores one that went missing.
   */
  readonly keptKeys: ReadonlyArray<S & { readonly id: string }>;
  readonly removes: readonly Provider[];
  readonly removedKeys: readonly string[];
  readonly pinned: readonly string[];
}

const sameLogin = (row: Placement, selection: HomeSelection) =>
  row.accountId === selection.accountId && row.revision === selection.revision;

export const planHomePut = <S extends HomeSelection>(input: {
  readonly placements: Placements;
  readonly live: readonly string[] | undefined;
  readonly selected: readonly S[];
  readonly removed: readonly Provider[];
}): HomePutPlan<S> => {
  const ready = input.placements.filter((row) => row.state === "ready");
  const live = (row: Placement) => input.live?.includes(row.id) === true;
  const slot = (provider: Provider) =>
    ready.find((row) => row.provider === provider && !isClaudeKey(row));
  const writes: Array<S & { readonly reuse: string | undefined }> = [];
  const keptKeys: Array<S & { readonly id: string }> = [];
  const removes: Provider[] = [];
  const removedKeys: string[] = [];
  const pinned: string[] = [];
  for (const selection of input.selected) {
    if (isClaudeKey(selection)) {
      const same = ready.find((row) => isClaudeKey(row) && sameLogin(row, selection));
      if (same === undefined) writes.push({ ...selection, reuse: undefined });
      else keptKeys.push({ ...selection, id: same.id });
      continue;
    }
    const held = slot(selection.provider);
    const same = held !== undefined && sameLogin(held, selection);
    if (held !== undefined && live(held) && !same) {
      pinned.push(held.id);
      continue;
    }
    writes.push({ ...selection, reuse: same ? held.id : undefined });
  }
  for (const provider of input.removed) {
    const held = slot(provider);
    if (held !== undefined && live(held)) pinned.push(held.id);
    else removes.push(provider);
    for (const row of ready) {
      if (row.provider === provider && isClaudeKey(row) && !live(row)) removedKeys.push(row.id);
    }
  }
  return { writes, keptKeys, removes, removedKeys, pinned };
};

export interface HomeWriteIntent {
  readonly writes: ReadonlyArray<{
    readonly provider: Provider;
    readonly id: string;
    readonly path: string;
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
    readonly keptKeys?: ReadonlyArray<HomeSelection & { readonly id: string }>;
    readonly removes: readonly Provider[];
    readonly removedKeys: readonly string[];
  },
): HomeWriteStart => {
  let placements = state.placements;
  const writes: Array<HomeWriteIntent["writes"][number]> = [];
  const moved = (write: HomeSelection) => {
    const account = state.accounts.get(write.accountId);
    return (
      account?.status !== "active" ||
      account.revision !== write.revision ||
      account.ownerUserId !== input.onBehalfOfUserId ||
      account.provider !== sourceOf(write.provider)
    );
  };
  for (const kept of input.keptKeys ?? []) {
    const row = placements.find((candidate) => candidate.id === kept.id);
    if (moved(kept) || row?.state !== "ready" || !sameLogin(row, kept)) {
      return { kind: "accounts-moved" };
    }
  }
  for (const write of input.writes) {
    if (moved(write)) return { kind: "accounts-moved" };
    if (write.reuse !== undefined) {
      const reused = placements.find((row) => row.id === write.reuse);
      if (reused?.state !== "ready") return { kind: "accounts-moved" };
      placements = placements.map((row) =>
        row.id === write.reuse ? { ...row, state: "pending" } : row,
      );
      writes.push({
        provider: write.provider,
        id: reused.id,
        path: reused.path,
        revision: write.revision,
        inserted: false,
      });
      continue;
    }
    placements = [
      ...placements,
      {
        id: write.id,
        ...input.key,
        provider: write.provider,
        accountId: write.accountId,
        revision: write.revision,
        path: write.path,
        login: write.login,
        state: "pending",
        createdAt: new Date(),
      },
    ];
    writes.push({
      provider: write.provider,
      id: write.id,
      path: write.path,
      revision: write.revision,
      inserted: true,
    });
  }
  const retired = placements
    .filter(
      (row) =>
        row.state === "ready" &&
        (isClaudeKey(row)
          ? input.removedKeys.includes(row.id)
          : input.removes.includes(row.provider)),
    )
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
        row.path === write.path && row.id !== write.id && row.state === "ready"
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
    live.includes(row.id) ||
    (row.state === "ready" &&
      state.defaults.has(row.accountId) &&
      state.accounts.get(row.accountId)?.revision === row.revision)
      ? row
      : removing(row),
  );

export const removalWork = (
  placements: Placements,
): {
  readonly removes: readonly Provider[];
  readonly removedKeys: readonly string[];
  readonly forget: readonly string[];
} => {
  const held = new Set(placements.filter((row) => row.state === "ready").map((row) => row.path));
  const left = placements.filter((row) => row.state === "removing");
  const unheld = left.filter((row) => !held.has(row.path));
  return {
    removes: [...new Set(unheld.filter((row) => !isClaudeKey(row)).map((row) => row.provider))],
    removedKeys: unheld.filter(isClaudeKey).map((row) => row.id),
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
      readonly login: Login;
      readonly revision: number;
    }>;
    readonly newId: () => string;
    readonly key: { readonly runId: string; readonly home: string };
  },
): Placements => [
  ...state.placements,
  ...input.logins.map(
    (login): Placement => ({
      id: input.newId(),
      ...input.key,
      provider: login.provider,
      accountId: login.accountId,
      revision: login.revision,
      path: login.path,
      login: login.login,
      state: accountUnarchived(state, login.accountId) ? "ready" : "removing",
      createdAt: new Date(),
    }),
  ),
];
