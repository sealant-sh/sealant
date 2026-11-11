/**
 * Boat workspaces created without resources (SDK `resources: "none"`, #589): no gateway, tunnel or
 * in-VM resolver, readiness without a handshake, a close on the allocation's own removal record,
 * and a link refused. Every launch here also passes the release checks and invariants the rest of
 * the harness runs after each scenario (FINAL before the delete, never two VMs, an empty inventory).
 */
import { randomBytes } from "node:crypto";

import { SealantApiError } from "@sealant/sdk";
import { expect } from "vitest";
import { z } from "zod";

import { isSession, withFaults } from "./faults.js";
import {
  assertReleased,
  assertSettled,
  awaitOutcome,
  cleanStop,
  guestEvidence,
  launch,
  runtimeView,
  sqlText,
  until,
  type Launch,
  type Project,
} from "./scenario.js";
import type { HarnessStack } from "./stack.js";

type Step = <T>(name: string, body: () => Promise<T>) => Promise<T>;

/** The tunnel's client address: the VM's resolver listens there when a run has a tunnel. */
const TUNNEL_CLIENT = "100.127.255.254";

const ready = async (stack: HarnessStack, run: Launch) => {
  const outcome = await awaitOutcome(stack, run, 30 * 60_000);
  if (outcome.status !== "ready")
    throw new Error(
      `launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, run.runId)}`,
    );
  const sandbox = outcome.view.sandbox;
  if (sandbox === null) throw new Error(`ready without a VM: ${JSON.stringify(outcome.view)}`);
  return { sandbox, at: outcome.at };
};

/** No gateway object on the host and no tunnel row for the run. */
const assertNoGateway = async (stack: HarnessStack, run: Launch) => {
  const owned = await stack.ownedObjects();
  const gateways = [...owned.containers, ...owned.networks].filter((name) =>
    name.startsWith("boat-tunnel-"),
  );
  expect(gateways).toEqual([]);
  const [row] = await stack.query(
    `select count(*)::int as tunnels from boat_tunnels where runtime_instance_id = '${sqlText(run.runId)}'`,
  );
  expect(z.object({ tunnels: z.number() }).parse(row).tunnels).toBe(0);
};

/** The run's row carries the option and what the launch was isolated under, frozen at launch. */
const assertRecordsNone = async (stack: HarnessStack, run: Launch) => {
  const [row] = await stack.query(
    `select resources as allocation, isolation from boat_runs where run_id = '${sqlText(run.runId)}'`,
  );
  expect(row).toEqual({ allocation: "none", isolation: { resources: "none" } });
};

/** In the VM: no tunnel interface, no resolver, resolv.conf as the image left it, public DNS works. */
const assertVmUntouched = async (stack: HarnessStack, sandbox: string) => {
  const problems = await stack.boat.guestRoot(
    sandbox,
    [
      'if ip link show sealant-wg >/dev/null 2>&1; then echo "sealant-wg exists"; fi',
      `if [ -n "$(ss -Hlnu 'sport = :53')$(ss -Hlnt 'sport = :53')" ]; then echo "something listens on port 53"; fi`,
      `if grep -q '${TUNNEL_CLIENT}' /etc/resolv.conf; then echo "resolv.conf names the tunnel's resolver"; fi`,
      'if [ -e /var/lib/sealant/agent/resolv.conf.orig ]; then echo "resolv.conf was replaced"; fi',
      'getent hosts registry-1.docker.io >/dev/null || echo "a public name does not resolve"',
    ].join("\n"),
  );
  expect(problems.trim()).toBe("");
};

/** Readiness never asked for a network or carried a tunnel: no handshake or DNS wait. */
const assertNoNetworkCalls = (stack: HarnessStack, sandbox: string) => {
  const calls = stack.boat.events.filter(
    (event) =>
      event.sandboxId === sandbox &&
      ((event.kind === "proxy" && (event.detail ?? "").includes("/sealant/network")) ||
        (event.kind === "proxy-upgrade" && event.detail === "/sealant/tunnel")),
  );
  expect(calls.map((event) => `${event.kind} ${event.detail ?? ""}`)).toEqual([]);
};

/** Boat was asked to delete the VM exactly once, and Core polled that deletion operation. */
const assertOneDelete = (stack: HarnessStack, sandbox: string) => {
  const deletes = stack.boat.events.filter(
    (event) => event.kind === "delete" && event.sandboxId === sandbox,
  );
  expect(deletes).toHaveLength(1);
  const operation = deletes[0]?.detail ?? "";
  expect(
    stack.boat.events.some(
      (event) => event.kind === "api" && event.detail === `GET /deletion-operations/${operation}`,
    ),
  ).toBe(true);
};

const sh = async (run: Launch, script: string) => {
  const result = await run.workspace.exec(["/bin/sh", "-c", script]);
  if (result.exitCode !== 0)
    throw new Error(`exit ${result.exitCode}: ${result.stderr.slice(-1000)}`);
  return result.stdout;
};

/**
 * The whole life of a run without resources: launch, no gateway or tunnel anywhere, a refused link
 * that leaves the session running, an edit, a clean Stop (FINAL, one DELETE, its poll, discharge),
 * and the saved work back on a fresh VM, which closes the same way.
 */
export const noResourcesLifecycle = async (stack: HarnessStack, project: Project, step: Step) => {
  const marker = `boat-harness no-resources ${randomBytes(16).toString("hex")}\n`;
  const first = await step("launch (no resources)", () =>
    launch(stack, project, { resources: "none" }),
  );
  const { sandbox } = await step("ready", () => ready(stack, first));
  await step("no gateway, tunnel row or resolver; records say none", async () => {
    await assertNoGateway(stack, first);
    await assertRecordsNone(stack, first);
    await assertVmUntouched(stack, sandbox);
    assertNoNetworkCalls(stack, sandbox);
  });
  await step("link is refused and the session keeps running", async () => {
    const refused: unknown = await project.scope.workspaces
      .link(first.workspace.id, { worktreeKey: first.worktreeKey })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    if (!(refused instanceof SealantApiError))
      throw new Error(`link was not refused with a SealantApiError: ${String(refused)}`);
    expect({ code: refused.code, reason: refused.reason }).toEqual({
      code: "ResourceWorkspaceWithoutResourcesError",
      reason: "workspace-without-resources",
    });
    expect(await first.workspace.status()).toBe("ready");
    expect((await sh(first, "id -un")).trim()).not.toBe("");
  });
  await step("edit", () =>
    sh(
      first,
      `printf '%s' '${marker.trimEnd()}' > no-resources-proof.txt && echo >> no-resources-proof.txt`,
    ),
  );
  const stoppedAt = Date.now();
  await step("Stop", () => cleanStop(first));
  await step("FINAL, one DELETE, its poll, release", async () => {
    await assertSettled(stack, first, stoppedAt, { terminal: ["stopped"] });
    await assertReleased(stack, first, { discard: false });
    assertOneDelete(stack, sandbox);
    await assertNoGateway(stack, first);
  });
  const resumed = await step("resume on a fresh VM", () =>
    launch(stack, project, { resources: "none", resume: first.capture }),
  );
  const second = await step("resumed ready", () => ready(stack, resumed));
  expect(second.sandbox).not.toBe(sandbox);
  await step("byte compare", async () => {
    expect(await sh(resumed, "cat no-resources-proof.txt")).toBe(marker);
  });
  await step("resumed: no gateway or resolver", async () => {
    await assertNoGateway(stack, resumed);
    await assertVmUntouched(stack, second.sandbox);
  });
  const finalAt = Date.now();
  await step("final Stop", () => cleanStop(resumed));
  await step("final release", async () => {
    await assertSettled(stack, resumed, finalAt, { terminal: ["stopped"] });
    await assertReleased(stack, resumed, { discard: false });
    assertOneDelete(stack, second.sandbox);
  });
};

/**
 * A clean Stop of a run without resources whose deletion Boat keeps `processing`. The deletion id
 * lives on the allocation's own removal record (there is no tunnel row), so while Boat says
 * `processing` nothing may be released; `worker` set kills the worker after the DELETE and starts
 * it again, and the restarted worker must poll the same operation: no second DELETE, no second
 * FINAL. Once Boat completes the deletion, the run closes.
 */
const stopWithStuckDeletion = async (
  stack: HarnessStack,
  project: Project,
  options: { readonly killWorker: boolean },
) => {
  let stuck: string | undefined;
  await withFaults(
    stack,
    {
      deletion: (sandbox) => {
        if (!isSession(sandbox)) return undefined;
        stuck = sandbox.id;
        return "stuck";
      },
    },
    async () => {
      const run = await launch(stack, project, { resources: "none" });
      const { sandbox } = await ready(stack, run);
      await cleanStop(run);
      const deleteAt = await until(
        "Boat to be asked to delete the VM",
        async () =>
          stack.boat.events.find((event) => event.kind === "delete" && event.sandboxId === sandbox)
            ?.at,
        3 * 60_000,
      );
      if (options.killWorker) {
        await stack.killWorker();
        await stack.startWorker();
      }
      // Two sweeps with Boat still `processing`: nothing may be released yet.
      await new Promise((done) => setTimeout(done, 65_000));
      const held = await runtimeView(stack, run.runId);
      expect(held.allocation).not.toBe("deleted");
      expect(held.removed).toBe(false);
      expect(held.has_tunnel).toBe(false);
      expect(held.pin).not.toBe("released");
      expect(stack.boat.liveSandboxes().some((vm) => vm.id === sandbox)).toBe(true);
      expect(stuck).toBe(sandbox);
      await stack.boat.completeDeletion(sandbox);
      await assertSettled(stack, run, Date.now(), { terminal: ["stopped"] });
      await assertReleased(stack, run, { discard: false });
      assertOneDelete(stack, sandbox);
      // No second FINAL: nothing registered on the channel after the DELETE.
      const after = (await run.capture.state()).registers.filter(
        (register) => register.at > deleteAt,
      );
      expect(after).toEqual([]);
    },
  );
};

export const noResourcesDeletionStuck = (stack: HarnessStack, project: Project) =>
  stopWithStuckDeletion(stack, project, { killWorker: false });

export const noResourcesWorkerKilledDuringDelete = (stack: HarnessStack, project: Project) =>
  stopWithStuckDeletion(stack, project, { killWorker: true });

/**
 * A worker with no resource gateway (the three gateway settings removed): a run without resources
 * launches and closes; a run without the option fails with `gateway-unavailable`, and Boat is never
 * asked for a VM. The worker gets its gateway back afterwards.
 */
export const gatewaylessWorker = async (stack: HarnessStack, project: Project) => {
  await stack.restartWorker({
    SEALANT_BOAT_GATEWAY_HOST_ID: undefined,
    SEALANT_BOAT_GATEWAY_RELAY_HOST: undefined,
    SEALANT_BOAT_GATEWAY_IMAGE: undefined,
  });
  try {
    const none = await launch(stack, project, { resources: "none" });
    const { sandbox } = await ready(stack, none);
    await assertNoGateway(stack, none);
    const stoppedAt = Date.now();
    await cleanStop(none);
    await assertSettled(stack, none, stoppedAt, { terminal: ["stopped"] });
    await assertReleased(stack, none, { discard: false });
    assertOneDelete(stack, sandbox);

    const linked = await launch(stack, project);
    const outcome = await awaitOutcome(stack, linked, 10 * 60_000);
    expect(outcome.status).not.toBe("ready");
    await assertSettled(stack, linked, outcome.at, {
      terminal: ["failed", "stopped"],
      cause: /gateway-unavailable/,
    });
    expect(
      [...stack.boat.sandboxes.values()].filter((vm) => vm.labels["sealant-run"] === linked.runId),
    ).toEqual([]);
  } finally {
    await stack.restartWorker();
  }
};
