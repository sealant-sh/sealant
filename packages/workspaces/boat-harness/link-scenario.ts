/**
 * A resource link reaches a live Boat session's gateway when it is written, not when the worker's
 * sweep next pages to the run (sealant#594, #595). These run last, so the deployment already has
 * the earlier scenarios' allocation rows: before #595 the sweep reached a run once per
 * `ceil(rows / 20)` ticks of 30 s, well past the bounds asserted here.
 */
import { expect } from "vitest";
import { z } from "zod";

import { docker } from "./docker.js";
import {
  assertReleased,
  assertSettled,
  awaitOutcome,
  cleanStop,
  gatewayName,
  guestEvidence,
  launch,
  sqlText,
  until,
  type Launch,
  type Project,
} from "./scenario.js";
import type { HarnessStack } from "./stack.js";

/** A link written to a live session must be served within this, counted from the link call. */
const LINK_BOUND_MS = 10_000;
/** With no link job to act on it, the sweep's live-runs page must serve it within one tick. */
const ONE_TICK_MS = 45_000;

const ready = async (stack: HarnessStack, run: Launch) => {
  const outcome = await awaitOutcome(stack, run, 30 * 60_000);
  if (outcome.status !== "ready" || outcome.view.sandbox === null)
    throw new Error(
      `launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, run.runId)}`,
    );
  return outcome.view.sandbox;
};

/** `db:5432` answers from inside the workspace. */
const reachesDb = async (run: Launch) =>
  (
    await run.workspace.exec([
      "/bin/sh",
      "-c",
      "timeout 3 bash -c 'exec 3<>/dev/tcp/db/5432' && echo reached",
    ])
  ).exitCode === 0;

/** The name `db` resolves inside the workspace. */
const resolvesDb = async (run: Launch) =>
  (await run.workspace.exec(["/bin/sh", "-c", "getent hosts db"])).exitCode === 0;

/** Polls until `probe` holds, and fails if that took longer than `boundMs` since `since`. */
const within = async (
  what: string,
  since: number,
  boundMs: number,
  probe: () => Promise<boolean>,
  evidence: () => Promise<string> = async () => "",
) => {
  // Timed to the start of the probe that first held: the state had changed by then, and a probe
  // can itself take seconds (a failing lookup waits out the resolver's timeouts).
  let heldFrom = 0;
  let probeTook = 0;
  await until(
    what,
    async () => {
      const startedAt = Date.now();
      const held = await probe();
      if (!held) return undefined;
      heldFrom = startedAt;
      probeTook = Date.now() - startedAt;
      return true;
    },
    boundMs + 60_000,
    500,
  );
  const took = heldFrom - since;
  if (took > boundMs)
    throw new Error(
      `${what} took ${(took / 1000).toFixed(1)} s, over the ${boundMs / 1000} s bound (the probe that saw it took ${(probeTook / 1000).toFixed(1)} s); ${await evidence()}`,
    );
  return took;
};

/** Every container and network event naming the gateway since `sinceMs`, as `+seconds action`. */
const gatewayTimeline = async (gateway: string, sinceMs: number) => {
  const events = await docker([
    "events",
    "--since",
    String(sinceMs / 1000),
    "--until",
    String(Date.now() / 1000 + 1),
    "--format",
    "{{.TimeNano}} {{.Type}} {{.Action}} {{.Actor.Attributes.name}} {{.Actor.Attributes.container}}",
  ]);
  return events.stdout
    .split("\n")
    .filter((line) => line.includes(gateway))
    .map((line) => {
      const [nanos = "0", ...rest] = line.split(" ");
      return `+${((Number(nanos) / 1e6 - sinceMs) / 1000).toFixed(1)}s ${rest.slice(0, 3).join(" ")}`;
    })
    .join("; ");
};

const stopCleanly = async (stack: HarnessStack, run: Launch) => {
  const at = Date.now();
  await cleanStop(run);
  await assertSettled(stack, run, at, { terminal: ["stopped"] });
};

/** Docker's own record of what happened to a container since `sinceMs`. */
const containerActions = async (name: string, sinceMs: number) => {
  const events = await docker([
    "events",
    "--since",
    String(Math.floor(sinceMs / 1000)),
    "--until",
    String(Math.floor(Date.now() / 1000) + 1),
    "--filter",
    "type=container",
    "--filter",
    `container=${name}`,
    "--format",
    "{{.Action}}",
  ]);
  return events.stdout.split("\n").filter((line) => line.length > 0);
};

/**
 * A session created unlinked cannot reach `db`; linked right after it is ready, it reaches
 * `db:5432` within 10 s of the link call, with no sweep tick needed.
 */
export const linkAfterReady = async (stack: HarnessStack, project: Project) => {
  const run = await launch(stack, project, { link: false });
  await ready(stack, run);
  expect(await reachesDb(run)).toBe(false);
  const linkedAt = Date.now();
  await project.scope.workspaces.link(run.workspace.id, { worktreeKey: run.worktreeKey });
  await within("db:5432 after the link", linkedAt, LINK_BOUND_MS, () => reachesDb(run));
  await stopCleanly(stack, run);
};

/**
 * Re-linking a running session with a changed alias map is served within seconds: a map that no
 * longer names `db` makes it stop resolving, and naming it again makes it answer.
 */
export const relinkRunning = async (stack: HarnessStack, project: Project) => {
  const run = await launch(stack, project);
  const sandbox = await ready(stack, run);
  await until(
    "db:5432 on the session linked at create",
    async () => ((await reachesDb(run)) ? true : undefined),
    3 * 60_000,
    1000,
  );
  const gateway = (await gatewayName(stack, run.runId)) ?? "boat-tunnel-unknown";
  const removedAt = Date.now();
  await project.scope.workspaces.link(run.workspace.id, {
    worktreeKey: run.worktreeKey,
    aliases: {},
  });
  const removeAnswered = Date.now() - removedAt;
  await within(
    "db to stop resolving after a map without it",
    removedAt,
    LINK_BOUND_MS,
    async () => !(await resolvesDb(run)),
    async () =>
      `link answered after ${(removeAnswered / 1000).toFixed(1)} s; gateway since the link: ${await gatewayTimeline(gateway, removedAt)}`,
  );
  const restoredAt = Date.now();
  await project.scope.workspaces.link(run.workspace.id, {
    worktreeKey: run.worktreeKey,
    aliases: { db: "project" },
  });
  const restoreAnswered = Date.now() - restoredAt;
  await within(
    "db:5432 after a map naming it again",
    restoredAt,
    LINK_BOUND_MS,
    () => reachesDb(run),
    async () =>
      `link answered after ${(restoreAnswered / 1000).toFixed(1)} s; gateway since the link: ${await gatewayTimeline(gateway, restoredAt)}`,
  );
  // The carrier stayed attached throughout: no re-link made sealant open the tunnel again.
  expect(
    stack.boat.events.filter(
      (event) =>
        event.sandboxId === sandbox &&
        event.at >= removedAt &&
        event.kind === "proxy-upgrade" &&
        event.detail === "/sealant/tunnel",
    ),
  ).toEqual([]);
  await stopCleanly(stack, run);
};

/**
 * A link written while the session is stopping changes nothing on its gateway or in its guest, and
 * the close still ends with one FINAL (the release checks' invariant), one gateway removal and one
 * DELETE.
 */
export const linkWhileStopping = async (stack: HarnessStack, project: Project) => {
  const run = await launch(stack, project);
  const sandbox = await ready(stack, run);
  await until(
    "db:5432 before the Stop",
    async () => ((await reachesDb(run)) ? true : undefined),
    3 * 60_000,
    1000,
  );
  const gateway = await gatewayName(stack, run.runId);
  if (gateway === undefined) throw new Error("the run has no gateway name");
  const stoppedAt = Date.now();
  await cleanStop(run);
  const linkedAt = Date.now();
  // Accepted or refused, the link must change nothing on a stopping run.
  await project.scope.workspaces
    .link(run.workspace.id, { worktreeKey: run.worktreeKey, aliases: {} })
    .catch(() => undefined);
  await assertSettled(stack, run, stoppedAt, { terminal: ["stopped"] });
  await assertReleased(stack, run, { discard: false });

  const lifetime = await containerActions(gateway, run.startedAt);
  expect(lifetime.filter((action) => action === "create")).toHaveLength(1);
  expect(lifetime.filter((action) => action === "destroy")).toHaveLength(1);
  const configuredAfterLink = (await containerActions(gateway, linkedAt)).filter(
    (action) => action.startsWith("exec_start") && action.includes("configure"),
  );
  expect(configuredAfterLink).toEqual([]);
  const guestNetworkAfterLink = stack.boat.events.filter(
    (event) =>
      event.sandboxId === sandbox &&
      event.at >= linkedAt &&
      event.kind === "proxy" &&
      (event.detail ?? "").includes("/sealant/network"),
  );
  expect(guestNetworkAfterLink).toEqual([]);
  expect(
    stack.boat.events.filter((event) => event.kind === "delete" && event.sandboxId === sandbox),
  ).toHaveLength(1);
};

/**
 * The Stop arrives while a link's configuration holds the gateway host's lock (each configure is
 * made to take 5 s, and the Stop is sent once one has begun). The close's tunnel freeze waits for
 * that configuration and goes on: the Stop completes in one close, with one FINAL (the release
 * checks' invariant), one gateway creation and removal, and one DELETE.
 */
export const stopWhileConfiguring = async (stack: HarnessStack, project: Project) => {
  const run = await launch(stack, project);
  const sandbox = await ready(stack, run);
  await until(
    "db:5432 before the link",
    async () => ((await reachesDb(run)) ? true : undefined),
    3 * 60_000,
    1000,
  );
  const gateway = await gatewayName(stack, run.runId);
  if (gateway === undefined) throw new Error("the run has no gateway name");
  await stack.slowGatewayConfigure(5);
  let stopTook = 0;
  try {
    await project.scope.workspaces.link(run.workspace.id, {
      worktreeKey: run.worktreeKey,
      aliases: {},
    });
    await until(
      "a gateway configure to be under way",
      async () => (stack.gatewayConfigureStarted() ? true : undefined),
      60_000,
      100,
    );
    const stoppedAt = Date.now();
    await cleanStop(run);
    await assertSettled(stack, run, stoppedAt, { terminal: ["stopped"] });
    stopTook = Date.now() - stoppedAt;
  } finally {
    await stack.slowGatewayConfigure(undefined);
  }
  await assertReleased(stack, run, { discard: false });
  const lifetime = await containerActions(gateway, run.startedAt);
  expect(lifetime.filter((action) => action === "create")).toHaveLength(1);
  expect(lifetime.filter((action) => action === "destroy")).toHaveLength(1);
  expect(
    stack.boat.events.filter((event) => event.kind === "delete" && event.sandboxId === sandbox),
  ).toHaveLength(1);
  process.stderr.write(
    `[boat-harness] stopped during a 5 s gateway configure: terminal ${(stopTook / 1000).toFixed(1)} s after the Stop\n`,
  );
};

/**
 * The link job is lost: written while no worker consumes it, and gone before one starts. The
 * sweep's page of live runs must still apply the link within one tick of the worker's start.
 */
export const linkJobDropped = async (stack: HarnessStack, project: Project) => {
  const run = await launch(stack, project, { link: false });
  await ready(stack, run);
  await stack.killWorker();
  try {
    await project.scope.workspaces.link(run.workspace.id, { worktreeKey: run.worktreeKey });
    const waiting = z
      .object({ jobs: z.number() })
      .parse(
        (
          await stack.query(
            `select count(*)::int as jobs from pgboss.job where name = 'boat-resource-links' and state = 'created' and data->>'runId' = '${sqlText(run.runId)}'`,
          )
        )[0],
      ).jobs;
    // The fault must land: the API did ask the worker, and that request is what is lost.
    expect(waiting).toBe(1);
    await stack.write(
      `delete from pgboss.job where name = 'boat-resource-links' and data->>'runId' = '${sqlText(run.runId)}'`,
    );
  } finally {
    await stack.startWorker();
  }
  const startedAt = Date.now();
  await within("db:5432 with the link job lost", startedAt, ONE_TICK_MS, () => reachesDb(run));
  await stopCleanly(stack, run);
};
