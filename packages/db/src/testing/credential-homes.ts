import { randomUUID } from "node:crypto";

import { Effect, Semaphore } from "effect";

import {
  placementAccountStatus,
  type HomeState,
  type PlacementAccount,
} from "../credential-placements.js";
import type { WorkspaceCredentialHomeRepoService } from "../repositories/workspace-credential-homes.js";
import type {
  CredentialPlacementHome,
  CredentialPlacementRepoService,
} from "../repositories/workspace-credential-placements.js";
import type { ConnectedAccount } from "../schema/control-plane.js";
import type {
  WorkspaceCredentialHome,
  WorkspaceCredentialPlacement,
  WorkspaceRuntimeInstance,
} from "../schema/workspace-build-jobs.js";

export interface InMemoryCredentialHomes {
  readonly service: WorkspaceCredentialHomeRepoService;
  readonly placements: CredentialPlacementRepoService;
  /** The rows, by `${runId} ${home}`. */
  readonly rows: Map<string, WorkspaceCredentialHome>;
  readonly placementRows: Map<string, WorkspaceCredentialPlacement>;
  readonly place: (input: {
    readonly runId: string;
    readonly home: string;
    readonly provider: WorkspaceCredentialPlacement["provider"];
    readonly accountId: string;
    readonly revision?: number;
  }) => WorkspaceCredentialPlacement;
}

const LOGIN_FILES = {
  claude: ".claude/.credentials.json",
  codex: ".codex/auth.json",
  github: ".config/gh/hosts.yml",
  pi: ".pi/agent/auth.json",
  opencode: ".local/share/opencode/auth.json",
} as const;

type AccountRow = Pick<
  ConnectedAccount,
  "id" | "name" | "ownerUserId" | "credentialRevision" | "archivedAt" | "status"
> & { readonly provider: string };

const keyOf = (input: CredentialPlacementHome) => `${input.runId} ${input.home}`;

export const makeInMemoryCredentialHomes = (
  instances: () => readonly WorkspaceRuntimeInstance[],
  options: {
    readonly accounts?: () => readonly AccountRow[];
    readonly defaults?: () => readonly string[];
  } = {},
): InMemoryCredentialHomes => {
  const rows = new Map<string, WorkspaceCredentialHome>();
  const placementRows = new Map<string, WorkspaceCredentialPlacement>();
  const of = (home: CredentialPlacementHome) =>
    [...placementRows.values()].filter((row) => row.runId === home.runId && row.home === home.home);
  let fences = 0;
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (key: string) => {
    const existing = locks.get(key);
    if (existing !== undefined) return existing;
    const made = Semaphore.makeUnsafe(1);
    locks.set(key, made);
    return made;
  };

  const service: WorkspaceCredentialHomeRepoService = {
    withLockedHome: (input, use) =>
      lockFor(keyOf(input)).withPermit(
        Effect.gen(function* () {
          const key = keyOf(input);
          const nextFence = Effect.sync(() => {
            fences += 1;
            return String(fences);
          });
          const { result, outcome } = yield* use(rows.get(key), nextFence);
          if (outcome.kind === "release") {
            rows.delete(key);
            for (const row of of(input)) placementRows.delete(row.id);
          } else if (outcome.kind === "hold") {
            const now = new Date();
            const previous = rows.get(key);
            rows.set(key, {
              runId: input.runId,
              home: input.home,
              onBehalfOfUserId: outcome.onBehalfOfUserId,
              generation: outcome.generation,
              releasing: false,
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
            });
          }
          return result;
        }),
      ),
    listByRunId: (runId) =>
      Effect.sync(() => [...rows.values()].filter((row) => row.runId === runId)),
  };

  const state = (home: CredentialPlacementHome, accountIds: readonly string[]): HomeState => {
    const held = rows.get(keyOf(home));
    const placements = of(home).toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const ids = new Set([...placements.map((row) => row.accountId), ...accountIds]);
    return {
      held,
      placements,
      accounts: new Map(
        (options.accounts?.() ?? [])
          .filter((account) => ids.has(account.id))
          .map((account): [string, PlacementAccount] => [
            account.id,
            {
              id: account.id,
              name: account.name,
              ownerUserId: account.ownerUserId,
              provider: account.provider,
              revision: account.credentialRevision,
              status: placementAccountStatus(account),
            },
          ]),
      ),
      defaults: new Set(held === undefined ? [] : (options.defaults?.() ?? [])),
    };
  };

  const targetsWhere = (
    match: (home: WorkspaceCredentialHome, instance: WorkspaceRuntimeInstance) => boolean,
  ) =>
    [...rows.values()].flatMap((home) => {
      const instance = instances().find((row) => row.runId === home.runId);
      return instance !== undefined && match(home, instance) ? [{ home, instance }] : [];
    });

  const placements: CredentialPlacementRepoService = {
    state: (home, accountIds = []) => Effect.sync(() => state(home, accountIds)),
    transact: (home, accountIds, decide) =>
      Effect.sync(() => {
        const change = decide(state(home, accountIds));
        const key = keyOf(home);
        const held = rows.get(key);
        if (change.insertHome !== undefined && held === undefined) {
          rows.set(key, {
            ...home,
            ...change.insertHome,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
        const current = rows.get(key);
        if (change.releasing === true && current !== undefined) {
          rows.set(key, { ...current, releasing: true });
        }
        for (const row of of(home)) placementRows.delete(row.id);
        for (const row of change.placements) placementRows.set(row.id, row);
        return { result: change.result, state: state(home, accountIds) };
      }),
    homesHoldingAccount: (accountId) =>
      Effect.sync(() =>
        targetsWhere(
          (home, instance) =>
            instance.status === "ready" &&
            of(home).some((row) => row.accountId === accountId && row.state !== "removing"),
        ),
      ),
    homesWithRemovalWork: () =>
      Effect.sync(() =>
        targetsWhere(
          (home, instance) =>
            instance.status !== "pending" &&
            instance.status !== "running" &&
            (home.releasing || of(home).some((row) => row.state !== "ready")),
        ),
      ),
  };

  const place: InMemoryCredentialHomes["place"] = (input) => {
    const row: WorkspaceCredentialPlacement = {
      id: `cpl_${randomUUID()}`,
      runId: input.runId,
      home: input.home,
      provider: input.provider,
      accountId: input.accountId,
      revision: input.revision ?? 1,
      path: `${input.home}/${LOGIN_FILES[input.provider]}`,
      login: { kind: "subscription" },
      state: "ready",
      createdAt: new Date(),
    };
    placementRows.set(row.id, row);
    return row;
  };

  return { service, placements, rows, placementRows, place };
};
