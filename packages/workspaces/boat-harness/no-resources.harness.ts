/**
 * Workspaces created without resources (#589): no gateway, tunnel or in-VM resolver. Then the
 * shared stop's worker-killed cases (#600, sealant#612), one of them without resources: a worker
 * killed the moment Boat accepts the Stop's DELETE.
 */
import { describe } from "vitest";

import { harnessFile, step } from "./harness-file.js";
import {
  gatewaylessWorker,
  noResourcesDeletionStuck,
  noResourcesLifecycle,
  noResourcesWorkerKilledDuringDelete,
} from "./no-resources-scenario.js";
import {
  workerKilledAtDeleteNoResources,
  workerKilledAtDeleteTunnel,
  workerKilledDuringStuckDeletionTunnel,
} from "./shared-stop-scenario.js";

const { scenario } = harnessFile({ publishSnapshot: true });

describe("workspaces without resources", () => {
  scenario(
    "no resources: launch, link refused, Stop, resume",
    undefined,
    (stack, project) => noResourcesLifecycle(stack, project, step),
    40 * 60_000,
  );
  scenario("no resources: deletion stuck in processing", undefined, noResourcesDeletionStuck);
  scenario(
    "no resources: worker killed between DELETE and completed",
    undefined,
    noResourcesWorkerKilledDuringDelete,
  );
  // Restarts the worker without its gateway, and with it again when it ends.
  scenario("worker without a resource gateway", undefined, gatewaylessWorker);
});

describe("the shared stop", () => {
  scenario(
    "worker killed at the DELETE (tunnel): terminal once its claim lapses (sealant#612)",
    undefined,
    workerKilledAtDeleteTunnel,
  );
  scenario(
    "worker killed at the DELETE (no resources): terminal once its claim lapses (sealant#612)",
    undefined,
    workerKilledAtDeleteNoResources,
  );
  scenario(
    "worker killed at the DELETE, deletion stuck (tunnel): terminal once both end (sealant#612)",
    undefined,
    workerKilledDuringStuckDeletionTunnel,
  );
});
