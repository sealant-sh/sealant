/**
 * A full check of a Boat key (SLNT-784): Boat lets no key read all of its own permissions and has
 * no dry run, so Core proves the key by doing what a session does, once, on the smallest VM: start
 * it, run a command, publish a port, save a snapshot, then delete the snapshot and the VM.
 *
 * Leaving nothing behind is the design, not the happy path:
 * - The ledger row (`boat_key_proofs`) is written before anything is created, and names what may be
 *   created: the VM's idempotency key and `sealant-key-proof` label, the snapshot's name. Each
 *   create is recorded as issued before it is sent.
 * - Whatever was issued is deleted when the check ends, on every path it can see.
 * - A check that stops where it cannot clean up (the process dies, Boat stops answering) leaves
 *   its row unfinished or `cleanup_pending`; the worker's sweep takes it over once its claim has
 *   passed, and deletes the VM (by id, or found by its label) and the snapshot (by name).
 * - The VM is created with a bounded lifetime (15 minutes), so even a sweep that cannot reach Boat
 *   does not leave it running for long.
 * - One check of an account at a time (a unique index on unfinished rows).
 */
import { randomUUID } from "node:crypto";

import type { BoatKeyProof, BoatKeyProofStep, BoatKeyProofStepName } from "@sealant/api-contracts";
import type { BoatKeyProofRecord, BoatKeyProofRepoService } from "@sealant/db";
import { Effect } from "effect";

import type { HttpBoatApi } from "./api.js";
import {
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  type BoatApiError,
  type BoatSandboxId,
  type BoatSnapshotName,
} from "./config.js";

/** The calls a full check makes. */
export type BoatKeyProofClient = Pick<
  HttpBoatApi,
  | "create"
  | "get"
  | "execute"
  | "hostControl"
  | "saveSnapshot"
  | "getSnapshot"
  | "deleteSnapshot"
  | "deleteSandbox"
  | "findKeyProof"
>;

/** How long a check holds its account before the sweep may take it over. */
export const BOAT_KEY_PROOF_CLAIM_MS = 15 * 60_000;
/** The throwaway VM's own lifetime in Boat: the backstop if nothing else reaches it. */
const VM_TTL_SECONDS = 900;
/**
 * How long after the create was issued an empty label search is trusted as "no VM": Boat's list
 * may lag a create, and a refused create's replay proves nothing.
 */
export const BOAT_KEY_PROOF_LISTING_LAG_MS = 10 * 60_000;

export interface BoatKeyProofOptions {
  /** The ledger (`BoatKeyProofRepo`). */
  readonly proofs: BoatKeyProofRepoService;
  /** A stored account's id, or `default` for the install's own key. */
  readonly account: string;
  readonly client: BoatKeyProofClient;
  readonly now?: () => Date;
  /** Between two reads while Boat starts the VM, saves the snapshot or deletes the VM. */
  readonly pollMs?: number;
  /** How long each of those waits may take. Default 3 minutes. */
  readonly waitMs?: number;
  /**
   * Runs after each step that creates something (`start-vm`, `save-snapshot`): a test stops the
   * check there for good, as a process that died would.
   */
  readonly afterStep?: (step: BoatKeyProofStepName) => Promise<void>;
}

const ledger = (proofs: BoatKeyProofRepoService) => ({
  do: <A, E>(f: (repo: BoatKeyProofRepoService) => Effect.Effect<A, E>) =>
    Effect.runPromise(f(proofs)),
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A step Boat refused, or did not answer, with Boat's reason. */
const failedStep = (step: BoatKeyProofStepName, error: BoatApiError): BoatKeyProofStep =>
  error.boat === undefined || error.boat.kind === "no-answer"
    ? {
        step,
        outcome: "no-answer",
        ...(error.boat === undefined ? {} : { boat: error.boat }),
      }
    : { step, outcome: "refused", boat: error.boat };

/** Boat answered the create with a refusal of its own: the first create under its key made no VM. */
const definiteRefusal = (error: BoatApiError) =>
  error.boat !== undefined && error.boat.kind !== "no-answer";

const STARTED = new Set(["ready", "idle", "running"]);
const FAILED = new Set(["error", "cancelled", "archived", "archiving"]);

/** Deletes the snapshot: done once Boat says it is deleted or does not have it. */
const deleteSnapshot = async (client: BoatKeyProofClient, name: BoatSnapshotName) => {
  const deleted = await client.deleteSnapshot(name).catch(() => undefined);
  if (deleted === undefined) return { done: false } as const;
  if (deleted.ok || deleted.error.status === 404) return { done: true } as const;
  return { done: false, error: deleted.error } as const;
};

/**
 * Deletes the VM: done once Boat no longer has it (its `GET` answers 404). Boat withdraws a VM at
 * once on delete; the wait is for a Boat that takes longer.
 */
const deleteVm = async (
  client: BoatKeyProofClient,
  id: BoatSandboxId,
  wait: { readonly pollMs: number; readonly waitMs: number },
) => {
  const deleted = await client.deleteSandbox(id).catch(() => undefined);
  if (deleted !== undefined && !deleted.ok && deleted.error.status !== 404)
    return { done: false, error: deleted.error } as const;
  const until = Date.now() + wait.waitMs;
  for (;;) {
    const read = await client.get(id).catch(() => undefined);
    if (read !== undefined && !read.ok && read.error.status === 404) return { done: true } as const;
    if (Date.now() >= until) return { done: false } as const;
    await sleep(wait.pollMs);
  }
};

/** The check's VM, from its id or its label; `undefined`: none found (not proof of absence). */
const locateVm = async (client: BoatKeyProofClient, record: BoatKeyProofRecord) => {
  if (record.sandboxId !== null) {
    const id = boatSandboxIdSchema.safeParse(record.sandboxId);
    return id.success ? { kind: "found" as const, id: id.data } : { kind: "unknown" as const };
  }
  const listed = await client.findKeyProof(record.createKey).catch(() => undefined);
  if (listed === undefined || listed.kind === "unknown") return { kind: "unknown" as const };
  const [first] = listed.sandboxes;
  return first === undefined ? { kind: "none" as const } : { kind: "found" as const, id: first.id };
};

/**
 * Runs one full check of an account's key and answers its result, or `running` when a check of
 * the same account is unfinished. Never throws for what Boat answers; a store failure throws, with
 * the ledger as far as it got, for the sweep.
 */
export const proveBoatKey = async (
  options: BoatKeyProofOptions,
): Promise<
  { readonly kind: "running" } | { readonly kind: "proven"; readonly proof: BoatKeyProof }
> => {
  const now = options.now ?? (() => new Date());
  const pollMs = options.pollMs ?? 2_000;
  const waitMs = options.waitMs ?? 180_000;
  const { client } = options;
  const store = ledger(options.proofs);
  const id = randomUUID();
  const createKey = randomUUID();
  const snapshot = boatSnapshotNameSchema.parse(`sealant-key-proof-${id}`);
  const startedAt = now();
  const started = await store.do((repo) =>
    repo.start({
      id,
      account: options.account,
      createKey,
      snapshotName: snapshot,
      startedAt,
      claimedUntil: new Date(startedAt.getTime() + BOAT_KEY_PROOF_CLAIM_MS),
    }),
  );
  if (started === "running") return { kind: "running" };

  const steps = new Map<BoatKeyProofStepName, BoatKeyProofStep>();
  const set = (step: BoatKeyProofStep) => steps.set(step.step, step);
  let vm: BoatSandboxId | undefined;
  /** Boat may hold a VM of this check: the create was sent and not refused outright. */
  let vmMayExist = false;
  let snapshotMayExist = false;
  let starts = 0;

  const body = async () => {
    // start-vm
    await store.do((repo) => repo.createIssued(id, now()));
    starts = 1;
    vmMayExist = true;
    const created = await client
      .create({
        idempotencyKey: createKey,
        lifetime: { kind: "bounded", ttlSeconds: VM_TTL_SECONDS },
        requestVersion: 2,
        marker: createKey,
        purpose: "key-proof",
      })
      .catch(() => undefined);
    if (created === undefined) {
      set({ step: "start-vm", outcome: "no-answer" });
      return;
    }
    if (!created.ok) {
      set(failedStep("start-vm", created.error));
      if (definiteRefusal(created.error)) vmMayExist = false;
      return;
    }
    vm = created.value.id;
    await store.do((repo) => repo.sandboxSeen(id, created.value.id));
    const until = Date.now() + waitMs;
    for (let state = created.value.state; !STARTED.has(state); ) {
      if (FAILED.has(state) || Date.now() >= until) {
        set({ step: "start-vm", outcome: "refused" });
        return;
      }
      await sleep(pollMs);
      const read = await client.get(created.value.id).catch(() => undefined);
      if (read !== undefined && !read.ok) {
        set(failedStep("start-vm", read.error));
        return;
      }
      if (read !== undefined) state = read.value.state;
    }
    set({ step: "start-vm", outcome: "passed" });
    await options.afterStep?.("start-vm");

    // run-command
    const ran = await client
      .execute(created.value.id, "true", { timeoutSeconds: 30 })
      .catch(() => undefined);
    if (ran === undefined || !ran.ok) {
      set(
        ran === undefined
          ? { step: "run-command", outcome: "no-answer" }
          : failedStep("run-command", ran.error),
      );
      return;
    }
    if (ran.value.exitCode !== 0) {
      set({ step: "run-command", outcome: "refused" });
      return;
    }
    set({ step: "run-command", outcome: "passed" });

    // publish-port
    const hosted = await client.hostControl(created.value.id).catch(() => undefined);
    if (hosted === undefined || !hosted.ok) {
      set(
        hosted === undefined
          ? { step: "publish-port", outcome: "no-answer" }
          : failedStep("publish-port", hosted.error),
      );
      return;
    }
    set({ step: "publish-port", outcome: "passed" });

    // save-snapshot
    await store.do((repo) => repo.saveIssued(id, now()));
    snapshotMayExist = true;
    const saved = await client.saveSnapshot(created.value.id, snapshot).catch(() => undefined);
    if (saved === undefined) {
      set({ step: "save-snapshot", outcome: "no-answer" });
      return;
    }
    if (!saved.ok) {
      set(failedStep("save-snapshot", saved.error));
      return;
    }
    for (let status = saved.value.status; status !== "ready"; ) {
      if (status === "failed" || Date.now() >= until) {
        set({ step: "save-snapshot", outcome: "refused" });
        return;
      }
      await sleep(pollMs);
      const read = await client.getSnapshot(snapshot).catch(() => undefined);
      if (read !== undefined && read.ok) status = read.value.status;
    }
    set({ step: "save-snapshot", outcome: "passed" });
    await options.afterStep?.("save-snapshot");
  };

  let finished: BoatKeyProof | undefined;
  try {
    await body();
  } finally {
    // The cleanup steps run whatever happened above: they are the proof's last two steps and
    // what keeps nothing behind.
    let snapshotLeft = false;
    if (snapshotMayExist) {
      const removed = await deleteSnapshot(client, snapshot);
      if (removed.done) {
        await store.do((repo) => repo.snapshotDeleted(id, now()));
        set({ step: "delete-snapshot", outcome: "passed" });
      } else {
        snapshotLeft = true;
        set(
          removed.error === undefined
            ? { step: "delete-snapshot", outcome: "no-answer" }
            : failedStep("delete-snapshot", removed.error),
        );
      }
    }
    let vmLeft: string | null = null;
    if (vmMayExist) {
      const located =
        vm === undefined
          ? await locateVm(client, {
              id,
              account: options.account,
              createKey,
              snapshotName: snapshot,
              startedAt,
              claimedUntil: startedAt,
              createIssuedAt: startedAt,
              sandboxId: null,
              saveIssuedAt: null,
              vmDeletedAt: null,
              snapshotDeletedAt: null,
              finishedAt: null,
              cleanupPending: true,
              result: null,
            })
          : { kind: "found" as const, id: vm };
      if (located.kind === "found") {
        if (vm === undefined) await store.do((repo) => repo.sandboxSeen(id, located.id));
        const removed = await deleteVm(client, located.id, { pollMs, waitMs });
        if (removed.done) {
          await store.do((repo) => repo.vmDeleted(id, now()));
          set({ step: "delete-vm", outcome: "passed" });
        } else {
          vmLeft = located.id;
          set(
            removed.error === undefined
              ? { step: "delete-vm", outcome: "no-answer" }
              : failedStep("delete-vm", removed.error),
          );
        }
      } else {
        // Not found yet: Boat may still list it later. The sweep looks again.
        vmLeft = "unknown";
        set({ step: "delete-vm", outcome: "no-answer" });
      }
    }
    const ordered = (
      [
        "start-vm",
        "run-command",
        "publish-port",
        "save-snapshot",
        "delete-snapshot",
        "delete-vm",
      ] as const
    ).map((step): BoatKeyProofStep => steps.get(step) ?? { step, outcome: "not-reached" });
    const passed = ordered.every((step) => step.outcome === "passed");
    const proof: BoatKeyProof = {
      proofId: id,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      outcome: passed ? "passed" : "refused",
      steps: ordered,
      starts,
      leftBehind: {
        vm: vmLeft === "unknown" ? null : vmLeft,
        snapshot: snapshotLeft ? snapshot : null,
      },
    };
    const cleanupPending = snapshotLeft || vmLeft !== null;
    await store.do((repo) => repo.finish(id, { at: now(), result: proof, cleanupPending }));
    finished = proof;
  }
  return { kind: "proven", proof: finished };
};

/** One check's sweep outcome. */
export interface BoatKeyProofSweepOutcome {
  readonly proofId: string;
  readonly outcome: "settled" | "pending";
}

/**
 * One pass of the sweep: every check whose claim has passed unfinished (its process stopped), or
 * that finished with something left in Boat, has its snapshot deleted by name and its VM deleted
 * by id or found by its label. A check is settled once Boat holds neither; an interrupted one gets
 * its result then (`interrupted`). `clientFor` opens the account's key; `undefined` when it cannot
 * (the account is gone): the check stays pending.
 */
export const sweepBoatKeyProofs = async (options: {
  readonly proofs: BoatKeyProofRepoService;
  readonly clientFor: (account: string) => Promise<BoatKeyProofClient | undefined>;
  readonly now?: () => Date;
  readonly pollMs?: number;
  readonly waitMs?: number;
}): Promise<readonly BoatKeyProofSweepOutcome[]> => {
  const now = options.now ?? (() => new Date());
  const store = ledger(options.proofs);
  const outcomes: BoatKeyProofSweepOutcome[] = [];
  for (const record of await store.do((repo) => repo.toSweep(now()))) {
    const settled = await (async () => {
      const client = await options.clientFor(record.account).catch(() => undefined);
      if (client === undefined) return false;
      let snapshotGone = record.saveIssuedAt === null || record.snapshotDeletedAt !== null;
      if (!snapshotGone) {
        const name = boatSnapshotNameSchema.safeParse(record.snapshotName);
        if (name.success && (await deleteSnapshot(client, name.data)).done) {
          await store.do((repo) => repo.snapshotDeleted(record.id, now()));
          snapshotGone = true;
        }
      }
      let vmGone = record.createIssuedAt === null || record.vmDeletedAt !== null;
      if (!vmGone) {
        const located = await locateVm(client, record);
        if (located.kind === "found") {
          if (record.sandboxId === null)
            await store.do((repo) => repo.sandboxSeen(record.id, located.id));
          const removed = await deleteVm(client, located.id, {
            pollMs: options.pollMs ?? 2_000,
            waitMs: options.waitMs ?? 60_000,
          });
          vmGone = removed.done;
        } else if (
          located.kind === "none" &&
          record.createIssuedAt !== null &&
          now().getTime() - record.createIssuedAt.getTime() >= BOAT_KEY_PROOF_LISTING_LAG_MS
        )
          // Long enough after the create that Boat's list would show it: it was never made.
          vmGone = true;
        if (vmGone) await store.do((repo) => repo.vmDeleted(record.id, now()));
      }
      if (!snapshotGone || !vmGone) return false;
      const interrupted: BoatKeyProof = {
        proofId: record.id,
        startedAt: record.startedAt.toISOString(),
        finishedAt: now().toISOString(),
        outcome: "interrupted",
        steps: (
          [
            ["start-vm", record.createIssuedAt !== null],
            ["run-command", false],
            ["publish-port", false],
            ["save-snapshot", record.saveIssuedAt !== null],
            ["delete-snapshot", record.saveIssuedAt !== null],
            ["delete-vm", record.createIssuedAt !== null],
          ] as const
        ).map(
          ([step, reached]): BoatKeyProofStep =>
            !reached
              ? { step, outcome: "not-reached" }
              : step === "delete-snapshot" || step === "delete-vm"
                ? { step, outcome: "passed" }
                : { step, outcome: "no-answer" },
        ),
        starts: record.createIssuedAt === null ? 0 : 1,
        leftBehind: { vm: null, snapshot: null },
      };
      await store.do((repo) => repo.settle(record.id, { at: now(), result: interrupted }));
      return true;
    })().catch(() => false);
    outcomes.push({ proofId: record.id, outcome: settled ? "settled" : "pending" });
  }
  return outcomes;
};
