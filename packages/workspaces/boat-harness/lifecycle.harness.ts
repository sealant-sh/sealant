/**
 * The whole Boat session lifecycle with real code on both sides of every boundary: allocate, bind,
 * receiver, gateway, isolate, permit, ready, shell, `db:5432` through the tunnel, an edit, Stop,
 * FINAL capture, positive deletion, resume on a new VM, a byte comparison, a final Stop and empty
 * inventories. Then one fault per step, each ending with the same four checks: nothing left
 * behind, the UDP slot and publication pin released, the exact cause on the runtime row, and a
 * terminal workspace for Mend within 60 s. Scenarios share one stack and one published snapshot.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFECTS } from "./defects.js";
import { scenarios } from "./faults.js";
import {
  assertSettled,
  awaitOutcome,
  expectDefect,
  guestEvidence,
  launch,
  openProject,
  runtimeView,
  until,
  type Defect,
  type Launch,
  type Project,
} from "./scenario.js";
import { startStack, type HarnessStack } from "./stack.js";

let stack: HarnessStack;
let project: Project;

beforeAll(async () => {
  stack = await startStack();
  project = await openProject(stack);
});

afterAll(async () => {
  await stack?.stop();
});

/** Prefixes a failure with the lifecycle step it happened in. */
const step = async <T>(name: string, body: () => Promise<T>): Promise<T> => {
  process.stderr.write(`[boat-harness] step ${name}\n`);
  try {
    return await body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`step ${name}: ${message}`, { cause: error });
  }
};

const sh = async (run: Launch, script: string) => {
  const result = await run.workspace.exec(["/bin/sh", "-c", script]);
  if (result.exitCode !== 0)
    throw new Error(`exit ${result.exitCode}: ${result.stderr.slice(-1000)}`);
  return result.stdout;
};

const happyPath = async () => {
  const marker = `boat-harness ${randomBytes(16).toString("hex")}\n`;
  const first = await step("launch", () => launch(stack, project));
  const outcome = await step("ready", () => awaitOutcome(stack, first, 30 * 60_000));
  if (outcome.status !== "ready")
    throw new Error(
      `step ready: launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, first.runId)}`,
    );
  const view = await runtimeView(stack, first.runId);
  expect(view).toMatchObject({ allocation: "bound", execution: "running", status: "ready" });
  await step("shell", async () => {
    expect((await sh(first, "id -un")).trim()).not.toBe("");
  });
  await step("db:5432 through the tunnel", () =>
    sh(
      first,
      `python3 -c "import socket; socket.create_connection(('db', 5432), 5).close(); print('reached')"`,
    ),
  );
  await step("edit", () =>
    sh(
      first,
      `printf '%s' '${marker.trimEnd()}' > boat-harness-proof.txt && echo >> boat-harness-proof.txt`,
    ),
  );
  const stoppedAt = Date.now();
  await step("Stop", () => first.workspace.stop());
  await step("FINAL, deletion and release", () =>
    assertSettled(stack, first, stoppedAt, { terminal: ["stopped"] }),
  );
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
  await step("final Stop", () => resumed.workspace.stop());
  await step("final release", () =>
    assertSettled(stack, resumed, finalAt, { terminal: ["stopped"] }),
  );
  await step("empty inventories", () =>
    until(
      "no live VMs and no gateway objects",
      async () =>
        stack.boat.liveSandboxes().length === 0 &&
        (await stack.coreObjects()).every((entry) => !entry.name.startsWith("boat-tunnel-"))
          ? true
          : undefined,
      60_000,
    ),
  );
};

/** Runs a scenario as passing, or as an expected failure naming its defect. */
const scenario = (
  name: string,
  defect: Defect | undefined,
  body: () => Promise<void>,
  timeoutMs?: number,
) =>
  defect === undefined
    ? it(name, body, timeoutMs)
    : it(
        `${name} [${defect.intermittent === true ? "intermittent" : "expected failure"} ${defect.id}: ${defect.title}]`,
        () => expectDefect(defect, body),
        timeoutMs,
      );

const fault = (
  key: keyof typeof DEFECTS.faults,
  body: (s: HarnessStack, p: Project) => Promise<void>,
) => scenario(key, DEFECTS.faults[key], () => body(stack, project));

describe("Boat session lifecycle", () => {
  // The first launch also builds and publishes the native snapshot.
  scenario("happy path", DEFECTS.happyPath, happyPath, 40 * 60_000);
});

describe("one fault per step", () => {
  fault("bind slower than one sweep period", scenarios.bindSlowerThanSweep);
  fault("create reply lost", scenarios.createReplyLost);
  fault("provisioning never finishes", scenarios.provisioningStuck);
  fault("bind exits 1", scenarios.bindExits);
  fault("bind times out", scenarios.bindTimesOut);
  fault("bind start reply lost", scenarios.bindReplyDropped);
  fault("receiver socket absent behind a live relay", scenarios.receiverAbsent);
  fault("receiver answers 400 on permit", scenarios.receiverRefuses(400));
  fault("receiver answers 409 on permit", scenarios.receiverRefuses(409));
  fault("receiver answers 503 on permit", scenarios.receiverRefuses(503));
  fault("gateway dnsmasq starts 8 s late", scenarios.gatewaySlow);
  fault("gateway crashes before the guest joins", scenarios.gatewayCrashes);
  fault("UDP to the gateway blocked", scenarios.udpBlocked);
  fault("db stopped by a person", scenarios.resourceStopped);
  fault("worker killed after bind", scenarios.workerKilled);
  fault("Stop after the launch", scenarios.stopAfterLaunch);
  fault("deletion stuck in processing", scenarios.deletionStuck);
});
