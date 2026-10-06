/**
 * An in-memory {@link WorkspaceCredentialHomeRepoService} for tests, with the live repository's
 * locking: one write per (instance, home) at a time, each seeing the row as the previous one left
 * it, and a failed write changing nothing.
 */
import { Effect, Semaphore } from "effect";

import type { WorkspaceCredentialHomeRepoService } from "../repositories/workspace-credential-homes.js";
import type {
  WorkspaceCredentialHome,
  WorkspaceRuntimeInstance,
} from "../schema/workspace-build-jobs.js";

export interface InMemoryCredentialHomes {
  readonly service: WorkspaceCredentialHomeRepoService;
  /** The rows, by `${runId} ${home}`. */
  readonly rows: Map<string, WorkspaceCredentialHome>;
}

const keyOf = (input: { readonly runId: string; readonly home: string }) =>
  `${input.runId} ${input.home}`;

export const makeInMemoryCredentialHomes = (
  instances: () => readonly WorkspaceRuntimeInstance[],
): InMemoryCredentialHomes => {
  const rows = new Map<string, WorkspaceCredentialHome>();
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
          } else if (outcome.kind === "hold") {
            const now = new Date();
            const previous = rows.get(key);
            rows.set(key, {
              runId: input.runId,
              home: input.home,
              onBehalfOfUserId: outcome.onBehalfOfUserId,
              accounts: [...outcome.accounts],
              generation: outcome.generation,
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
            });
          }
          return result;
        }),
      ),
    listByRunId: (runId) =>
      Effect.sync(() => [...rows.values()].filter((row) => row.runId === runId)),
    listReadyHoldingAccount: (connectedAccountId) =>
      Effect.sync(() =>
        [...rows.values()].flatMap((home) => {
          const instance = instances().find((candidate) => candidate.runId === home.runId);
          return instance?.status === "ready" &&
            home.accounts.some((account) => account.connectedAccountId === connectedAccountId)
            ? [{ home, instance }]
            : [];
        }),
      ),
  };
  return { service, rows };
};
