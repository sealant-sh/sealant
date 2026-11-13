/**
 * The whole Boat session lifecycle with real code on both sides of every boundary: allocate, bind,
 * receiver, gateway, isolate, permit, ready, shell, `db:5432` through the tunnel, an edit, Stop,
 * FINAL capture, positive deletion, resume on a new VM, a byte comparison, a final Stop and empty
 * inventories. Then the workspace's own Docker, and the shared stop's FINAL and deletion cases.
 * The happy path runs first: its launch builds and publishes the native snapshot the rest use.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { DEFECTS } from "./defects.js";
import { Transcript, dockerScenario, evidenceDir } from "./docker-scenario.js";
import { harnessFile, step } from "./harness-file.js";
import {
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
import {
  discardWhileDeleting,
  finalUnconfirmedThenCompletes,
  finalUnconfirmedThenDiscard,
  launchNeverReachedGuest,
  operationOutlastsTheWait,
} from "./shared-stop-scenario.js";
import type { HarnessStack } from "./stack.js";

const { scenario } = harnessFile({ publishSnapshot: false });

const sh = async (run: Launch, script: string) => {
  const result = await run.workspace.exec(["/bin/sh", "-c", script]);
  if (result.exitCode !== 0)
    throw new Error(`exit ${result.exitCode}: ${result.stderr.slice(-1000)}`);
  return result.stdout;
};

const happyPath = async (stack: HarnessStack, project: Project) => {
  const marker = `boat-harness ${randomBytes(16).toString("hex")}\n`;
  const first = await step("launch", () => launch(stack, project));
  const outcome = await step("ready", () => awaitOutcome(stack, first, 30 * 60_000));
  if (outcome.status !== "ready")
    throw new Error(
      `step ready: launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, first.runId)}`,
    );
  const view = await runtimeView(stack, first.runId);
  expect(view).toMatchObject({
    allocation: "bound",
    execution: "running",
    status: "ready",
  });
  await step("tunnel carried over the agent's WebSocket", async () => {
    expect(
      stack.boat.events.some(
        (event) =>
          event.kind === "proxy-upgrade" &&
          event.sandboxId === view.sandbox &&
          event.detail === "/sealant/tunnel",
      ),
    ).toBe(true);
  });
  await step("shell", async () => {
    expect((await sh(first, "id -un")).trim()).not.toBe("");
  });
  await step("db:5432 through the tunnel", () =>
    sh(first, `timeout 5 bash -c 'exec 3<>/dev/tcp/db/5432' && echo reached`),
  );
  await step("edit", () =>
    sh(
      first,
      `printf '%s' '${marker.trimEnd()}' > boat-harness-proof.txt && echo >> boat-harness-proof.txt`,
    ),
  );
  const stoppedAt = Date.now();
  await step("Stop", () => cleanStop(first));
  await step("FINAL, deletion and release", async () => {
    await assertSettled(stack, first, stoppedAt, { terminal: ["stopped"] });
    await assertReleased(stack, first, { discard: false });
  });
  await step("FINAL captured the edit", async () => {
    expect((await first.capture.state()).head).not.toBeNull();
  });
  const resumed = await step("resume", () => launch(stack, project, { resume: first.capture }));
  const second = await step("resumed ready", () => awaitOutcome(stack, resumed, 15 * 60_000));
  if (second.status !== "ready")
    throw new Error(
      `step resumed ready: ended ${second.status} with ${JSON.stringify(second.view)}`,
    );
  const firstSandbox = view.sandbox;
  const secondSandbox = (await runtimeView(stack, resumed.runId)).sandbox;
  expect(secondSandbox).not.toBe(firstSandbox);
  await step("byte compare", async () => {
    expect(await sh(resumed, "cat boat-harness-proof.txt")).toBe(marker);
  });
  const finalAt = Date.now();
  await step("final Stop", () => cleanStop(resumed));
  await step("final release", async () => {
    await assertSettled(stack, resumed, finalAt, { terminal: ["stopped"] });
    await assertReleased(stack, resumed, { discard: false });
  });
  await step("empty inventories", () =>
    until(
      "no live VMs and no gateway objects",
      async () =>
        stack.boat.liveSandboxes().length === 0 &&
        (await stack.ownedObjects()).containers.every((name) => !name.startsWith("boat-tunnel-"))
          ? true
          : undefined,
      60_000,
    ),
  );
};

describe("Boat session lifecycle", () => {
  // The first launch also builds and publishes the native snapshot.
  scenario("happy path", DEFECTS.happyPath, happyPath, 40 * 60_000);
});

/**
 * The workspace's own Docker, as the owner's person: hello-world, a build, compose to `db`
 * through the tunnel, a container reaching the Internet, a two-stage Node build with `npm ci`, the
 * VM's and the session's peak memory and tasks, and the image's VM probe. Its blueprint differs
 * from the happy path's (Docker on), so it builds and publishes its own snapshot first.
 */
const dockerInTheWorkspace = async (stack: HarnessStack, project: Project) => {
  const transcript = new Transcript(join(evidenceDir(stack), "docker-scenario.md"));
  const run = await step("launch (docker, person)", () =>
    launch(stack, project, { docker: true, person: true }),
  );
  const outcome = await step("ready", () => awaitOutcome(stack, run, 40 * 60_000));
  if (outcome.status !== "ready")
    throw new Error(
      `step ready: launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, run.runId)}`,
    );
  await transcript.note(
    `# Docker in the workspace: run ${run.runId}, workspace ${run.workspace.id}, ready after ${String(Math.round((outcome.at - run.startedAt) / 1000))}s`,
  );
  await step("docker scenario", () => dockerScenario(stack, run, transcript));
  const stoppedAt = Date.now();
  await step("Stop", () => cleanStop(run));
  await step("FINAL, deletion and release", async () => {
    await assertSettled(stack, run, stoppedAt, { terminal: ["stopped"] });
    await assertReleased(stack, run, { discard: false });
  });
};

describe("Docker in the workspace", () => {
  scenario("docker, as the owner's person", undefined, dockerInTheWorkspace, 60 * 60_000);
});

// Boat's stop on the shared stop path (#600): closers meeting, a FINAL not confirmed, and a launch
// no daemon ran on. Its worker-killed cases run in no-resources.harness.ts.
describe("the shared stop", () => {
  scenario(
    "saved, then the owner's discard while Boat deletes: FINAL first, edit restored (sealant#622)",
    undefined,
    discardWhileDeleting,
    20 * 60_000,
  );
  scenario(
    "FINAL not confirmed: kept and retained, then the owner's discard",
    undefined,
    finalUnconfirmedThenDiscard,
  );
  scenario(
    "FINAL not confirmed: kept, then completed on a later pass and deleted",
    undefined,
    finalUnconfirmedThenCompletes,
    20 * 60_000,
  );
  scenario(
    "Boat's operation outlasts the removal's wait: the Stop ends on the 404",
    undefined,
    operationOutlastsTheWait,
  );
  scenario(
    "launch never reached the guest: deleted without a discard",
    undefined,
    launchNeverReachedGuest,
  );
});
