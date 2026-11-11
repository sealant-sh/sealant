/**
 * Boat's stop on the shared stop path (sealant#600): the stop job, the 30 s nudge, the exit
 * reconciler and the recovery sweep reach one run's stop, and one of them does it. These are the
 * cases that PR exists to get right: a FINAL that is not confirmed (kept, then discarded or
 * completed later), Boat's deletion outlasting the removal's wait, a launch no daemon ever ran on,
 * and a worker killed mid-removal. Two more were tried and left out because the twin cannot stage
 * them: the stop job and the 30 s nudge meeting on a kept run (a second Stop of a kept run starts
 * no stop job, and the nudge did not reach the run before the stranded reaper did), and a
 * restarted daemon's first recovery drain left incomplete (holding its registers past the attempt's
 * budget makes sealantd stop answering its status, a silent daemon rather than an incomplete drain).
 * Every launch also passes the release checks' invariants and the empty inventory.
 */
import { randomBytes } from "node:crypto";

import type { WorkspaceStatus } from "@sealant/sdk";
import { expect } from "vitest";

import { isSession, withFaults } from "./faults.js";
import {
  assertFinalBeforeDelete,
  assertReleased,
  awaitOutcome,
  cleanStop,
  guestEvidence,
  launch,
  requireFinal,
  runtimeView,
  until,
  type Launch,
  type LaunchOptions,
  type Project,
  type RuntimeView,
} from "./scenario.js";
import type { HarnessStack } from "./stack.js";
import { stopInOnePass } from "./stop-scenario.js";
import { completeFinals, workerLogOffset, workerLogSince } from "./worker-log.js";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const ready = async (stack: HarnessStack, run: Launch) => {
  const outcome = await awaitOutcome(stack, run, 30 * 60_000);
  if (outcome.status !== "ready" || outcome.view.sandbox === null)
    throw new Error(
      `launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, run.runId)}`,
    );
  return outcome.view.sandbox;
};

const sh = async (run: Launch, script: string) => {
  const result = await run.workspace.exec(["/bin/sh", "-c", script]);
  if (result.exitCode !== 0)
    throw new Error(`exit ${result.exitCode}: ${result.stderr.slice(-1000)}`);
  return result.stdout;
};

const deletesOf = (stack: HarnessStack, sandbox: string) =>
  stack.boat.events.filter((event) => event.kind === "delete" && event.sandboxId === sandbox);

const vmLive = (stack: HarnessStack, sandbox: string) =>
  stack.boat.liveSandboxes().some((vm) => vm.id === sandbox);

/**
 * Core has discharged the run: Boat's VM is gone by its word, what it held is released, and the
 * runtime row is no longer live. (`allocation` "deleted" alone is only the committed absence since
 * #607, which comes before the tunnel slot and publication pin are released.)
 */
const discharged = (view: RuntimeView) =>
  view.allocation === "deleted" &&
  (view.has_tunnel !== true || view.tunnel_released === true) &&
  view.pin === "released" &&
  view.status !== null &&
  view.status !== "ready";

// ---- A run's timeline ---------------------------------------------------------------------------

interface Sample {
  readonly at: number;
  readonly status: WorkspaceStatus | "unreadable";
  readonly view: RuntimeView;
  /** Boat still answers for the VM (not withdrawn after an accepted DELETE, not removed). */
  readonly vmLive: boolean;
  readonly deletion: string | undefined;
}

/**
 * Samples what Mend, Core and Boat say of one run every second until stopped: the public status,
 * the runtime view, whether the VM is live and its deletion's status.
 */
const sampleRun = (stack: HarnessStack, run: Launch, sandbox: string) => {
  const samples: Sample[] = [];
  const state = { on: true };
  const loop = (async () => {
    while (state.on) {
      const status = await run.workspace.status().catch(() => "unreadable" as const);
      const view = await runtimeView(stack, run.runId);
      const vm = stack.boat.sandboxes.get(sandbox);
      samples.push({
        at: Date.now(),
        status,
        view,
        // Boat still has the VM by its own API: not withdrawn after a DELETE, not removed.
        vmLive: vm !== undefined && !vm.removed && !vm.withdrawn,
        deletion: vm?.deletion?.status,
      });
      await sleep(1000);
    }
  })();
  return {
    samples,
    stop: async () => {
      state.on = false;
      await loop;
      return samples;
    },
  };
};

/** Each change in what the samples say, relative to `since`. */
const transitions = (samples: readonly Sample[], since: number) => {
  const lines: string[] = [];
  let last = "";
  for (const sample of samples) {
    const now = `status ${sample.status}, row ${sample.view.status}, drain ${sample.view.drain}, retained ${String(sample.view.retained)}, allocation ${sample.view.allocation}, execution ${sample.view.execution}, tunnel released ${String(sample.view.tunnel_released)}, pin ${sample.view.pin}, VM ${sample.vmLive ? `live (deletion ${sample.deletion ?? "none"})` : "gone"}`;
    if (now !== last) lines.push(`+${seconds(sample.at - since)} ${now}`);
    last = now;
  }
  return lines;
};

/**
 * What must never be seen while Boat still has the VM (it has not withdrawn it, or removed it):
 * anything it held released, or the run recorded removed. The public status is not asserted here
 * (sealant#612: a stop whose worker died reads its last status until the dead worker's claim lapses).
 */
const releasedEarly = (samples: readonly Sample[]) =>
  samples.flatMap((sample) => {
    if (!sample.vmLive) return [];
    const problems: string[] = [];
    if (sample.view.allocation === "deleted") problems.push("allocation deleted");
    if (sample.view.tunnel_released === true) problems.push("tunnel slot released");
    if (sample.view.pin === "released") problems.push("publication pin released");
    if (sample.view.removed === true) problems.push("run recorded removed");
    return problems.length === 0
      ? []
      : [`${new Date(sample.at).toISOString()}: ${problems.join(", ")}`];
  });

// ---- Worker killed mid-removal ------------------------------------------------------------------

/** The dead worker's drain claim (`DEFAULT_CAPTURE_DRAIN_LEASE_MS`): the shared stop waits it out. */
const DRAIN_CLAIM_MS = 3 * 60_000;
/** One Boat sweep tick. */
const TICK_MS = 30_000;

/**
 * The worker is killed the moment Boat accepts the Stop's DELETE and started again. The shared stop
 * finishes such a stop once the dead worker's drain claim lapses (sealant#612: a starting worker
 * does not yet end its predecessor's claims; tighten these bounds when it does). So: terminal
 * within the claim plus a tick of the kill; until then nothing released that Boat has not
 * confirmed gone, one DELETE, and FINAL before it. `stuck`: Boat's deletion stays `processing` for
 * two sweep periods and is then completed; terminal within 60 s of the later of that and the
 * claim's lapse. The public status meanwhile is not asserted (sealant#612).
 */
const workerKilledAtDelete = async (
  stack: HarnessStack,
  project: Project,
  options: { readonly launch: LaunchOptions; readonly stuck: boolean; readonly what: string },
) => {
  let killing: Promise<void> | undefined;
  let killedAt = 0;
  let deletedSandbox: string | undefined;
  await withFaults(
    stack,
    {
      deletion: (sandbox) => (options.stuck && isSession(sandbox) ? "stuck" : undefined),
      deleteReply: (sandbox) => {
        if (isSession(sandbox) && killing === undefined) {
          deletedSandbox = sandbox.id;
          killedAt = Date.now();
          killing = stack.killWorker();
        }
        return undefined;
      },
    },
    async () => {
      const run = await launch(stack, project, options.launch);
      const sandbox = await ready(stack, run);
      const sampler = sampleRun(stack, run, sandbox);
      const stoppedAt = Date.now();
      try {
        await cleanStop(run);
        await until(
          "Boat to be asked to delete the VM",
          async () => (killing === undefined ? undefined : true),
          3 * 60_000,
          200,
        );
        await killing;
        await stack.startWorker();
        expect(deletedSandbox).toBe(sandbox);
        let completedAt: number | undefined;
        if (options.stuck) {
          await sleep(65_000);
          const held = await runtimeView(stack, run.runId);
          expect(held.allocation).not.toBe("deleted");
          expect(held.removed).toBe(false);
          expect(held.pin).not.toBe("released");
          expect(vmLive(stack, sandbox)).toBe(true);
          completedAt = Date.now();
          await stack.boat.completeDeletion(sandbox);
        }
        const terminalAt = await until(
          "Mend to see the workspace terminal",
          async () =>
            ["stopped", "failed"].includes(await run.workspace.status()) ? Date.now() : undefined,
          10 * 60_000,
          1000,
        );
        const dischargedAt = await until(
          "Core to discharge the run",
          async () => (discharged(await runtimeView(stack, run.runId)) ? Date.now() : undefined),
          10 * 60_000,
          1000,
        );
        await sleep(2000);
        const samples = await sampler.stop();
        const timeline = transitions(samples, killedAt);
        const wrong = releasedEarly(samples);
        process.stderr.write(
          `[boat-harness] ${options.what}: Stop to kill ${seconds(killedAt - stoppedAt)}; from the kill, terminal for Mend ${seconds(terminalAt - killedAt)}, discharged ${seconds(dischargedAt - killedAt)}${completedAt === undefined ? "" : ` (Boat completed the deletion ${seconds(completedAt - killedAt)} after the kill; terminal ${seconds(terminalAt - completedAt)} after that)`}\n  ${timeline.join("\n  ")}\n`,
        );
        expect(
          wrong,
          `released while Boat still had the VM:\n${wrong.join("\n")}\n${timeline.join("\n")}`,
        ).toEqual([]);
        // sealant#612: the bound is the dead worker's drain claim plus a tick (stuck: 60 s after the
        // later of Boat completing and the claim lapsing).
        const bound =
          completedAt === undefined
            ? killedAt + DRAIN_CLAIM_MS + TICK_MS
            : Math.max(completedAt, killedAt + DRAIN_CLAIM_MS) + 60_000;
        expect(
          terminalAt,
          `terminal ${seconds(terminalAt - killedAt)} after the kill, past its bound of ${seconds(bound - killedAt)}\n${timeline.join("\n")}`,
        ).toBeLessThanOrEqual(bound);
        await assertReleased(stack, run, { discard: false });
        expect(deletesOf(stack, sandbox)).toHaveLength(1);
        expect(await assertFinalBeforeDelete(stack, run, "was stopped across a worker kill")).toBe(
          "checked",
        );
        // One FINAL: nothing registered on the channel after the DELETE.
        expect((await run.capture.state()).registers.filter((r) => r.at > killedAt)).toEqual([]);
      } finally {
        await sampler.stop();
      }
    },
  );
};

export const workerKilledAtDeleteTunnel = (stack: HarnessStack, project: Project) =>
  workerKilledAtDelete(stack, project, {
    launch: {},
    stuck: false,
    what: "worker killed at the DELETE (tunnel)",
  });

export const workerKilledAtDeleteNoResources = (stack: HarnessStack, project: Project) =>
  workerKilledAtDelete(stack, project, {
    launch: { resources: "none" },
    stuck: false,
    what: "worker killed at the DELETE (no resources)",
  });

export const workerKilledDuringStuckDeletionTunnel = (stack: HarnessStack, project: Project) =>
  workerKilledAtDelete(stack, project, {
    launch: {},
    stuck: true,
    what: "worker killed at the DELETE, deletion stuck (tunnel)",
  });

// ---- FINAL not confirmed ------------------------------------------------------------------------

/**
 * Stops a ready session whose every `capture.register` the channel refuses (sealantd's terminal
 * byte-quota answer), so its FINAL cannot complete while its daemon is up. The stop must keep the
 * VM: nothing deleted, public status `retained`, the drain saying why. Returns the sandbox.
 */
const stopWithFinalRefused = async (stack: HarnessStack, run: Launch, sandbox: string) => {
  await run.capture.registerFault({ refuse: true });
  const stoppedAt = Date.now();
  // Not `cleanStop`: this Stop is expected to keep the VM.
  await run.workspace.stop();
  const keptAt = await until(
    "Mend to read the kept session retained",
    async () => ((await run.workspace.status()) === "retained" ? Date.now() : undefined),
    5 * 60_000,
    1000,
  ).catch(async (error: unknown) => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; public ${await run.workspace.status()}; drain ${JSON.stringify(await run.workspace.captureDrain())}; runtime ${JSON.stringify(await runtimeView(stack, run.runId))}`,
    );
  });
  const drain = await run.workspace.captureDrain();
  const view = await runtimeView(stack, run.runId);
  const evidence = `drain ${JSON.stringify(drain)}; runtime ${JSON.stringify(view)}`;
  expect(drain?.state, evidence).toBe("kept");
  expect(drain?.detail ?? "", evidence).not.toBe("");
  expect(drain?.observedAt, evidence).toBeDefined();
  // Kept, and not fenced beyond the stop request (#600 item 6): the VM runs, its execution too.
  expect(vmLive(stack, sandbox), evidence).toBe(true);
  expect(view.allocation, evidence).toBe("bound");
  expect(view.execution, evidence).toBe("running");
  expect(deletesOf(stack, sandbox), evidence).toEqual([]);
  expect((await run.capture.state()).refused.length, evidence).toBeGreaterThan(0);
  return { stoppedAt, keptAt, drain };
};

/**
 * FINAL refused, VM kept and `retained` across two sweep periods; then the owner's discard deletes
 * it without a FINAL (the channel still refuses) and releases everything.
 */
export const finalUnconfirmedThenDiscard = async (stack: HarnessStack, project: Project) => {
  const run = await launch(stack, project);
  const sandbox = await ready(stack, run);
  await sh(run, "echo unsaved > boat-harness-unsaved.txt");
  const kept = await stopWithFinalRefused(stack, run, sandbox);
  await sleep(65_000);
  expect(await run.workspace.status()).toBe("retained");
  expect(vmLive(stack, sandbox)).toBe(true);
  expect(deletesOf(stack, sandbox)).toEqual([]);
  const discardAt = Date.now();
  await run.workspace.stop({ discardUnsaved: true });
  const terminalAt = await until(
    "the discarded session to be terminal",
    async () =>
      ["stopped", "failed"].includes(await run.workspace.status()) ? Date.now() : undefined,
    3 * 60_000,
    1000,
  );
  await assertReleased(stack, run, { discard: false });
  const drain = await run.workspace.captureDrain();
  expect(drain?.state, JSON.stringify(drain)).toBe("discarded");
  // And it stays the owner's discard: no later pass records it otherwise.
  await sleep(30_000);
  const after = await runtimeView(stack, run.runId);
  expect(after.drain, `after one more sweep: ${JSON.stringify(after)}`).toBe("discarded");
  expect(deletesOf(stack, sandbox)).toHaveLength(1);
  // No FINAL was saved: the channel refused every register from the first Stop on.
  expect((await run.capture.state()).registers.filter((r) => r.at >= kept.stoppedAt)).toEqual([]);
  process.stderr.write(
    `[boat-harness] FINAL refused: retained ${seconds(kept.keptAt - kept.stoppedAt)} after the Stop (${kept.drain?.detail ?? ""}); discarded, terminal ${seconds(terminalAt - discardAt)} later\n`,
  );
};

/**
 * FINAL refused and the VM kept; then the channel accepts again and a later pass completes FINAL:
 * deleted then, with FINAL before the DELETE, and the edit restored on a fresh VM.
 */
export const finalUnconfirmedThenCompletes = async (stack: HarnessStack, project: Project) => {
  const marker = `boat-harness ${randomBytes(16).toString("hex")}\n`;
  const run = await launch(stack, project);
  const sandbox = await ready(stack, run);
  await sh(
    run,
    `printf '%s' '${marker.trimEnd()}' > boat-harness-later-proof.txt && echo >> boat-harness-later-proof.txt`,
  );
  const kept = await stopWithFinalRefused(stack, run, sandbox);
  const offset = await workerLogOffset(stack);
  const acceptedAt = Date.now();
  await run.capture.registerFault({});
  // The run's FINAL is now the invariant's to check, as for any clean Stop.
  requireFinal(run.runId);
  const dischargedAt = await until(
    "a later pass to complete FINAL and delete the VM",
    async () => (discharged(await runtimeView(stack, run.runId)) ? Date.now() : undefined),
    10 * 60_000,
    1000,
  );
  await assertReleased(stack, run, { discard: false });
  expect(await assertFinalBeforeDelete(stack, run, "completed FINAL on a later pass")).toBe(
    "checked",
  );
  expect(deletesOf(stack, sandbox)).toHaveLength(1);
  const finals = completeFinals(await workerLogSince(stack, offset), run.runId);
  expect(finals, "complete FINAL drains after the channel accepted again").toHaveLength(1);

  const resumed = await launch(stack, project, { resume: run.capture });
  await ready(stack, resumed);
  expect(await sh(resumed, "cat boat-harness-later-proof.txt")).toBe(marker);
  const finalAt = Date.now();
  await cleanStop(resumed);
  await until(
    "the resumed session to be discharged",
    async () => (discharged(await runtimeView(stack, resumed.runId)) ? true : undefined),
    3 * 60_000,
    1000,
  );
  process.stderr.write(
    `[boat-harness] FINAL refused then accepted: retained ${seconds(kept.keptAt - kept.stoppedAt)} after the Stop; FINAL completed by ${finals.join(", ")} and the VM deleted ${seconds(dischargedAt - acceptedAt)} after the channel accepted again; resumed Stop took ${seconds(Date.now() - finalAt)}\n`,
  );
};

// ---- A launch no daemon ever ran on ---------------------------------------------------------------

/**
 * The launch push never reaches the guest: Boat's hosted proxy answers it 502 without forwarding.
 * No daemon ran on the VM, so Core deletes it on its own record without an owner's discard, ends
 * the drain `stopped` (not `gone`), registers nothing, and Mend reads it terminal.
 */
export const launchNeverReachedGuest = async (stack: HarnessStack, project: Project) => {
  let refused = 0;
  let sandbox: string | undefined;
  await withFaults(
    stack,
    {
      proxy: (path, method, vm) => {
        if (!isSession(vm) || method !== "POST" || path !== "/sealant/launch") return undefined;
        refused += 1;
        sandbox = vm.id;
        return { kind: "status", status: 502, body: "Bad Gateway" };
      },
    },
    async () => {
      const run = await launch(stack, project);
      const outcome = await awaitOutcome(stack, run, 10 * 60_000);
      expect(outcome.status).not.toBe("ready");
      if (sandbox === undefined) throw new Error("the launch push never reached Boat's proxy");
      const sampler = sampleRun(stack, run, sandbox);
      try {
        const terminalAt = await until(
          "Mend to see the failed launch terminal",
          async () =>
            ["stopped", "failed"].includes(await run.workspace.status()) ? Date.now() : undefined,
          3 * 60_000,
          1000,
        );
        await assertReleased(stack, run, { discard: false });
        const samples = await sampler.stop();
        const view = await runtimeView(stack, run.runId);
        const drain = await run.workspace.captureDrain();
        process.stderr.write(
          `[boat-harness] launch never reached the guest (${refused} pushes refused): terminal ${seconds(terminalAt - outcome.at)} after the failure; ${JSON.stringify(view)}\n  ${transitions(samples, outcome.at).join("\n  ")}\n`,
        );
        expect(refused).toBeGreaterThan(0);
        expect(drain?.state, JSON.stringify(drain)).toBe("stopped");
        expect(deletesOf(stack, sandbox)).toHaveLength(1);
        expect((await run.capture.state()).registers.filter((r) => r.at >= run.startedAt)).toEqual(
          [],
        );
      } finally {
        await sampler.stop();
      }
    },
  );
};

// ---- Boat's operation outlasts the removal's wait ---------------------------------------------------

/**
 * The live case on VM 131: Boat withdraws the VM at once but its deletion operation reads
 * `processing` for 30 s, past the removal's own 20 s wait. The stop must still end on Boat's 404
 * in one pass (the removal reads the VM itself while it waits), for a run with a tunnel and one
 * without.
 */
export const operationOutlastsTheWait = async (stack: HarnessStack, project: Project) => {
  stack.boat.deletionWithdrawnMs = 30_000;
  try {
    const failures: string[] = [];
    const times: string[] = [];
    for (const [what, options] of [
      ["tunnel", {}],
      ["no resources", { resources: "none" }],
    ] as const) {
      const run = await launch(stack, project, options);
      await ready(stack, run);
      try {
        const took = await stopInOnePass(stack, run);
        times.push(`${what}: discharged ${seconds(took.discharged)}`);
      } catch (error) {
        times.push(`${what}: failed`);
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    process.stderr.write(`[boat-harness] 30 s deletion operation: ${times.join("; ")}\n`);
    if (failures.length > 0) throw new Error(failures.join("\n"));
  } finally {
    stack.boat.deletionWithdrawnMs = 8000;
  }
};

// ---- The owner's discard lands while a saved run's VM is being deleted ------------------------------

/**
 * A clean Stop whose FINAL completes, and whose VM's deletion Boat holds `processing`; the owner's
 * discard is sent while it is. What must never regress: FINAL complete before the one DELETE,
 * everything released, the edit back on a fresh VM, and a terminal drain. The label itself is not
 * asserted (sealant#622: a later pass decides again on the discard, which the shared deletion policy
 * puts first, so the drain can read `discarded` though the work was saved); tighten it to `stopped`
 * when that is fixed. The label each run ends with is logged.
 */
export const discardWhileDeleting = async (stack: HarnessStack, project: Project) => {
  const marker = `boat-harness ${randomBytes(16).toString("hex")}\n`;
  let stuck: string | undefined;
  const run = await withFaults(
    stack,
    {
      deletion: (sandbox) => {
        if (!isSession(sandbox)) return undefined;
        stuck = sandbox.id;
        return "stuck";
      },
    },
    async () => {
      const first = await launch(stack, project);
      const sandbox = await ready(stack, first);
      await sh(
        first,
        `printf '%s' '${marker.trimEnd()}' > boat-harness-discard-proof.txt && echo >> boat-harness-discard-proof.txt`,
      );
      await cleanStop(first);
      await until("Boat to hold the VM's deletion", async () => stuck, 3 * 60_000, 500);
      expect(stuck).toBe(sandbox);
      // The deletion is in flight: Boat says `processing`, Core has not seen the VM gone.
      await sleep(5000);
      const before = await runtimeView(stack, first.runId);
      expect(before.allocation, JSON.stringify(before)).not.toBe("deleted");
      const discard = await first.workspace
        .stop({ discardUnsaved: true })
        .then(() => "accepted")
        .catch(
          (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      await sleep(5000);
      await stack.boat.completeDeletion(sandbox);
      await until(
        "the run to be discharged",
        async () => (discharged(await runtimeView(stack, first.runId)) ? true : undefined),
        5 * 60_000,
        1000,
      );
      await assertReleased(stack, first, { discard: false });
      // A sweep later, so a writer that comes after the stop has had its turn.
      await sleep(30_000);
      const drain = await first.workspace.captureDrain();
      const view = await runtimeView(stack, first.runId);
      process.stderr.write(
        `[boat-harness] discard while deleting: discard ${discard}; drain ${drain?.state} (${drain?.detail ?? ""}); row ${view.drain}\n`,
      );
      // sealant#622: `stopped` once a complete FINAL outranks a discard; either is terminal today.
      expect(["stopped", "discarded"], JSON.stringify(drain)).toContain(drain?.state);
      expect(["stopped", "discarded"], JSON.stringify(view)).toContain(view.drain);
      expect(deletesOf(stack, sandbox)).toHaveLength(1);
      expect(
        await assertFinalBeforeDelete(stack, first, "was saved, then discarded while deleting"),
      ).toBe("checked");
      return first;
    },
  );
  const resumed = await launch(stack, project, { resume: run.capture });
  await ready(stack, resumed);
  expect(await sh(resumed, "cat boat-harness-discard-proof.txt")).toBe(marker);
  await cleanStop(resumed);
  await until(
    "the resumed session to be discharged",
    async () => (discharged(await runtimeView(stack, resumed.runId)) ? true : undefined),
    3 * 60_000,
    1000,
  );
};
