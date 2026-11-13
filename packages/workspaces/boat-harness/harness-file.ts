/**
 * What every `*.harness.ts` file shares. Each file brings up its own stack (its own host lock,
 * database, fake Boat and worker), so CI can run the files on separate runners; the scenarios inside
 * a file share that stack and run in order. Every scenario ends with the same checks: each launch it
 * made released, and the whole inventory empty.
 */
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, it } from "vitest";

import { DEFECTS } from "./defects.js";
import { docker } from "./docker.js";
import { runScenario, type Defect } from "./markers.js";
import {
  assertReleased,
  awaitOutcome,
  cleanStop,
  guestEvidence,
  launch,
  openProject,
  takeLaunched,
  until,
  type Project,
} from "./scenario.js";
import { startStack, type HarnessStack } from "./stack.js";

/** A scenario's body, run on its file's stack and project. */
export type ScenarioBody = (stack: HarnessStack, project: Project) => Promise<void>;

/** Prefixes a failure with the lifecycle step it happened in. */
export const step = async <T>(name: string, body: () => Promise<T>): Promise<T> => {
  process.stderr.write(`[boat-harness] step ${name}\n`);
  try {
    return await body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`step ${name}: ${message}`, { cause: error });
  }
};

/** Live VMs and Boat gateway objects on this host, whatever run (or none) they are labelled with. */
const isGateway = (name: string) => name.startsWith("boat-tunnel-");

const inventory = async (stack: HarnessStack) => {
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
const emptyInventory = async (stack: HarnessStack): Promise<string | undefined> => {
  const empty = await until(
    "an empty inventory",
    async () => {
      const now = await inventory(stack);
      return now.vms.length === 0 && now.gateways.length === 0 ? true : undefined;
    },
    60_000,
    2000,
  ).catch(() => false);
  if (empty) return undefined;
  const left = await inventory(stack);
  // After the leak is recorded: the VMs outside Boat's API, and this run's own (labelled) gateway
  // objects, so one leak does not fail every later scenario's inventory too.
  for (const vm of left.vms) await stack.boat.forceRemove(vm.id);
  if (left.gatewayContainers.length > 0) await docker(["rm", "-f", ...left.gatewayContainers]);
  for (const network of left.gatewayNetworks) await docker(["network", "rm", network]);
  return `inventory not empty 60 s after the scenario (no marker excuses this): live VMs ${left.vms.map((vm) => `${vm.id}:${vm.state}:${vm.labels["sealant-run"] ?? "no run"}`).join(", ") || "none"}; gateway objects ${left.gateways.join(", ") || "none"}`;
};

/**
 * Publishes the native snapshot before a file's first scenario: one plain launch, ready, a clean
 * Stop and its release, then an empty inventory. In a single stack every scenario after the happy
 * path found the snapshot the happy path published; a file that does not open with the happy path
 * does this instead, so its first scenario does not also build one.
 */
const publishSnapshot = async (stack: HarnessStack, project: Project) => {
  const run = await launch(stack, project);
  const outcome = await awaitOutcome(stack, run, 30 * 60_000);
  if (outcome.status !== "ready")
    throw new Error(
      `publishing the native snapshot: the launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, run.runId)}`,
    );
  await cleanStop(run);
  await assertReleased(stack, run, { discard: false });
  takeLaunched();
  const leftOver = await emptyInventory(stack);
  if (leftOver !== undefined) throw new Error(`publishing the native snapshot: ${leftOver}`);
};

export interface HarnessFileOptions {
  /**
   * Publish the native snapshot once the stack is up. Off only for a file whose first scenario is
   * the happy path, which builds and publishes it itself.
   */
  readonly publishSnapshot: boolean;
}

/**
 * Brings up this file's stack before its first scenario and tears it down after its last, and
 * returns how the file registers its scenarios.
 */
export const harnessFile = (options: HarnessFileOptions) => {
  let started: { readonly stack: HarnessStack; readonly project: Project } | undefined;

  beforeAll(async () => {
    const stack = await startStack();
    const project = await openProject(stack);
    if (options.publishSnapshot) await publishSnapshot(stack, project);
    started = { stack, project };
  });

  afterAll(async () => {
    if (started === undefined) return;
    const { stack } = started;
    await stack.stop();
    // Keep the run's logs beside the scenario evidence when a proof directory was given.
    const proof = process.env.BOAT_TWIN_PROOF_DIR;
    if (proof === undefined) return;
    const logs = join(proof, "harness-logs", stack.runId);
    await mkdir(logs, { recursive: true });
    for (const name of await readdir(stack.scratch).catch(() => []))
      if (/\.(log|json)$/.test(name))
        await copyFile(join(stack.scratch, name), join(logs, name)).catch(() => undefined);
  });

  /**
   * Runs a scenario as passing, or as an expected failure naming its defect. Either way, every
   * launch it made must then be released: a marker excuses its named step's failure, never a leak.
   */
  const scenario = (
    name: string,
    defect: Defect | undefined,
    body: ScenarioBody,
    timeoutMs?: number,
  ) =>
    it(
      defect === undefined
        ? name
        : `${name} [${defect.intermittent === true ? "intermittent" : "expected failure"} ${defect.id}: ${defect.title}]`,
      async () => {
        if (started === undefined) throw new Error("the harness stack did not start");
        const { stack, project } = started;
        takeLaunched();
        await runScenario(
          defect,
          () => body(stack, project),
          async (outcome) => {
            // A discard is cleanup after a real failure, or under a marker whose defect leaves the
            // launch for the owner's discard; otherwise a launch that needed one leaked.
            const cleanup =
              outcome.bodyFailed &&
              (outcome.excusedBy === undefined || outcome.excusedBy.releasedByDiscard === true);
            const leaks: string[] = [];
            for (const run of takeLaunched())
              await assertReleased(stack, run, { bodyFailed: cleanup }).catch((error: unknown) => {
                leaks.push(
                  `${run.runId}: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
            const leftOver = await emptyInventory(stack);
            if (leftOver !== undefined) leaks.push(leftOver);
            return leaks;
          },
        );
      },
      timeoutMs,
    );

  /** One fault per step: a scenario named by its key, under that key's marker if it has one. */
  const fault = (key: keyof typeof DEFECTS.faults, body: ScenarioBody) =>
    scenario(key, DEFECTS.faults[key], body);

  return { scenario, fault };
};
