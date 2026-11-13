/**
 * The full check of a Boat key (SLNT-784) against the fake Boat: a key that passes every step; a
 * key refused at each step in turn (the step and Boat's reason named, later steps not reached);
 * a crash or a lost reply after each creating step. Every case ends with the fake Boat holding no
 * VM and no snapshot of the check once the sweep has run, and two checks of one account never run
 * at once.
 */
import { randomUUID } from "node:crypto";

import {
  BoatKeyProofRepo,
  BoatKeyProofRepoLive,
  SealantDB,
  createSealantDB,
  type BoatKeyProofRepoService,
} from "@sealant/db";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { FakeBoat, type FakeBoatCall } from "../../../boat-harness/fake-boat.js";
import { BOAT_REFUSALS } from "../../../boat-harness/refusals.js";
import { HttpBoatApi } from "./api.js";
import { BoatSecret } from "./config.js";
import {
  BOAT_KEY_PROOF_CLAIM_MS,
  proveBoatKey,
  sweepBoatKeyProofs,
  type BoatKeyProofClient,
} from "./key-proof.js";

const databaseUrl = process.env.SEALANT_TEST_DATABASE_URL;
const KEY = "boat_live_fixture_proof_key_0007";

const docker = async (args: readonly string[]) => ({
  code: 0,
  stdout: args[0] === "inspect" ? "192.0.10.5\n" : "running\n",
  stderr: "",
  timedOut: false,
});

/** What the fake Boat holds of any check: VMs labelled as a check's, snapshots named as one's. */
const holding = (boat: FakeBoat) => ({
  vms: [...boat.sandboxes.values()].filter(
    (sandbox) => sandbox.labels["sealant-key-proof"] !== undefined && !sandbox.removed,
  ).length,
  snapshots: [...boat.snapshots.keys()].filter((name) => name.startsWith("sealant-key-proof-"))
    .length,
});
/** What the fake holds once the deletions it accepted have completed (it takes a moment). */
const held = async (boat: FakeBoat) => {
  for (let tries = 0; tries < 100; tries++) {
    const now = holding(boat);
    if (now.vms === 0 && now.snapshots === 0) return now;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return holding(boat);
};

const withProof = (
  body: (c: {
    readonly boat: FakeBoat;
    readonly proofs: BoatKeyProofRepoService;
    readonly client: BoatKeyProofClient;
    readonly account: string;
    readonly sweep: (at?: Date) => ReturnType<typeof sweepBoatKeyProofs>;
  }) => Promise<void>,
) =>
  withWorkspaceJobTestDatabase(databaseUrl ?? "", async (url) => {
    const boat = new FakeBoat({
      runId: `proof${randomUUID().slice(0, 8)}`,
      credential: KEY,
      network: "unit",
      baseImage: "unit-base",
      docker,
      deletionWithdrawnMs: 50,
    });
    await boat.start();
    try {
      const db = await createSealantDB(url);
      const proofs = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* BoatKeyProofRepo;
        }).pipe(
          Effect.provide(BoatKeyProofRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db)))),
        ),
      );
      const credential = BoatSecret.parse(KEY);
      if (!credential.ok) throw credential.error;
      const opened = HttpBoatApi.create({
        credential: credential.value,
        baseUrl: boat.baseUrl,
        timeoutMs: 5_000,
      });
      if (!opened.ok) throw opened.error;
      const client = opened.value;
      await body({
        boat,
        proofs,
        client,
        account: randomUUID(),
        sweep: (at) =>
          sweepBoatKeyProofs({
            proofs,
            clientFor: async () => client,
            ...(at === undefined ? {} : { now: () => at }),
            pollMs: 20,
            waitMs: 2_000,
          }),
      });
    } finally {
      await boat.stop();
    }
  });

const fast = { pollMs: 20, waitMs: 5_000 };
const call =
  (method: string, path: RegExp) =>
  (seen: FakeBoatCall): boolean =>
    seen.method === method && path.test(seen.path);

describe.skipIf(databaseUrl === undefined)(
  "a full check of a Boat key (fake Boat)",
  { timeout: 60_000 },
  () => {
    it("passes every step with one start, and leaves nothing", () =>
      withProof(async (c) => {
        const proven = await proveBoatKey({
          proofs: c.proofs,
          account: c.account,
          client: c.client,
          ...fast,
        });
        if (proven.kind !== "proven") throw new Error("not proven");
        expect(proven.proof).toMatchObject({
          outcome: "passed",
          starts: 1,
          leftBehind: { vm: null, snapshot: null, removalConfirmed: true },
        });
        expect(proven.proof.steps.map((step) => [step.step, step.outcome])).toEqual([
          ["start-vm", "passed"],
          ["run-command", "passed"],
          ["publish-port", "passed"],
          ["save-snapshot", "passed"],
          ["delete-snapshot", "passed"],
          ["delete-vm", "passed"],
        ]);
        expect(await held(c.boat)).toEqual({ vms: 0, snapshots: 0 });
        // It is kept for `list`.
        const latest = await Effect.runPromise(c.proofs.latest());
        expect(latest.get(c.account)?.result).toMatchObject({ proofId: proven.proof.proofId });
      }));

    for (const { step, method, path } of [
      { step: "start-vm", method: "POST", path: /^\/sandboxes$/ },
      { step: "run-command", method: "POST", path: /\/commands$/ },
      { step: "publish-port", method: "POST", path: /\/host$/ },
      { step: "save-snapshot", method: "POST", path: /^\/saved-snapshots$/ },
    ] as const)
      it(`a key refused at ${step}: that step names Boat's reason, later steps are not reached, nothing is left`, () =>
        withProof(async (c) => {
          const refused = call(method, path);
          c.boat.faults = {
            refuse: (seen) => (refused(seen) ? BOAT_REFUSALS["permission-missing"] : undefined),
          };
          const proven = await proveBoatKey({
            proofs: c.proofs,
            account: c.account,
            client: c.client,
            ...fast,
          });
          if (proven.kind !== "proven") throw new Error("not proven");
          const steps = new Map(proven.proof.steps.map((each) => [each.step, each]));
          expect(proven.proof.outcome).toBe("refused");
          expect(steps.get(step)).toMatchObject({
            outcome: "refused",
            boat: { kind: "permission-missing", code: "api_key_action_forbidden" },
          });
          const order = ["start-vm", "run-command", "publish-port", "save-snapshot"];
          for (const later of order.slice(order.indexOf(step) + 1))
            expect(steps.get(later as typeof step)?.outcome, later).toBe("not-reached");
          // A refused create made no VM: no start was used of the plan's, nothing to delete.
          if (step === "start-vm") {
            expect(steps.get("delete-vm")?.outcome).toBe("not-reached");
          } else expect(steps.get("delete-vm")?.outcome).toBe("passed");
          expect(proven.proof.leftBehind).toEqual({
            vm: null,
            snapshot: null,
            removalConfirmed: true,
          });
          expect(await held(c.boat)).toEqual({ vms: 0, snapshots: 0 });
          expect(await c.sweep()).toEqual([]);
        }));

    for (const { step, method, path } of [
      { step: "delete-snapshot", method: "DELETE", path: /^\/saved-snapshots\// },
      { step: "delete-vm", method: "DELETE", path: /^\/sandboxes\/bx_/ },
    ] as const)
      it(`a key refused at ${step}: the result names what was left, and the sweep removes it`, () =>
        withProof(async (c) => {
          const refused = call(method, path);
          c.boat.faults = {
            refuse: (seen) => (refused(seen) ? BOAT_REFUSALS["permission-missing"] : undefined),
          };
          const proven = await proveBoatKey({
            proofs: c.proofs,
            account: c.account,
            client: c.client,
            ...fast,
          });
          if (proven.kind !== "proven") throw new Error("not proven");
          expect(proven.proof.steps.find((each) => each.step === step)).toMatchObject({
            outcome: "refused",
            boat: { kind: "permission-missing" },
          });
          expect(
            step === "delete-snapshot"
              ? proven.proof.leftBehind.snapshot
              : proven.proof.leftBehind.vm,
          ).not.toBeNull();
          // While it is left, a second check of the account is refused.
          expect(
            await proveBoatKey({ proofs: c.proofs, account: c.account, client: c.client, ...fast }),
          ).toEqual({ kind: "running" });
          // Boat lets the key delete again: the sweep removes it.
          c.boat.faults = {};
          expect(await c.sweep()).toEqual([{ proofId: proven.proof.proofId, outcome: "settled" }]);
          expect(await held(c.boat)).toEqual({ vms: 0, snapshots: 0 });
        }));

    for (const step of ["start-vm", "save-snapshot"] as const)
      it(`a crash after ${step}: the sweep takes the check over once its claim passed, and removes everything`, () =>
        withProof(async (c) => {
          // The process stops here for good.
          const stopped = new Promise<void>(() => undefined);
          let reachedStep = false;
          void proveBoatKey({
            proofs: c.proofs,
            account: c.account,
            client: c.client,
            ...fast,
            afterStep: async (reached) => {
              if (reached !== step) return;
              reachedStep = true;
              await stopped;
            },
          });
          const made = async () => {
            for (let tries = 0; tries < 200; tries++) {
              const now = holding(c.boat);
              if (reachedStep && now.vms === 1 && (step === "start-vm" || now.snapshots === 1))
                return;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error("the check made nothing");
          };
          await made();
          // A second check of the same account is refused while the first holds it.
          expect(
            await proveBoatKey({ proofs: c.proofs, account: c.account, client: c.client, ...fast }),
          ).toEqual({ kind: "running" });
          // Within its claim the sweep leaves it alone.
          expect(await c.sweep()).toEqual([]);
          const later = new Date(Date.now() + BOAT_KEY_PROOF_CLAIM_MS + 1_000);
          const [settled] = await c.sweep(later);
          expect(settled?.outcome).toBe("settled");
          expect(await held(c.boat)).toEqual({ vms: 0, snapshots: 0 });
          const latest = await Effect.runPromise(c.proofs.latest());
          expect(latest.get(c.account)?.result).toMatchObject({
            outcome: "interrupted",
            starts: 1,
            leftBehind: { vm: null, snapshot: null, removalConfirmed: true },
          });
        }));

    it("a lost reply to the create: the VM is found by its label and deleted", () =>
      withProof(async (c) => {
        c.boat.faults = { create: () => "lose-reply" };
        const proven = await proveBoatKey({
          proofs: c.proofs,
          account: c.account,
          client: c.client,
          ...fast,
        });
        if (proven.kind !== "proven") throw new Error("not proven");
        expect(proven.proof.steps[0]).toMatchObject({ step: "start-vm", outcome: "no-answer" });
        expect(proven.proof.steps.find((each) => each.step === "delete-vm")?.outcome).toBe(
          "passed",
        );
        expect(await held(c.boat)).toEqual({ vms: 0, snapshots: 0 });
      }));

    it("a lost create reply and no list to find it by: the result says removal is not confirmed, and the sweep removes it", () =>
      withProof(async (c) => {
        const listing = call("GET", /^\/sandboxes$/);
        c.boat.faults = {
          create: () => "lose-reply",
          refuse: (seen) =>
            listing(seen) ? { status: 503, code: "service_unavailable" } : undefined,
        };
        const proven = await proveBoatKey({
          proofs: c.proofs,
          account: c.account,
          client: c.client,
          ...fast,
        });
        if (proven.kind !== "proven") throw new Error("not proven");
        // The VM's id is unknown: it is not reported as nothing left.
        expect(proven.proof.leftBehind).toEqual({
          vm: null,
          snapshot: null,
          removalConfirmed: false,
        });
        expect(holding(c.boat).vms).toBe(1);
        c.boat.faults = {};
        expect(await c.sweep()).toEqual([{ proofId: proven.proof.proofId, outcome: "settled" }]);
        expect(await held(c.boat)).toEqual({ vms: 0, snapshots: 0 });
      }));

    it("a lost reply to the snapshot save: the snapshot is deleted by its name", () =>
      withProof(async (c) => {
        c.boat.faults = { saveReply: () => "lose" };
        const proven = await proveBoatKey({
          proofs: c.proofs,
          account: c.account,
          client: c.client,
          ...fast,
        });
        if (proven.kind !== "proven") throw new Error("not proven");
        expect(proven.proof.steps.find((each) => each.step === "save-snapshot")?.outcome).toBe(
          "no-answer",
        );
        expect(proven.proof.steps.find((each) => each.step === "delete-snapshot")?.outcome).toBe(
          "passed",
        );
        expect(await held(c.boat)).toEqual({ vms: 0, snapshots: 0 });
      }));
  },
);
