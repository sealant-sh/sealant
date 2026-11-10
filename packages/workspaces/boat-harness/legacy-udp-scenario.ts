/**
 * The legacy UDP mode of the resource tunnel, isolated so it can be deleted with that mode: the
 * worker has a public gateway endpoint and no relay host, so the guest dials the gateway over UDP
 * and nothing is carried. The rest of the harness runs carried (`SEALANT_BOAT_GATEWAY_RELAY_HOST`).
 */
import { expect } from "vitest";

import { assertSettled, awaitOutcome, guestEvidence, launch, type Project } from "./scenario.js";
import type { HarnessStack } from "./stack.js";

export const legacyUdpTunnel = async (stack: HarnessStack, project: Project) => {
  await stack.restartWorker(stack.legacyUdpTunnel);
  try {
    const run = await launch(stack, project);
    const outcome = await awaitOutcome(stack, run, 10 * 60_000);
    if (outcome.status !== "ready")
      throw new Error(
        `launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, run.runId)}`,
      );
    const reached = await run.workspace.exec([
      "/bin/sh",
      "-c",
      "timeout 5 bash -c 'exec 3<>/dev/tcp/db/5432' && echo reached",
    ]);
    if (reached.exitCode !== 0)
      throw new Error(`db:5432 unreachable over the UDP tunnel: ${reached.stderr.slice(-500)}`);
    const sandbox = outcome.view.sandbox;
    expect(
      stack.boat.events.some(
        (event) =>
          event.kind === "proxy-upgrade" &&
          event.sandboxId === sandbox &&
          event.detail === "/sealant/tunnel",
      ),
    ).toBe(false);
    const stoppedAt = Date.now();
    await run.workspace.stop();
    await assertSettled(stack, run, stoppedAt, { terminal: ["stopped"] });
  } finally {
    await stack.restartWorker();
  }
};
