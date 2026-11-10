/**
 * The whole Boat session lifecycle with real code on both sides of every boundary: allocate, bind,
 * receiver, gateway, isolate, permit, ready, shell, `db:5432` through the tunnel, an edit, Stop,
 * FINAL capture, positive deletion, resume on a new VM, a byte comparison, a final Stop and empty
 * inventories. Then one fault per step, each ending with the same four checks: nothing left
 * behind, the UDP slot and publication pin released, the exact cause on the runtime row, and a
 * terminal workspace for Mend within 60 s. Scenarios share one stack and one published snapshot.
 */
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFECTS } from "./defects.js";
import { Transcript, dockerScenario, evidenceDir } from "./docker-scenario.js";
import { scenarios } from "./faults.js";
import { runScenario, type Defect } from "./markers.js";
import { parkAndResume } from "./parking-scenario.js";
import {
  assertReleased,
  assertSettled,
  awaitOutcome,
  guestEvidence,
  launch,
  openProject,
  runtimeView,
  takeLaunched,
  until,
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
  if (stack === undefined) return;
  await stack.stop();
  // Keep the run's logs beside the scenario evidence when a proof directory was given.
  const proof = process.env.BOAT_TWIN_PROOF_DIR;
  if (proof === undefined) return;
  const logs = join(proof, "harness-logs");
  await mkdir(logs, { recursive: true });
  for (const name of await readdir(stack.scratch).catch(() => []))
    if (/\.(log|json)$/.test(name))
      await copyFile(join(stack.scratch, name), join(logs, name)).catch(() => undefined);
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
  expect(view).toMatchObject({
    allocation: "bound",
    execution: "running",
    status: "ready",
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
  await step("Stop", () => first.workspace.stop());
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
  await step("final Stop", () => resumed.workspace.stop());
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

/**
 * Runs a scenario as passing, or as an expected failure naming its defect. Either way, every
 * launch it made must then be released: a marker excuses its named step's failure, never a leak.
 */
const scenario = (
  name: string,
  defect: Defect | undefined,
  body: () => Promise<void>,
  timeoutMs?: number,
) =>
  it(
    defect === undefined
      ? name
      : `${name} [${defect.intermittent === true ? "intermittent" : "expected failure"} ${defect.id}: ${defect.title}]`,
    async () => {
      takeLaunched();
      await runScenario(defect, body, async () => {
        const leaks: string[] = [];
        for (const run of takeLaunched())
          await assertReleased(stack, run).catch((error: unknown) => {
            leaks.push(`${run.runId}: ${error instanceof Error ? error.message : String(error)}`);
          });
        return leaks;
      });
    },
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

/**
 * The workspace's own Docker, as the owner's person: hello-world, a build, compose to `db`
 * through the tunnel, the containers' egress policy, a two-stage Node build with `npm ci`, the
 * VM's and the session's peak memory and tasks, and the image's VM probe. Its blueprint differs
 * from the happy path's (Docker on), so it builds and publishes its own snapshot first.
 */
const dockerInTheWorkspace = async () => {
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
  await step("Stop", () => run.workspace.stop());
  await step("FINAL, deletion and release", async () => {
    await assertSettled(stack, run, stoppedAt, { terminal: ["stopped"] });
    await assertReleased(stack, run, { discard: false });
  });
};

describe("Docker in the workspace", () => {
  scenario("docker, as the owner's person", undefined, dockerInTheWorkspace, 60 * 60_000);
});

describe("one fault per step", () => {
  fault("bind slower than one sweep period", scenarios.bindSlowerThanSweep);
  fault("create reply lost", scenarios.createReplyLost);
  fault("provisioning never finishes", scenarios.provisioningStuck);
  fault("bind exits 1", scenarios.bindExits);
  fault("bind times out", scenarios.bindTimesOut);
  fault("bind start reply lost", scenarios.bindReplyDropped);
  fault("agent stopped after bind", scenarios.agentAbsent);
  fault("agent answers 400 on launch", scenarios.agentRefuses(400));
  fault("agent answers 409 on launch", scenarios.agentRefuses(409));
  fault("agent answers 503 on launch", scenarios.agentRefuses(503));
  fault("gateway dnsmasq starts 8 s late", scenarios.gatewaySlow);
  fault("gateway crashes before the guest joins", scenarios.gatewayCrashes);
  fault("UDP to the gateway blocked", scenarios.udpBlocked);
  fault("db stopped by a person", scenarios.resourceStopped);
  fault("worker killed after bind", scenarios.workerKilled);
  fault("Stop after the launch", scenarios.stopAfterLaunch);
  fault("deletion stuck in processing", scenarios.deletionStuck);
});

// Last: it restarts the worker with automatic parking on, and back off when it ends.
describe("parking", () => {
  scenario(
    "park and resume keeps the workspace's Docker images",
    // A simulated retention (see parking-scenario.ts) steps past P1, so the rest must pass.
    process.env.BOAT_HARNESS_SIMULATE_RETENTION === "1" ? undefined : DEFECTS.parking,
    () => parkAndResume(stack, project, step),
    60 * 60_000,
  );
});
