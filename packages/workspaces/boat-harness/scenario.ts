/**
 * Scenario vocabulary for the local Boat harness: a project with a `db` resource, a launch driven
 * through `@sealant/sdk` exactly as Mend drives it, observation of Core's durable rows, and the
 * four checks every scenario ends with.
 */
import { randomBytes } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

import { codex, Sealant, type Workspace, type WorkspaceStatus } from "@sealant/sdk";
import { boatExecutionTargetSchema } from "@sealant/validators";
import { z } from "zod";

import { boatTunnelName } from "../src/resources/boat-tunnel.js";
import type { CaptureSession, HarnessStack } from "./stack.js";

export const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb";

export interface Project {
  readonly client: Sealant;
  readonly scope: ReturnType<Sealant["scopes"]["actAs"]>;
}

export const openProject = async (stack: HarnessStack): Promise<Project> => {
  const client = new Sealant({
    baseUrl: stack.apiUrl,
    apiKey: stack.serviceKey,
    ownerUserId: stack.ownerId,
  });
  const scopeId = (await client.scopes.ensure({ key: `mend:harness:project:${stack.runId}` })).id;
  const scope = client.scopes.actAs(scopeId);
  await startDatabase({ client, scope });
  return { client, scope };
};

export const startDatabase = (project: Project) =>
  project.scope.instances.up(
    "db",
    {
      alias: "db",
      worktreeKey: null,
      image: POSTGRES_IMAGE,
      command: null,
      env: { POSTGRES_HOST_AUTH_METHOD: "trust" },
      volumes: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
      limits: { cpuMillicores: 1000, memoryBytes: 512 * 1024 * 1024 },
      ready: { kind: "exec", argv: ["pg_isready"], user: "postgres" },
      idleStopAfterSeconds: 1800,
    },
    { cause: "person" },
  );

export interface Launch {
  readonly workspace: Workspace;
  readonly capture: CaptureSession;
  readonly runId: string;
  readonly worktreeKey: string;
  readonly startedAt: number;
}

/**
 * The owner's person (Mend ADR 0016): a uid in Mend's range whose passwd entry sealantd makes from
 * the capture owner map, so `workspace.exec(argv, { user })` runs as them and not as root.
 */
export const PERSON = {
  id: "harness-person",
  uid: 40001,
  home: "/home/harness-person",
} as const;
const MEND_GID = 40000;

export interface LaunchOptions {
  /** Resume an earlier session: the daemon restores its worktree's captures before anything runs. */
  readonly resume?: CaptureSession;
  /** The workspace's own Docker (`tooling.services.docker.enabled`): the image carries the engine. */
  readonly docker?: boolean;
  /** Give the owner's person a passwd entry in the workspace (the capture owner map). */
  readonly person?: boolean;
}

/** Creates a capture-sourced Boat workspace and links it to the project, as a Mend session does. */
export const launch = async (
  stack: HarnessStack,
  project: Project,
  options: LaunchOptions = {},
): Promise<Launch> => {
  const startedAt = Date.now();
  const capture =
    options.resume ?? (await stack.openCapture(`wt_${randomBytes(6).toString("hex")}`));
  if (options.person === true) await project.client.users.bindPerson(stack.ownerId, PERSON);
  const workspace = await project.client.workspaces.create({
    runtime: "boat",
    os: "ubuntu",
    harness: codex(),
    name: `harness-${stack.runId}-${randomBytes(3).toString("hex")}`,
    wait: false,
    ...(options.docker === true ? { services: { docker: true } } : {}),
    source: {
      kind: "capture",
      endpoint: capture.endpoint,
      token: capture.token,
      worktreeId: capture.worktreeId,
      transport: { plaintext: true },
      ...(options.person === true
        ? {
            ownerMap: {
              gid: MEND_GID,
              worktreeUid: PERSON.uid,
              people: [{ id: PERSON.id, uid: PERSON.uid }],
            },
          }
        : {}),
    },
  });
  const worktreeKey = `w-${randomBytes(3).toString("hex")}`;
  await project.scope.workspaces.link(workspace.id, { worktreeKey });
  const runId = await until(
    "the workspace's attempt",
    async () => {
      const [row] = await stack.query(
        `select latest_run_id as run from workspaces where id = '${sqlText(workspace.id)}'`,
      );
      const parsed = z.object({ run: z.string() }).safeParse(row);
      return parsed.success ? parsed.data.run : undefined;
    },
    30_000,
  );
  const run = { workspace, capture, runId, worktreeKey, startedAt };
  launched.push(run);
  return run;
};

/** Rows that say where Core thinks a launch is. Every field is nullable: absent rows read as null. */
export const runtimeSchema = z.object({
  status: z.string().nullable(),
  error_code: z.string().nullable(),
  error: z.string().nullable(),
  stop_reason: z.string().nullable(),
  removed: z.boolean().nullable(),
  allocation: z.string().nullable(),
  sandbox: z.string().nullable(),
  execution: z.string().nullable(),
  tunnel_released: z.boolean().nullable(),
  has_tunnel: z.boolean(),
  pin: z.string().nullable(),
  drain: z.string().nullable(),
  retained: z.boolean().nullable(),
});
export type RuntimeView = z.infer<typeof runtimeSchema>;

export const sqlText = (value: string) => value.replaceAll("'", "''");

export const runtimeView = async (stack: HarnessStack, runId: string): Promise<RuntimeView> => {
  const id = sqlText(runId);
  const [row] = await stack.query(`
    select r.status, r.error_code, left(r.error_message, 2000) as error, r.stop_reason,
           r.removed_at is not null as removed,
           a.record->>'phase' as allocation, a.sandbox_id as sandbox,
           e.record->>'phase' as execution,
           t.released_at is not null as tunnel_released, t.runtime_instance_id is not null as has_tunnel,
           c.state as pin,
           d.state as drain, d.retained_at is not null as retained
      from (select '${id}'::text as run_id) k
      left join workspace_runtime_instances r on r.run_id = k.run_id
      left join boat_allocations a on a.runtime_instance_id = k.run_id
      left join boat_executions e on e.runtime_instance_id = k.run_id
      left join boat_tunnels t on t.runtime_instance_id = k.run_id
      left join native_publication_consumers c on c.run_id = k.run_id
      left join workspace_capture_drains d on d.run_id = k.run_id`);
  return runtimeSchema.parse(row);
};

export const until = async <T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}` +
          (last === undefined ? "" : `; last error: ${String(last)}`),
      );
    await new Promise((done) => setTimeout(done, intervalMs));
  }
};

const LIVE_STATUSES: ReadonlySet<WorkspaceStatus> = new Set(["queued", "running", "ready"]);

/**
 * Waits for a launch to stop moving: ready, or Core has recorded a terminal runtime or attempt.
 * Returns which, with the runtime view at that moment.
 */
export const awaitOutcome = async (
  stack: HarnessStack,
  run: Launch,
  timeoutMs: number,
): Promise<{
  readonly status: WorkspaceStatus;
  readonly view: RuntimeView;
  readonly at: number;
}> =>
  until(
    "a ready or terminal launch",
    async () => {
      const status = await run.workspace.status();
      const view = await runtimeView(stack, run.runId);
      const terminal =
        view.status === "failed" ||
        view.status === "stopped" ||
        view.error_code !== null ||
        !LIVE_STATUSES.has(status);
      return status === "ready" || terminal ? { status, view, at: Date.now() } : undefined;
    },
    timeoutMs,
    2000,
  );

export interface SettleExpectation {
  /** The cause Core must record on the runtime row (error code or message). */
  readonly cause?: RegExp;
  /** The public statuses that count as terminal for this scenario. */
  readonly terminal?: readonly WorkspaceStatus[];
}

export interface Settled {
  readonly status: WorkspaceStatus;
  readonly view: RuntimeView;
}

/**
 * The checks a scenario's own step makes, which a known defect's marker may excuse:
 * 1. the runtime row carries the exact cause;
 * 2. Mend sees a terminal workspace within 60 s of `since`.
 * Leaks are never excusable: `assertReleased` checks them after every scenario, marker or not.
 */
export const assertSettled = async (
  stack: HarnessStack,
  run: Launch,
  since: number,
  expectation: SettleExpectation = {},
): Promise<Settled> => {
  const terminal = new Set(expectation.terminal ?? ["stopped", "failed"]);
  const remaining = () => Math.max(1000, since + 60_000 - Date.now());
  const evidence = async () =>
    `runtime ${JSON.stringify(await runtimeView(stack, run.runId))}; guest: ${await guestEvidence(stack, run.runId)}; proxy: ${proxyEvidence(stack, run.runId)}`;
  // The cause first: it names the earliest defect, before anything downstream of it.
  const view = await runtimeView(stack, run.runId);
  if (
    expectation.cause !== undefined &&
    !expectation.cause.test(`${view.error_code} ${view.error}`)
  )
    throw new Error(
      `runtime cause ${JSON.stringify(view.error_code)} ${JSON.stringify(view.error)} does not match ${expectation.cause}; ${await evidence()}`,
    );
  const status = await until(
    "Mend to see a terminal workspace (stopped or failed, never retained) within 60 s",
    async () => {
      const value = await run.workspace.status();
      return terminal.has(value) ? value : undefined;
    },
    remaining(),
    2000,
  ).catch(async (error: unknown) => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; public status ${await run.workspace.status()}; ${await evidence()}`,
    );
  });
  return { status, view };
};

/** Every launch a scenario made, so the release checks can follow it whatever the scenario did. */
const launched: Launch[] = [];

/** The launches made since the last call. */
export const takeLaunched = (): Launch[] => launched.splice(0);

const TERMINAL: ReadonlySet<WorkspaceStatus> = new Set(["stopped", "failed"]);

/**
 * Nothing is left behind, eventually: the workspace is terminal, and the UDP slot, publication pin,
 * VM and gateway are released. A launch Core keeps (`retained`) gets the owner's discard after a
 * minute, as Mend would give it, and must then release too. No marker excuses a failure here.
 */
export const assertReleased = async (
  stack: HarnessStack,
  run: Launch,
  options: { readonly discard?: boolean } = {},
): Promise<void> => {
  const started = Date.now();
  let discarded = false;
  let last = { status: "", problems: [""] };
  for (;;) {
    const status = await run.workspace.status();
    const problems = await leftovers(stack, run, await runtimeView(stack, run.runId));
    last = { status, problems };
    if (TERMINAL.has(status) && problems.length === 0) return;
    if (options.discard !== false && !discarded && Date.now() - started > 60_000) {
      discarded = true;
      await run.workspace.stop({ discardUnsaved: true }).catch(() => undefined);
    }
    if (Date.now() - started > 5 * 60_000)
      throw new Error(
        `left behind (no marker excuses this): public status ${last.status}${discarded ? " after an owner discard" : ""}; ${last.problems.join("; ") || "nothing else"}; runtime ${JSON.stringify(await runtimeView(stack, run.runId))}`,
      );
    await new Promise((done) => setTimeout(done, 3000));
  }
};

/** The guest's answers through the hosted proxy for a run's VMs, newest last. */
export const proxyEvidence = (stack: HarnessStack, runId: string): string => {
  const vms = new Set(
    [...stack.boat.sandboxes.values()]
      .filter((sandbox) => sandbox.labels["sealant-run"] === runId)
      .map((sandbox) => sandbox.id),
  );
  const answers = stack.boat.events
    .filter((event) => event.kind === "proxy" && vms.has(event.sandboxId ?? ""))
    .map((event) => event.detail ?? "");
  const notable = answers.filter((answer) => !answer.endsWith(" 200"));
  return notable.length === 0
    ? `${answers.length} answers, all 200`
    : [...new Set(notable)].slice(-6).join(" | ");
};

/** Core's name for a run's gateway container and networks, once the run has a bound target. */
const gatewayName = async (stack: HarnessStack, runId: string): Promise<string | undefined> => {
  const [row] = await stack.query(
    `select record->'target' as target from boat_allocations where runtime_instance_id = '${sqlText(runId)}'`,
  );
  const target = boatExecutionTargetSchema.safeParse(
    z.object({ target: z.unknown() }).safeParse(row).data?.target,
  );
  return target.success ? boatTunnelName(target.data) : undefined;
};

export const leftovers = async (
  stack: HarnessStack,
  run: Launch,
  view: RuntimeView,
): Promise<string[]> => {
  const problems: string[] = [];
  if (view.has_tunnel && view.tunnel_released !== true) problems.push("UDP slot still reserved");
  if (view.pin !== null && view.pin !== "released") problems.push(`publication pin ${view.pin}`);
  const vms = stack.boat
    .liveSandboxes()
    .filter((sandbox) => sandbox.labels["sealant-run"] === run.runId);
  if (vms.length > 0) problems.push(`live VM ${vms.map((vm) => `${vm.id}:${vm.state}`).join(",")}`);
  // Only this run's gateway: another launch Core rightly retains keeps its own.
  const gateway = await gatewayName(stack, run.runId);
  if (gateway !== undefined) {
    const owned = await stack.ownedObjects();
    const objects = [...owned.containers, ...owned.networks].filter((name) =>
      name.startsWith(gateway),
    );
    if (objects.length > 0) problems.push(`gateway objects ${objects.join(",")}`);
  }
  return problems;
};

/** Guest log lines that name a cause Core's runtime row may have erased. */
const GUEST_SIGNALS =
  /plan\.get failed|boot preparation failed|Refusal|refused|not closed|exited|failed|bind-[a-z-]+|recover-[a-z-]+|docker policy|Traceback|ERROR|error/;

/** Distinct guest journal lines for a run's live VM that look like a cause. */
export const guestEvidence = async (stack: HarnessStack, runId: string): Promise<string> => {
  const vm = stack.boat.liveSandboxes().find((sandbox) => sandbox.labels["sealant-run"] === runId);
  if (vm === undefined) return "no live VM";
  // The agent's unit, and sealantd's own output inside it (the agent logs what it starts).
  const journal = await stack.boat
    .guestRoot(vm.id, "journalctl --no-pager -o cat -u 'sealant*'")
    .catch((error: unknown) => String(error));
  const lines = [
    ...new Set(
      journal
        .split("\n")
        // sealantd colours its log lines; drop the escapes and the timestamp so lines dedupe.
        .map((line) => stripVTControlCharacters(line).replace(/^\S+Z\s+/, ""))
        .filter((line) => GUEST_SIGNALS.test(line))
        .map((line) => line.slice(0, 300)),
    ),
  ];
  return lines.length === 0 ? "no guest error lines" : lines.slice(-6).join(" | ");
};
