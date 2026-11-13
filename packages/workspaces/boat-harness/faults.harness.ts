/**
 * One fault per lifecycle step, each ending with the same checks: nothing left behind, the tunnel
 * slot and publication pin released, the exact cause on the runtime row, and a terminal workspace
 * for Mend within 60 s. Then resource links on a live session, last.
 */
import { describe } from "vitest";

import { scenarios } from "./faults.js";
import { harnessFile } from "./harness-file.js";
import {
  linkAfterReady,
  linkJobDropped,
  linkWhileStopping,
  relinkRunning,
  stopWhileConfiguring,
} from "./link-scenario.js";

const { scenario, fault } = harnessFile({ publishSnapshot: true });

// In this order: some faults count events across the whole stack (every `fault:detached-delay`,
// every refused create), so no scenario that makes those may run before them.
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
  fault("create refused: Boat key expired", scenarios.createRefused);
});

// Last, after the faults' allocation rows (more than one sweep page of them): a link must reach a
// live session's gateway when it is written, whatever the deployment's history (sealant#594).
describe("resource links on a live session", () => {
  scenario("linked right after ready, db within 10 s", undefined, linkAfterReady);
  scenario("re-linked with a changed map, served within 10 s", undefined, relinkRunning);
  scenario("linked while stopping, nothing changes", undefined, linkWhileStopping);
  scenario("stopped while a link is configuring, one close", undefined, stopWhileConfiguring);
  // Kills the worker for the link and starts it again.
  scenario("link job lost, served within one tick", undefined, linkJobDropped);
});
