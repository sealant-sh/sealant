/**
 * One fault per lifecycle step. Each scenario arms faults on the fake Boat (or the twin, the
 * gateway, the resource or the worker), launches through the SDK, and ends with `assertSettled`.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "vitest";

import { CACHE_LABEL, docker, dockerOk } from "./docker.js";
import type { FakeBoatFaults, FakeSandbox } from "./fake-boat.js";
import {
  assertSettled,
  awaitOutcome,
  guestEvidence,
  launch,
  runtimeView,
  startDatabase,
  until,
  type Launch,
  type Project,
  type SettleExpectation,
} from "./scenario.js";
import type { HarnessStack } from "./stack.js";

/** Production session VMs carry `sealant-run`; build VMs do not. */
export const isSession = (sandbox: Pick<FakeSandbox, "labels">) =>
  sandbox.labels["sealant-run"] !== undefined;

export const withFaults = async <T>(
  stack: HarnessStack,
  faults: FakeBoatFaults,
  body: () => Promise<T>,
): Promise<T> => {
  stack.boat.faults = faults;
  try {
    return await body();
  } finally {
    stack.boat.faults = {};
  }
};

/** Launch, expect it not to become ready, and check the failure settles cleanly. */
export const failedLaunch = async (
  stack: HarnessStack,
  project: Project,
  expectation: SettleExpectation,
  during?: (run: Launch) => Promise<void>,
): Promise<Launch> => {
  const run = await launch(stack, project);
  const work = during?.(run);
  const outcome = await awaitOutcome(stack, run, 10 * 60_000);
  await work;
  if (outcome.status === "ready")
    throw new Error(`launch became ready despite the fault: ${JSON.stringify(outcome.view)}`);
  await assertSettled(stack, run, outcome.at, {
    terminal: ["failed", "stopped"],
    ...expectation,
  });
  return run;
};

/** Launch, expect readiness, then stop and check the stop settles cleanly. */
export const readyThenStop = async (stack: HarnessStack, project: Project): Promise<Launch> => {
  const run = await launch(stack, project);
  const outcome = await awaitOutcome(stack, run, 10 * 60_000);
  if (outcome.status !== "ready")
    throw new Error(
      `launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, run.runId)}`,
    );
  const stoppedAt = Date.now();
  await run.workspace.stop();
  await assertSettled(stack, run, stoppedAt, { terminal: ["stopped"] });
  return run;
};

const commandFault =
  (pattern: RegExp, fault: NonNullable<ReturnType<NonNullable<FakeBoatFaults["command"]>>>) =>
  (command: string, sandbox: FakeSandbox) =>
    isSession(sandbox) && pattern.test(command) ? fault : undefined;

const BIND = /guest_boot\.py bind/;

export const scenarios = {
  /** Run 6's class: Boat accepts create, but the reply is lost. Core must adopt the one VM. */
  async createReplyLost(stack: HarnessStack, project: Project) {
    let armed = true;
    await withFaults(
      stack,
      {
        create: (body) => {
          const labels = body.labels;
          if (!armed || typeof labels !== "object" || labels === null || !("sealant-run" in labels))
            return undefined;
          armed = false;
          return "lose-reply";
        },
      },
      async () => {
        const run = await readyThenStop(stack, project);
        const created = stack.boat.events.filter(
          (event) =>
            event.kind === "create" &&
            stack.boat.sandboxes.get(event.sandboxId ?? "")?.labels["sealant-run"] === run.runId,
        );
        expect(created).toHaveLength(1);
      },
    );
  },

  /** Boat never leaves provisioning. Core must give up within its budget and delete the VM. */
  async provisioningStuck(stack: HarnessStack, project: Project) {
    await withFaults(
      stack,
      {
        create: (body) =>
          typeof body.labels === "object" && body.labels !== null && "sealant-run" in body.labels
            ? "stuck"
            : undefined,
      },
      () =>
        failedLaunch(stack, project, { cause: /allocation|provision|pending|lifetime|hydrat/i }),
    );
  },

  /** Run 7's class: bind exits non-zero in the guest. */
  async bindExits(stack: HarnessStack, project: Project) {
    await withFaults(
      stack,
      { command: commandFault(BIND, { kind: "exit", code: 1, stderr: "harness: bind refused" }) },
      () => failedLaunch(stack, project, { cause: /bind|exchange|guest-command/i }),
    );
  },

  /** A guest command that never finishes inside Boat's timeout. */
  async bindTimesOut(stack: HarnessStack, project: Project) {
    await withFaults(stack, { command: commandFault(BIND, { kind: "timeout" }) }, () =>
      failedLaunch(stack, project, { cause: /bind|exchange|timed?[- ]?out|guest-command/i }),
    );
  },

  /** Run 4's class: Boat drops the command's HTTP reply after it ran. */
  async bindReplyDropped(stack: HarnessStack, project: Project) {
    await withFaults(stack, { command: commandFault(BIND, { kind: "drop", afterMs: 2000 }) }, () =>
      failedLaunch(stack, project, { cause: /bind|exchange|transport/i }),
    );
  },

  /**
   * The worker's 30 s Boat sweep drives every bound allocation through `execution.exchange`,
   * including one whose launch is mid-exchange. Slow the launch's first bind past one sweep
   * period: the sweep's own bind then wins `exchange -> control`. The launch must adopt that
   * result, not fail.
   */
  async bindSlowerThanSweep(stack: HarnessStack, project: Project) {
    let first = true;
    await withFaults(
      stack,
      {
        command: (command, sandbox) => {
          if (!first || !isSession(sandbox) || !BIND.test(command)) return undefined;
          first = false;
          return { kind: "delay", ms: 40_000 };
        },
      },
      async () => {
        const run = await launch(stack, project);
        const outcome = await awaitOutcome(stack, run, 10 * 60_000);
        if (outcome.view.error !== null && /stale-transition/.test(outcome.view.error))
          throw new Error(`launch lost the exchange race to the sweep: ${outcome.view.error}`);
        // The delay must have landed on the launch's first bind.
        expect(
          stack.boat.events.filter((event) => event.kind === "fault:detached-delay"),
        ).toHaveLength(1);
        // Past the race the launch must become ready; a later failure is named at its outcome.
        if (outcome.status !== "ready")
          throw new Error(
            `launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, run.runId)}`,
          );
        const at = Date.now();
        await run.workspace.stop();
        await assertSettled(stack, run, at, { terminal: ["stopped"] });
      },
    );
  },

  /** Run 8's class: the relay is up but the receiver never starts. */
  async receiverAbsent(stack: HarnessStack, project: Project) {
    await withFaults(
      stack,
      {
        // Run 8's state: the receiver unit is active but has no socket, and the relay is up.
        // Stopping the unit would stop the relay too (`Requires=`), so swap its process instead.
        afterCommand: async (command, sandbox) => {
          if (!isSession(sandbox) || !BIND.test(command)) return;
          await stack.boat.guestRoot(
            sandbox.id,
            [
              "install -d /run/systemd/system/sealant-bootstrap.service.d",
              "printf '[Service]\\nExecStart=\\nExecStart=/bin/sleep infinity\\n' > /run/systemd/system/sealant-bootstrap.service.d/boat-harness.conf",
              "systemctl daemon-reload",
              "systemctl restart sealant-bootstrap.service",
              "rm -f /run/sealant-bootstrap/receiver.sock",
              "systemctl is-active sealant-control-relay.service",
            ].join(" && "),
          );
        },
      },
      () => failedLaunch(stack, project, { cause: /receiver|503|status|bind/i }),
    );
    // The fault must have landed: a failing hook would make this a different scenario.
    expect(stack.boat.events.filter((event) => event.kind === "fault:after-command-error")).toEqual(
      [],
    );
  },

  /** The receiver answers a permanent or transient refusal on permit. */
  receiverRefuses: (status: 400 | 409 | 503) =>
    async function receiverRefuses(stack: HarnessStack, project: Project) {
      await withFaults(
        stack,
        {
          proxy: (path, method, sandbox) =>
            isSession(sandbox) && method === "POST" && path === "/sealant/bootstrap/permit"
              ? {
                  kind: "status",
                  status,
                  body: JSON.stringify({
                    error:
                      status === 409
                        ? "workspace-limits-unavailable"
                        : status === 400
                          ? "invalid-request"
                          : "receiver-unavailable",
                  }),
                }
              : undefined,
        },
        () =>
          failedLaunch(stack, project, {
            cause: new RegExp(`permit[\\s\\S]*${status}|${status}[\\s\\S]*permit`),
          }),
      );
    },

  /** Run 11's class: dnsmasq starts 8 s late. Core must wait for the gateway, not race it. */
  async gatewaySlow(stack: HarnessStack, project: Project) {
    const image = (
      await dockerOk(["image", "inspect", "-f", "{{.Id}}", await slowGatewayImage()])
    ).trim();
    await stack.killWorker();
    await stack.startWorker({ SEALANT_BOAT_GATEWAY_IMAGE: image });
    try {
      await readyThenStop(stack, project);
    } finally {
      await stack.killWorker();
      await stack.startWorker();
    }
  },

  /** The gateway container dies after Core configured it, before the guest joins its tunnel. */
  async gatewayCrashes(stack: HarnessStack, project: Project) {
    let killed = false;
    await withFaults(
      stack,
      {
        beforeProxy: async (path, method, sandbox) => {
          if (
            killed ||
            !isSession(sandbox) ||
            method !== "POST" ||
            path !== "/sealant/bootstrap/isolate"
          )
            return;
          killed = true;
          const names = (await stack.ownedObjects()).containers.filter((name) =>
            name.startsWith("boat-tunnel-"),
          );
          if (names.length > 0) await docker(["kill", ...names]);
        },
      },
      () => failedLaunch(stack, project, { cause: /handshake|gateway|tunnel/i }),
    );
    expect(killed).toBe(true);
  },

  /** The WireGuard UDP path from the VM to the gateway is blocked. */
  async udpBlocked(stack: HarnessStack, project: Project) {
    await withFaults(
      stack,
      {
        beforeCommand: async (command, sandbox) => {
          if (isSession(sandbox) && BIND.test(command))
            await stack.boat.guestRoot(
              sandbox.id,
              "nft add table inet boat_harness && nft add chain inet boat_harness out '{ type filter hook output priority -100; }' && nft add rule inet boat_harness out udp dport 40000-40015 drop",
            );
        },
      },
      () => failedLaunch(stack, project, { cause: /handshake|tunnel/i }),
    );
  },

  /** Run 9's preflight case: a person stopped `db`. The launch must not depend on it. */
  async resourceStopped(stack: HarnessStack, project: Project) {
    await project.scope.instances.stop("db", { kind: "person", by: "boat harness" });
    try {
      await readyThenStop(stack, project);
    } finally {
      await startDatabase(project);
    }
  },

  /** S3: the worker dies between durable writes, here right after bind. A restart must converge. */
  async workerKilled(stack: HarnessStack, project: Project) {
    let killed: Promise<void> | undefined;
    await withFaults(
      stack,
      {
        command: (command, sandbox) => {
          if (killed === undefined && isSession(sandbox) && BIND.test(command))
            killed = (async () => {
              await new Promise((done) => setTimeout(done, 1500));
              await stack.killWorker();
              await stack.startWorker();
            })();
          return undefined;
        },
      },
      async () => {
        const run = await launch(stack, project);
        // A restarted worker that adopts the launch settles it well inside five minutes.
        const outcome = await awaitOutcome(stack, run, 5 * 60_000);
        await killed;
        if (outcome.status === "ready") {
          const at = Date.now();
          await run.workspace.stop();
          await assertSettled(stack, run, at, { terminal: ["stopped"] });
        } else await assertSettled(stack, run, outcome.at);
      },
    );
  },

  /**
   * Mend stops a session whose launch Core kept (`retained`) or that became ready. FINAL close
   * must reach the guest (recover through the relay), save, delete the VM and end the drain.
   */
  async stopAfterLaunch(stack: HarnessStack, project: Project) {
    await readyThenStop(stack, project);
  },

  /**
   * Boat's deletion stays `processing`. The launch fails at permit, after its UDP slot and
   * publication pin are held. While Boat says `processing` the VM is not gone, so Core must keep
   * both; once the deletion completes it must release them.
   */
  async deletionStuck(stack: HarnessStack, project: Project) {
    let stuck: string | undefined;
    await withFaults(
      stack,
      {
        proxy: (path, method, sandbox) =>
          isSession(sandbox) && method === "POST" && path === "/sealant/bootstrap/permit"
            ? {
                kind: "status",
                status: 409,
                body: JSON.stringify({ error: "workspace-limits-unavailable" }),
              }
            : undefined,
        deletion: (sandbox) => {
          if (!isSession(sandbox)) return undefined;
          stuck = sandbox.id;
          return "stuck";
        },
      },
      async () => {
        const run = await launch(stack, project);
        const outcome = await awaitOutcome(stack, run, 10 * 60_000);
        expect(outcome.status).not.toBe("ready");
        const id = await until("a stuck deletion", async () => stuck, 3 * 60_000);
        // Two sweeps with Boat still `processing`: nothing may be released yet.
        await new Promise((done) => setTimeout(done, 65_000));
        const held = await runtimeView(stack, run.runId);
        expect(held.allocation).not.toBe("deleted");
        expect(held.has_tunnel).toBe(true);
        expect(held.tunnel_released).toBe(false);
        expect(held.pin).not.toBe("released");
        expect(stack.boat.liveSandboxes().some((vm) => vm.id === id)).toBe(true);
        await stack.boat.completeDeletion(id);
        await assertSettled(stack, run, Date.now(), { terminal: ["failed", "stopped"] });
      },
    );
  },
};

/** The real gateway with dnsmasq started 8 s late, as `boat-tunnel.e2e.ts` builds it. */
const slowGatewayImage = async (): Promise<string> => {
  const tag = "sealant-boat-harness-gateway:slow-dnsmasq";
  const cached = await docker(["image", "inspect", "-f", "{{.Id}}", tag]);
  if (cached.code === 0) return tag;
  const context = await mkdtemp(join(tmpdir(), "boat-harness-slow-gateway."));
  try {
    const source = await readFile(new URL("../boat-tunnel/gateway.py", import.meta.url), "utf8");
    const delayed = source.replace(
      "    child = subprocess.Popen(['dnsmasq'",
      "    time.sleep(8)\n    child = subprocess.Popen(['dnsmasq'",
    );
    if (delayed === source) throw new Error("missing the real gateway serve seam");
    await writeFile(join(context, "gateway.py"), delayed);
    await writeFile(
      join(context, "Dockerfile"),
      await readFile(new URL("../boat-tunnel/Dockerfile", import.meta.url), "utf8"),
    );
    await dockerOk(["build", "-q", "--label", CACHE_LABEL, "-t", tag, context], {
      timeoutMs: 15 * 60_000,
    });
    return tag;
  } finally {
    await rm(context, { recursive: true, force: true });
  }
};
