/**
 * A DELETE Boat accepted whose reply never reached Core (sealant#598). The removal sends DELETE only
 * to the exact owned VM Boat just returned, records the operation before waiting, and never takes
 * an error for absence. These close a ready session with the owner's Stop, so the release checks'
 * FINAL-before-delete and one-VM invariants and the empty inventory hold for them as for any Stop.
 */
import { expect } from "vitest";
import { z } from "zod";

import type { FakeBoatEvent } from "./fake-boat.js";
import { isSession, withFaults } from "./faults.js";
import {
  assertReleased,
  assertSettled,
  awaitOutcome,
  cleanStop,
  guestEvidence,
  launch,
  runtimeView,
  sqlText,
  until,
  type Launch,
  type Project,
} from "./scenario.js";
import type { HarnessStack } from "./stack.js";

const ready = async (stack: HarnessStack, run: Launch) => {
  const outcome = await awaitOutcome(stack, run, 30 * 60_000);
  if (outcome.status !== "ready" || outcome.view.sandbox === null)
    throw new Error(
      `launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, run.runId)}`,
    );
  return outcome.view.sandbox;
};

/**
 * The removal Core recorded on the run's row, if any: `issued` (the first DELETE is claimed),
 * `operation` (Boat's deletion operation, with whether it completed), `absent` (Boat's 404 was
 * committed before its operation read complete) or `never-created`.
 */
const recordedRemoval = async (stack: HarnessStack, runId: string) => {
  const [row] = await stack.query(
    `select kind,
            case when kind = 'operation' then deletion_operation_id end as id,
            case when kind = 'operation' then (deletion_completed_at is not null)::text
                 when kind in ('absent', 'never-created') then 'true' end as completed
       from (select b.*,
                    case when b.absent_basis = 'never-created' then 'never-created'
                         when b.deletion_completed_at is not null then 'operation'
                         when b.absent_at is not null then 'absent'
                         when b.deletion_operation_id is not null then 'operation'
                         when b.deletion_claimed_at is not null then 'issued' end as kind
               from boat_runs b where b.run_id = '${sqlText(runId)}') r`,
  );
  return z
    .object({
      kind: z.string().nullable(),
      id: z.string().nullable(),
      completed: z.string().nullable(),
    })
    .parse(row);
};

const deleteRequests = (stack: HarnessStack, sandbox: string, since = 0) =>
  stack.boat.events.filter(
    (event) =>
      event.kind === "api" && event.at >= since && event.detail === `DELETE /sandboxes/${sandbox}`,
  );

/** Boat's own deletion operations for the VM: one per VM, however many DELETEs it was sent. */
const operationsFor = (stack: HarnessStack, sandbox: string) => [
  ...new Set(
    stack.boat.events
      .filter((event) => event.kind === "delete" && event.sandboxId === sandbox)
      .map((event) => event.detail ?? ""),
  ),
];

const describeEvents = (events: readonly FakeBoatEvent[], since: number) =>
  events
    .filter((event) => event.at >= since && event.kind !== "proxy")
    .map(
      (event) => `+${((event.at - since) / 1000).toFixed(1)}s ${event.kind} ${event.detail ?? ""}`,
    )
    .join("; ");

/**
 * Boat accepts the Stop's DELETE and the reply is lost, and the deletion stays `processing` for
 * two sweep periods with the VM still readable (a `stuck` deletion is never withdrawn: the window
 * before real Boat withdraws a VM, held open). The next pass reads Boat, finds the exact VM still there, and asks again: Boat
 * answers the operation already under way, which Core records and then only polls. While Boat says
 * the VM is not gone nothing is released; once the deletion completes the VM is confirmed deleted,
 * with one operation for it from start to end.
 */
export const deleteReplyLostWhileDeleting = async (stack: HarnessStack, project: Project) => {
  let lost: { readonly sandbox: string; readonly at: number } | undefined;
  await withFaults(
    stack,
    {
      deleteReply: (sandbox) => {
        if (!isSession(sandbox) || lost !== undefined) return undefined;
        lost = { sandbox: sandbox.id, at: Date.now() };
        return "lose";
      },
      deletion: (sandbox) => (isSession(sandbox) ? "stuck" : undefined),
    },
    async () => {
      const run = await launch(stack, project);
      const sandbox = await ready(stack, run);
      const stoppedAt = Date.now();
      await cleanStop(run);
      const fault = await until("the Stop's DELETE, its reply lost", async () => lost, 3 * 60_000);
      expect(fault.sandbox).toBe(sandbox);
      const evidence = async () =>
        `runtime ${JSON.stringify(await runtimeView(stack, run.runId))}; removal ${JSON.stringify(await recordedRemoval(stack, run.runId))}; Boat since the Stop: ${describeEvents(stack.boat.events, stoppedAt)}`;

      // The next pass reads the VM, finds it, and asks again; Boat answers the same operation.
      const [operation] = operationsFor(stack, sandbox);
      if (operation === undefined) throw new Error(`Boat holds no deletion of ${sandbox}`);
      const recordedAt = await until(
        "Core to record Boat's deletion operation after the lost reply",
        async () =>
          (await recordedRemoval(stack, run.runId)).id === operation ? Date.now() : undefined,
        3 * 60_000,
        500,
      ).catch(async (error: unknown) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; ${await evidence()}`,
        );
      });
      const asked = deleteRequests(stack, sandbox);
      expect(asked.length, await evidence()).toBeGreaterThanOrEqual(2);
      const readAgain = stack.boat.events.some(
        (event) =>
          event.kind === "api" &&
          event.at > fault.at &&
          event.at < (asked[1]?.at ?? 0) &&
          event.detail === `GET /sandboxes/${sandbox}`,
      );
      expect(
        readAgain,
        `no read of ${sandbox} between the lost DELETE and the next; ${await evidence()}`,
      ).toBe(true);

      // Two sweep periods with Boat still `processing`: the VM is not gone, nothing is released.
      await new Promise((done) => setTimeout(done, 65_000));
      const held = await runtimeView(stack, run.runId);
      expect(held.allocation, await evidence()).not.toBe("deleted");
      expect(held.tunnel_released, await evidence()).toBe(false);
      expect(held.pin, await evidence()).not.toBe("released");
      expect(stack.boat.liveSandboxes().some((vm) => vm.id === sandbox)).toBe(true);
      // Recorded, the operation is polled and never sent again.
      expect(deleteRequests(stack, sandbox, recordedAt), await evidence()).toEqual([]);
      expect(
        stack.boat.events.some(
          (event) =>
            event.kind === "api" &&
            event.at >= recordedAt &&
            event.detail === `GET /deletion-operations/${operation}`,
        ),
        await evidence(),
      ).toBe(true);

      await stack.boat.completeDeletion(sandbox);
      await assertSettled(stack, run, Date.now(), { terminal: ["stopped"] });
      await assertReleased(stack, run, { discard: false });
      // Confirmed either way real Boat can show it: the close's poll read the operation
      // `completed` (its receipt), or a GET's 404 was committed as the absence first. Never
      // another operation.
      const receipt = await recordedRemoval(stack, run.runId);
      expect(
        [
          { kind: "operation", id: operation, completed: "true" },
          { kind: "absent", id: null, completed: "true" },
        ],
        await evidence(),
      ).toContainEqual(receipt);
      expect(operationsFor(stack, sandbox)).toEqual([operation]);
      expect(deleteRequests(stack, sandbox, recordedAt)).toEqual([]);
      process.stderr.write(
        `[boat-harness] lost DELETE reply: ${asked.length} DELETEs, one operation ${operation}, recorded ${((recordedAt - fault.at) / 1000).toFixed(1)} s after the lost reply; receipt ${receipt.kind}\n`,
      );
    },
  );
};

/**
 * Boat accepts the Stop's DELETE and the reply is lost, and Boat withdraws the VM at once, as it
 * does (its deletion completes 8 s later). The next pass reads Boat's typed 404 for a VM it saw
 * running, a committed absence: the run is discharged with the one operation Boat made, never a
 * second.
 */
export const deleteReplyLost = async (stack: HarnessStack, project: Project) => {
  let lost: { readonly sandbox: string; readonly at: number } | undefined;
  await withFaults(
    stack,
    {
      deleteReply: (sandbox) => {
        if (!isSession(sandbox) || lost !== undefined) return undefined;
        lost = { sandbox: sandbox.id, at: Date.now() };
        return "lose";
      },
    },
    async () => {
      const run = await launch(stack, project);
      const sandbox = await ready(stack, run);
      const stoppedAt = Date.now();
      await cleanStop(run);
      const fault = await until("the Stop's DELETE, its reply lost", async () => lost, 3 * 60_000);
      expect(fault.sandbox).toBe(sandbox);
      await assertSettled(stack, run, stoppedAt, { terminal: ["stopped"] });
      await assertReleased(stack, run, { discard: false });
      const evidence = `Boat since the Stop: ${describeEvents(stack.boat.events, stoppedAt)}`;
      expect(stack.boat.sandboxes.get(sandbox)?.removed, evidence).toBe(true);
      expect(operationsFor(stack, sandbox), evidence).toHaveLength(1);
      expect((await runtimeView(stack, run.runId)).allocation, evidence).toBe("deleted");
      process.stderr.write(
        `[boat-harness] lost DELETE reply, deletion done at once: ${deleteRequests(stack, sandbox).length} DELETEs, removal ${JSON.stringify(await recordedRemoval(stack, run.runId))}\n`,
      );
    },
  );
};
