/**
 * The whole Boat session lifecycle with real code on both sides of every boundary: allocate, bind,
 * receiver, gateway, isolate, permit, ready, shell, `db:5432` through the tunnel, an edit, Stop,
 * FINAL capture, positive deletion, resume on a new VM, a byte comparison, a final Stop and empty
 * inventories. Then one fault per step, each ending with the same four checks: nothing left
 * behind, the tunnel slot and publication pin released, the exact cause on the runtime row, and a
 * terminal workspace for Mend within 60 s. Scenarios share one stack and one published snapshot.
 */
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFECTS } from "./defects.js";
import { Transcript, dockerScenario, evidenceDir } from "./docker-scenario.js";
import { docker } from "./docker.js";
import { scenarios } from "./faults.js";
import { runScenario, type Defect } from "./markers.js";
import {
  gatewaylessWorker,
  noResourcesDeletionStuck,
  noResourcesLifecycle,
  noResourcesWorkerKilledDuringDelete,
} from "./no-resources-scenario.js";
import {
  assertReleased,
  assertSettled,
  awaitOutcome,
  cleanStop,
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

/** Live VMs and Boat gateway objects on this host, whatever run (or none) they are labelled with. */
const isGateway = (name: string) => name.startsWith("boat-tunnel-");

const inventory = async () => {
  const owned = await stack.ownedObjects();
  const gatewayContainers = owned.containers.filter(isGateway);
  const gatewayNetworks = owned.networks.filter(isGateway);
  return {
    vms: stack.boat.liveSandboxes(),
    gatewayContainers,
    gatewayNetworks,
    gateways: [...gatewayContainers, ...gatewayNetworks],
  };
};

/**
 * Scenarios run one at a time, so after each the whole inventory must empty within 60 s: no live
 * VM and no gateway, including ones no tracked run is labelled with (a build VM, a VM a recover
 * path made under a new run, a changed label). A leftover fails the scenario; its VMs are then
 * removed outside Boat's API so the next scenario starts clean. Returns the leak, if any.
 */
const emptyInventory = async (): Promise<string | undefined> => {
  const empty = await until(
    "an empty inventory",
    async () => {
      const now = await inventory();
      return now.vms.length === 0 && now.gateways.length === 0 ? true : undefined;
    },
    60_000,
    2000,
  ).catch(() => false);
  if (empty) return undefined;
  const left = await inventory();
  // After the leak is recorded: the VMs outside Boat's API, and this run's own (labelled) gateway
  // objects, so one leak does not fail every later scenario's inventory too.
  for (const vm of left.vms) await stack.boat.forceRemove(vm.id);
  if (left.gatewayContainers.length > 0) await docker(["rm", "-f", ...left.gatewayContainers]);
  for (const network of left.gatewayNetworks) await docker(["network", "rm", network]);
  return `inventory not empty 60 s after the scenario (no marker excuses this): live VMs ${left.vms.map((vm) => `${vm.id}:${vm.state}:${vm.labels["sealant-run"] ?? "no run"}`).join(", ") || "none"}; gateway objects ${left.gateways.join(", ") || "none"}`;
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
      await runScenario(defect, body, async (outcome) => {
        // A discard is cleanup after a real failure, or under a marker whose defect leaves the
        // launch for the owner's discard; otherwise a launch that needed one leaked.
        const cleanup =
          outcome.bodyFailed &&
          (outcome.excusedBy === undefined || outcome.excusedBy.releasedByDiscard === true);
        const leaks: string[] = [];
        for (const run of takeLaunched())
          await assertReleased(stack, run, { bodyFailed: cleanup }).catch((error: unknown) => {
            leaks.push(`${run.runId}: ${error instanceof Error ? error.message : String(error)}`);
          });
        const leftOver = await emptyInventory();
        if (leftOver !== undefined) leaks.push(leftOver);
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
 * through the tunnel, a container reaching the Internet, a two-stage Node build with `npm ci`, the
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
  await step("Stop", () => cleanStop(run));
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
  fault("tunnel carrier refused", scenarios.carrierRefused);
  fault("db stopped by a person", scenarios.resourceStopped);
  fault("worker killed after bind", scenarios.workerKilled);
  fault("Stop after the launch", scenarios.stopAfterLaunch);
  fault("deletion stuck in processing", scenarios.deletionStuck);
});

// Workspaces created without resources (#589): no gateway, tunnel or in-VM resolver.
describe("workspaces without resources", () => {
  scenario(
    "no resources: launch, link refused, Stop, resume",
    undefined,
    () => noResourcesLifecycle(stack, project, step),
    40 * 60_000,
  );
  scenario("no resources: deletion stuck in processing", undefined, () =>
    noResourcesDeletionStuck(stack, project),
  );
  scenario("no resources: worker killed between DELETE and completed", undefined, () =>
    noResourcesWorkerKilledDuringDelete(stack, project),
  );
  // Restarts the worker without its gateway, and with it again when it ends.
  scenario("worker without a resource gateway", undefined, () => gatewaylessWorker(stack, project));
});
