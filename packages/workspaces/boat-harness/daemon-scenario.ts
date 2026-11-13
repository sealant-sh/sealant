/**
 * A ready session's daemon, watched by the exit reconciler through the Boat adapter's `inspect`
 * (sealant#598). A daemon that dies in a live VM is recorded failed, and Boat's close recovers it
 * on its own disk, drains FINAL and deletes the VM only once the work is saved. An agent that is
 * briefly unreachable, or answers 503, is unknown, never an exit: the session goes on.
 */
import { randomBytes } from "node:crypto";

import { expect } from "vitest";

import { isSession, withFaults } from "./faults.js";
import {
  assertFinalBeforeDelete,
  assertReleased,
  assertSettled,
  awaitOutcome,
  cleanStop,
  guestEvidence,
  launch,
  runtimeView,
  until,
  type Launch,
  type Project,
} from "./scenario.js";
import type { HarnessStack } from "./stack.js";

/** `inspect` reads Boat and the agent for a ready VM at most once a minute (`BOAT_INSPECT_READ_MS`). */
const INSPECT_PERIOD_MS = 60_000;

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

const deletesOf = (stack: HarnessStack, sandbox: string) => ({
  operations: stack.boat.events.filter(
    (event) => event.kind === "delete" && event.sandboxId === sandbox,
  ),
  requests: stack.boat.events.filter(
    (event) => event.kind === "api" && event.detail === `DELETE /sandboxes/${sandbox}`,
  ),
});

/** The session is as it was: ready for Mend and sealant, its VM bound and live, nothing deleted. */
const assertStillReady = async (stack: HarnessStack, run: Launch, sandbox: string) => {
  const view = await runtimeView(stack, run.runId);
  const evidence = `runtime ${JSON.stringify(view)}`;
  expect(await run.workspace.status(), evidence).toBe("ready");
  expect(view, evidence).toMatchObject({
    status: "ready",
    error_code: null,
    stop_reason: null,
    allocation: "bound",
    execution: "running",
    sandbox,
  });
  expect(stack.boat.liveSandboxes().some((vm) => vm.id === sandbox)).toBe(true);
  expect(deletesOf(stack, sandbox).requests).toEqual([]);
};

/**
 * Every request to the session's agent fails for one inspection period, then answers 503 (the
 * hosted proxy's, not the agent's health shape) for another; the carried tunnel stays attached.
 * The session must stay ready through both, and after one more period with the agent back.
 */
export const agentBrieflyUnreachable = async (stack: HarnessStack, project: Project) => {
  const run = await launch(stack, project);
  const sandbox = await ready(stack, run);
  const hits = { unreachable: 0, unavailable: 0 };
  let mode: "unreachable" | "unavailable" | undefined = "unreachable";
  await withFaults(
    stack,
    {
      proxy: (path, _method, vm) => {
        if (mode === undefined || vm.id !== sandbox || !isSession(vm)) return undefined;
        if (!path.startsWith("/sealant/") || path.startsWith("/sealant/tunnel")) return undefined;
        hits[mode] += 1;
        return mode === "unreachable"
          ? { kind: "destroy" }
          : {
              kind: "status",
              status: 503,
              body: JSON.stringify({ error: "upstream_unavailable" }),
            };
      },
    },
    async () => {
      await new Promise((done) => setTimeout(done, INSPECT_PERIOD_MS + 15_000));
      mode = "unavailable";
      await new Promise((done) => setTimeout(done, INSPECT_PERIOD_MS + 15_000));
      mode = undefined;
    },
  );
  // Each phase spanned a whole inspection period, so each failed at least one of sealant's reads.
  expect(hits.unreachable, JSON.stringify(hits)).toBeGreaterThan(0);
  expect(hits.unavailable, JSON.stringify(hits)).toBeGreaterThan(0);
  await assertStillReady(stack, run, sandbox);
  // One more period with the agent answering: a read after the faults does not end it either.
  await new Promise((done) => setTimeout(done, INSPECT_PERIOD_MS + 15_000));
  await assertStillReady(stack, run, sandbox);
  expect((await sh(run, "id -un")).trim()).not.toBe("");
  process.stderr.write(
    `[boat-harness] agent unreachable then 503: ${hits.unreachable} and ${hits.unavailable} requests failed, session still ready\n`,
  );
  const stoppedAt = Date.now();
  await cleanStop(run);
  await assertSettled(stack, run, stoppedAt, { terminal: ["stopped"] });
};

/**
 * sealantd is killed in a ready session; the VM and its agent stay up. sealant must record the run
 * failed (`runtime-exited`), drain FINAL from the daemon recovered on the VM's own disk before it
 * deletes the VM, send one DELETE, and leave nothing behind. The edit made before the kill comes
 * back byte for byte on a fresh VM.
 */
export const daemonKilled = async (stack: HarnessStack, project: Project) => {
  const marker = `boat-harness ${randomBytes(16).toString("hex")}\n`;
  const first = await launch(stack, project);
  const sandbox = await ready(stack, first);
  await sh(
    first,
    `printf '%s' '${marker.trimEnd()}' > boat-harness-daemon-proof.txt && echo >> boat-harness-daemon-proof.txt`,
  );
  const killed = await stack.boat.guestRoot(
    sandbox,
    `pids=$(pgrep -x sealantd) || { echo "no sealantd in the guest" >&2; exit 3; }; kill -KILL $pids; echo $pids`,
  );
  const killedAt = Date.now();
  const evidence = async () =>
    `killed ${killed.trim()}; runtime ${JSON.stringify(await runtimeView(stack, first.runId))}; guest: ${await guestEvidence(stack, first.runId)}`;
  // The agent and the VM are untouched: only the daemon is gone.
  expect(
    (await stack.boat.guestRoot(sandbox, "systemctl is-active sealant-agent.service")).trim(),
  ).toBe("active");

  const recorded = await until(
    "sealant to record the daemon's exit",
    async () => {
      const view = await runtimeView(stack, first.runId);
      return view.status === "failed" ? view : undefined;
    },
    3 * INSPECT_PERIOD_MS,
    1000,
  ).catch(async (error: unknown) => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ${await evidence()}`,
    );
  });
  const recordedAfter = Date.now() - killedAt;
  expect(recorded.error_code, await evidence()).toBe("runtime-exited");
  expect(recorded.error ?? "", await evidence()).toMatch(/sealantd .*exited/);

  // Boat's close takes the failed run: FINAL from the recovered daemon, then one DELETE, with no
  // owner's discard.
  await assertReleased(stack, first, { discard: false });
  expect(await assertFinalBeforeDelete(stack, first, "lost its daemon")).toBe("checked");
  const deletes = deletesOf(stack, sandbox);
  expect(deletes.operations, await evidence()).toHaveLength(1);
  expect(deletes.requests, await evidence()).toHaveLength(1);
  expect((await first.capture.state()).head).not.toBeNull();

  const resumed = await launch(stack, project, { resume: first.capture });
  const second = await ready(stack, resumed);
  expect(second).not.toBe(sandbox);
  expect(await sh(resumed, "cat boat-harness-daemon-proof.txt")).toBe(marker);
  const finalAt = Date.now();
  await cleanStop(resumed);
  await assertSettled(stack, resumed, finalAt, { terminal: ["stopped"] });
  await assertReleased(stack, resumed, { discard: false });
  process.stderr.write(
    `[boat-harness] sealantd killed: recorded ${recorded.error_code} ${(recordedAfter / 1000).toFixed(1)} s later, FINAL before the one DELETE, the edit restored\n`,
  );
};
