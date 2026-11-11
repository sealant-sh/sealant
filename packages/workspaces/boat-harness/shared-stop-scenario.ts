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

/** Core has discharged the run: Boat's VM is gone by its word and the runtime row is stopped. */
const discharged = (view: RuntimeView) =>
  view.allocation === "deleted" && view.status !== null && view.status !== "ready";

// ---- A run's timeline ---------------------------------------------------------------------------

interface Sample {
  readonly at: number;
  readonly status: WorkspaceStatus | "unreadable";
  readonly view: RuntimeView;
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
        vmLive: vmLive(stack, sandbox),
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
 * What must never be seen while Boat still has the VM: anything it held released, or the run
 * recorded removed; and after the Stop, a public status that says the session is live, or
 * `stopped` while Boat is still deleting it (#600: such a stop reads `retained` until Boat has).
 */
const untruthful = (samples: readonly Sample[]) =>
  samples.flatMap((sample) => {
    // From the moment Core recorded the stop request.
    if (sample.view.stop_reason === null) return [];
    const problems: string[] = [];
    if (sample.vmLive) {
      if (sample.view.allocation === "deleted") problems.push("allocation deleted");
      if (sample.view.tunnel_released === true) problems.push("tunnel slot released");
      if (sample.view.pin === "released") problems.push("publication pin released");
      if (sample.view.removed === true) problems.push("run recorded removed");
      if (sample.status === "stopped") problems.push("public status stopped");
    }
    if (sample.status === "ready" || sample.status === "running")
      problems.push(`public status ${sample.status} after the Stop`);
    return problems.length === 0
      ? []
      : [`${new Date(sample.at).toISOString()}: ${problems.join(", ")}`];
  });

// ---- Worker killed mid-removal ------------------------------------------------------------------

/**
 * The worker is killed the moment Boat accepts the Stop's DELETE and started again. Measures the
 * time to a terminal workspace and to Core's discharge, from the kill: #600 finishes such a stop
 * when the dead worker's removal hold (2 min from the DELETE) or drain claim (3 min) lapses, not on
 * a 30 s sweep. Nothing may be released while Boat still has the VM, and Mend must never read the
 * session live or stopped while it does. `stuck`: Boat's deletion stays `processing` for two sweep
 * periods and is then completed.
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
        const wrong = untruthful(samples);
        process.stderr.write(
          `[boat-harness] ${options.what}: Stop to kill ${seconds(killedAt - stoppedAt)}; from the kill, terminal for Mend ${seconds(terminalAt - killedAt)}, discharged ${seconds(dischargedAt - killedAt)}${completedAt === undefined ? "" : ` (Boat completed the deletion ${seconds(completedAt - killedAt)} after the kill; terminal ${seconds(terminalAt - completedAt)} after that)`}\n  ${timeline.join("\n  ")}\n`,
        );
        expect(
          wrong,
          `while Boat still had the VM:\n${wrong.join("\n")}\n${timeline.join("\n")}`,
        ).toEqual([]);
        await assertReleased(stack, run, { discard: false });
        expect(deletesOf(stack, sandbox)).toHaveLength(1);
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
