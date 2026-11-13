/**
 * Two execs that overlap in one workspace each hand their caller their own output (SLNT-956).
 *
 * The real path end to end, on Postgres: the SDK's `workspace.exec()` against the API booted in
 * this process (the exec route, the runs routes, the run repository and the telemetry query), the
 * run queued to a publisher that runs the worker's exec recorder (`produceExecRun`, with its
 * changes reading) into the real telemetry sink. Only the workspace's daemon is a fake, and it
 * behaves as sealantd does where it matters: every connection receives every event from the moment
 * it connects, a process's events carry the execution id it was started with and none otherwise.
 *
 * The overlap is forced, not hoped for: exec B connects, then waits in its exec until exec A's
 * command has exited and A's changes reading has run; only then does B's command start. That is
 * the order seen on the test server on 2026-11-13 (run_3cd10830): another exec's changes reading
 * between B's connect and B's command. Gated on SEALANT_TEST_DATABASE_URL (a disposable, migrated
 * database).
 */
import { randomUUID } from "node:crypto";

import { ControlPlaneAPI } from "@sealant/api-contracts";
import {
  createSealantDB,
  RunRepo,
  RunRepoLive,
  SealantDB,
  user,
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceCaptureDrainRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  workspaces,
  type DB,
} from "@sealant/db";
import { fakeService } from "@sealant/db/testing/fake-service";
import { runtimeInstanceRow, workspaceRow } from "@sealant/db/testing/rows";
import { Sealant } from "@sealant/sdk";
import {
  InlineByteaArtifactStoreLive,
  PostgresTelemetrySinkLive,
  produceExecRun,
  TelemetryQueryLive,
} from "@sealant/telemetry";
import {
  type DaemonEventInit,
  daemonEvent,
  execAccepted,
  healthReport,
} from "@sealant/telemetry/testing";
import {
  SealantRuntime,
  type SealantExecOptions,
  type SealantRuntimeService,
  type SealantSession,
  type SealantTarget,
  workingTreeChangesScript,
} from "@sealant/workspaces";
import { Deferred, Effect, Layer, ManagedRuntime, PubSub, Stream } from "effect";
import { HttpApiBuilder, type HttpApiGroup } from "effect/http-api";
import { beforeAll, describe, expect, it } from "vitest";

import { RunExecPublisherService } from "../../services/control-plane-capabilities.js";
import { controlPlaneRoutes, gateControlPlane } from "../control-plane.fixture.js";
import { RunsHandlersLive } from "../runs/runs.http-api.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
const SERVICE_KEY = `slt_exec_overlap_${randomUUID()}`;
process.env["SEALANT_SERVICE_KEYS"] = SERVICE_KEY;

const TARGET: SealantTarget = { kind: "docker-exec", containerId: "c1", socketPath: "/s" };
/** What the changes reading prints: a diff, the separator, a name-status list. */
const CHANGES_OUTPUT = "diff --git a/x b/x\n\0sealant-name-status\0M\tx\n";
const ITERATIONS = 5;
/** sealantd's `StreamKind` and `ExitReason` values. */
const STDOUT = 2;
const STDERR = 3;
const EXITED = 1;

/** The two callers' commands; each prints its own name to stdout and to stderr. */
const command = (name: string) => [
  "sh",
  "-c",
  `printf 'out of ${name}\\n'; printf 'err of ${name}\\n' >&2`,
];
const nameOf = (exec: SealantExecOptions) => /out of (\w+)/.exec(exec.args?.[1] ?? "")?.[1];

/**
 * A daemon whose every connection sees every event from its connect on. `hooks.beforeStart` runs in
 * a command's exec before the daemon accepts it; `hooks.afterExit` after a process's exit is out.
 */
const broadcastingDaemon = (hooks: {
  readonly beforeStart: (exec: SealantExecOptions) => Effect.Effect<void>;
  readonly afterExit: (exec: SealantExecOptions) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const runtimeId = `rt_overlap_${randomUUID()}`;
    const bus = yield* PubSub.unbounded<ReturnType<typeof daemonEvent>>();
    let sequence = 0n;
    let processes = 0;
    const publish = (
      processId: string,
      executionId: string | undefined,
      payload: NonNullable<DaemonEventInit["payload"]>,
    ) => {
      sequence += 1n;
      return PubSub.publish(
        bus,
        daemonEvent({
          schemaVersion: 1,
          eventId: `evt_${runtimeId}_${sequence.toString()}`,
          runtimeId,
          sequence,
          observedAt: sequence * 1000n,
          monotonicTimestamp: sequence * 10n,
          captureMethod: 1,
          confidence: 1,
          processId,
          ...(executionId === undefined ? {} : { executionId }),
          payload,
        }),
      );
    };
    const output = (exec: SealantExecOptions) => {
      if (exec.args?.[1] === workingTreeChangesScript())
        return { stdout: CHANGES_OUTPUT, stderr: "" };
      const name = nameOf(exec);
      if (name === undefined) throw new Error(`the daemon was asked to run ${exec.executable}`);
      return { stdout: `out of ${name}\n`, stderr: `err of ${name}\n` };
    };

    const exec = (options: SealantExecOptions) =>
      Effect.gen(function* () {
        yield* hooks.beforeStart(options);
        processes += 1;
        const processId = `proc_${runtimeId}_${String(processes)}`;
        const { stdout, stderr } = output(options);
        const id = options.executionId;
        yield* publish(processId, id, {
          case: "processStarted",
          value: {
            pid: 100 + processes,
            pgid: 100 + processes,
            executable: options.executable,
            args: [...(options.args ?? [])],
            cwd: options.cwd ?? "/",
            startedAt: sequence,
          },
        });
        for (const [stream, text] of [
          [STDOUT, stdout],
          [STDERR, stderr],
        ] as const) {
          if (text.length === 0) continue;
          const content = new TextEncoder().encode(text);
          yield* publish(processId, id, {
            case: "ioChunk",
            value: { stream, byteCount: BigInt(content.length), streamOffset: 0n, content },
          });
        }
        yield* publish(processId, id, {
          case: "processExited",
          value: { exitCode: 0, reason: EXITED, durationMicros: 1n },
        });
        yield* hooks.afterExit(options);
        return execAccepted(processId, 100 + processes);
      });

    const runtime = fakeService<SealantRuntimeService>({
      connect: () =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(bus);
          return fakeService<SealantSession>({
            health: Effect.succeed(healthReport(runtimeId)),
            exec,
            events: Stream.fromSubscription(subscription),
          });
        }),
    });
    return runtime;
  });

/**
 * One overlap: B waits in its exec until A's command and A's changes reading have both exited, so
 * A's reading falls between B's connect and B's command. A waits until B is waiting.
 */
const overlapHooks = Effect.gen(function* () {
  const bWaiting = yield* Deferred.make<void>();
  const aReadingDone = yield* Deferred.make<void>();
  let readings = 0;
  return {
    beforeStart: (exec: SealantExecOptions) => {
      const name = nameOf(exec);
      if (name === "A") return Deferred.await(bWaiting);
      if (name === "B")
        return Deferred.succeed(bWaiting, undefined).pipe(
          Effect.andThen(Deferred.await(aReadingDone)),
        );
      return Effect.void;
    },
    afterExit: (exec: SealantExecOptions) =>
      Effect.suspend(() => {
        if (exec.args?.[1] !== workingTreeChangesScript()) return Effect.void;
        readings += 1;
        // The first reading is A's: B's command cannot start before it.
        return readings === 1 ? Deferred.succeed(aReadingDone, undefined) : Effect.void;
      }),
  };
});

describe.skipIf(DATABASE_URL === undefined)("two overlapping execs in one workspace", () => {
  let db: DB;
  const owner = `user_exec_overlap_${randomUUID()}`;

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    await Effect.runPromise(
      db.insert(user).values({ id: owner, name: "overlap", email: `${owner}@example.test` }),
    );
  });

  const serve = async (daemon: SealantRuntimeService) => {
    const launch = `run_launch_${randomUUID()}`;
    const workspace = workspaceRow({
      id: `ws_overlap_${randomUUID()}`,
      ownerUserId: owner,
      status: "ready",
    });
    await Effect.runPromise(db.insert(workspaces).values(workspace));
    const launched = { ...workspace, latestRunId: launch };
    const instance = runtimeInstanceRow({
      runId: launch,
      status: "ready",
      adapter: "docker",
      endpoint: "unix:///run/sealant/overlap.sock",
      resourceId: "container_1",
      reference: "container_1",
    });

    const dbLayer = Layer.succeed(SealantDB, db);
    const storeLayer = Layer.mergeAll(
      dbLayer,
      InlineByteaArtifactStoreLive.pipe(Layer.provide(dbLayer)),
    );
    const sinkLayer = PostgresTelemetrySinkLive.pipe(Layer.provide(storeLayer));
    // The worker's half: a queued exec run is claimed and recorded as the worker records it.
    const worker = ManagedRuntime.make(
      Layer.mergeAll(
        RunRepoLive.pipe(Layer.provide(dbLayer)),
        sinkLayer,
        Layer.succeed(SealantRuntime, daemon),
      ),
    );
    const jobs: Array<Promise<void>> = [];
    const publisher = Layer.succeed(RunExecPublisherService, {
      publishRequested: (input) => {
        jobs.push(
          worker.runPromise(
            Effect.gen(function* () {
              const claim = yield* (yield* RunRepo).claimRunForExec({ id: input.runId });
              if (claim.outcome !== "claimed") return yield* Effect.die(claim.outcome);
              yield* produceExecRun(input.runId, TARGET, input.commands ?? []);
            }),
          ),
        );
        return Promise.resolve();
      },
    });

    const { execWorkspace, getWorkspace } = await import("./workspaces.module.js");
    const UNDER_TEST = new Set(["getWorkspace", "execWorkspace"]);
    // The two endpoints under test are the real ones; every other endpoint of the group dies.
    const served = HttpApiBuilder.group(ControlPlaneAPI, "workspaces", (group) => {
      const real = group
        .handle("getWorkspace", ({ params, query }) =>
          getWorkspace(params.workspaceId, query.ownerUserId),
        )
        .handle("execWorkspace", ({ params, payload }) =>
          execWorkspace({ workspaceId: params.workspaceId, payload }),
        );
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stubs the endpoints not under test by name, as the control-plane fixture stubs whole groups.
      return Object.keys(ControlPlaneAPI.groups.workspaces.endpoints)
        .filter((endpoint) => !UNDER_TEST.has(endpoint))
        .reduce(
          (acc, endpoint) =>
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above.
            (acc as { handle: (n: string, h: unknown) => unknown }).handle(endpoint, () =>
              Effect.die(`${endpoint} is not under test`),
            ),
          real as unknown,
        ) as never;
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stubbed group's requirements are what `provides` gives; a missing one fails the test as a 500.
    const handlers = served as unknown as Layer.Layer<
      HttpApiGroup.Service<"sealantControlPlaneApi", "workspaces" | "runs">
    >;
    const api = await gateControlPlane(
      controlPlaneRoutes({
        handlers: Layer.mergeAll(handlers, RunsHandlersLive),
        provides: Layer.mergeAll(
          dbLayer,
          RunRepoLive.pipe(Layer.provide(dbLayer)),
          TelemetryQueryLive.pipe(Layer.provide(storeLayer)),
          publisher,
          Layer.succeed(SealantRuntime, daemon),
          Layer.mock(WorkspaceRepo, { getWorkspaceById: () => Effect.succeed(launched) }),
          Layer.mock(WorkspaceAttemptRepo, {
            getAttemptById: () => Effect.succeed(undefined),
            getAttemptSnapshotByRunId: () => Effect.succeed(undefined),
          }),
          Layer.mock(WorkspaceBuildJobRepo, {
            getLatestJobByRunId: () => Effect.succeed(undefined),
          }),
          Layer.mock(WorkspaceCaptureDrainRepo, { getByRunId: () => Effect.succeed(undefined) }),
          Layer.mock(WorkspaceRuntimeInstanceRepo, {
            getRuntimeInstanceByRunId: () => Effect.succeed(instance),
          }),
        ),
        groups: ["workspaces", "runs"],
      }),
      SERVICE_KEY,
    );
    const sealant = new Sealant({ baseUrl: api.baseUrl, apiKey: SERVICE_KEY, ownerUserId: owner });
    return {
      workspace: await sealant.workspaces.get(workspace.id),
      close: async () => {
        await Promise.allSettled(jobs);
        await sealant.close();
        await api.close();
        await worker.dispose();
      },
    };
  };

  it(
    "each caller gets exactly its own stdout and stderr, though the other's changes reading ran between its connect and its command",
    { timeout: 60_000 },
    async () => {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const hooks = await Effect.runPromise(overlapHooks);
        const daemon = await Effect.runPromise(broadcastingDaemon(hooks));
        const served = await serve(daemon);
        try {
          const [a, b] = await Promise.all([
            served.workspace.exec(command("A")),
            served.workspace.exec(command("B")),
          ]);
          expect({ iteration, stdout: a.stdout, stderr: a.stderr }).toEqual({
            iteration,
            stdout: "out of A\n",
            stderr: "err of A\n",
          });
          expect({ iteration, stdout: b.stdout, stderr: b.stderr }).toEqual({
            iteration,
            stdout: "out of B\n",
            stderr: "err of B\n",
          });
          expect([a.exitCode, b.exitCode]).toEqual([0, 0]);
        } finally {
          await served.close();
        }
      }
    },
  );
});
