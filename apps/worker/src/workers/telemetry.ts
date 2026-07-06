/**
 * Telemetry worker-kind: a dedicated supervisor that drives the @sealant/telemetry ingester for
 * every RUNNING INTERACTIVE RUN (the run-keyed rework the old per-runtime-instance auto-ingest was
 * disabled pending — its `run_id` was an attempt id and violated the runs FK).
 *
 * One-shot harness runs are NOT polled here: the run-exec worker already ingests them inline
 * (captureRun), bounded to the harness process. Interactive runs (SSH sessions minted by the
 * gateway) have no inline owner, so this worker polls `runs` for `status=running, mode=interactive`,
 * resolves each run's workspace to its ready docker instance, and forks one ingester fiber per run on
 * its OWN control connection with THAT run as the connection's default — attribution then routes
 * execution-tagged events (this run's own session included) while untagged daemon noise falls back
 * to the same run. When the run leaves `running` (the gateway finalized it), the fiber is
 * interrupted, closing the connection and the epoch.
 *
 * The layer stack is assembled here at the boundary (DB connection config lives ONLY here). A failed
 * ingest (e.g. the control socket isn't up yet) is logged and the run is released so the next poll
 * retries — self-healing without an explicit readiness probe.
 */
import {
  RunRepo,
  RunRepoLive,
  WorkspaceRepo,
  WorkspaceRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  makeSealantDBLayer,
} from "@sealant/db";
import {
  ExecutionRunResolverLive,
  InlineByteaArtifactStoreLive,
  PostgresTelemetrySinkLive,
  TelemetryIngester,
  TelemetryIngesterLive,
} from "@sealant/telemetry";
import type { WorkerEnv } from "@sealant/validators/env";
import { SealantRuntimeDockerExecLive, sealantTargetForRuntimeInstance } from "@sealant/workspaces";
import { Cause, Context, Effect, Exit, Fiber, Layer, Scope } from "effect";

// 1s, not 5s: ingest attaches AFTER the gateway opens the session (live-tail protocol, no replay
// yet — see the delivery-integrity roadmap item), so poll lag is head-loss for short sessions.
const POLL_INTERVAL_MS = 1000;

/**
 * Starts the telemetry worker loop and returns a graceful shutdown handle. Mirrors
 * `startWorkspaceWorker`'s shape so `startWorkers` can compose it.
 */
export const startTelemetryWorker = async (env: WorkerEnv) => {
  const dbLayer = makeSealantDBLayer(env.DATABASE_URL);
  const artifactLayer = InlineByteaArtifactStoreLive.pipe(Layer.provide(dbLayer));
  const sinkLayer = PostgresTelemetrySinkLive.pipe(
    Layer.provide(Layer.mergeAll(dbLayer, artifactLayer)),
  );
  const resolverLayer = ExecutionRunResolverLive.pipe(Layer.provide(dbLayer));
  const ingesterLayer = TelemetryIngesterLive.pipe(
    Layer.provide(Layer.mergeAll(SealantRuntimeDockerExecLive, sinkLayer, resolverLayer)),
  );
  const repoLayer = Layer.mergeAll(
    RunRepoLive,
    WorkspaceRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
  ).pipe(Layer.provide(dbLayer));
  const appLayer = Layer.mergeAll(ingesterLayer, repoLayer);

  // Build the layer stack into a process-lifetime scope (the DB pool + connections live until stop()).
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(appLayer, scope));
  const ingester = Context.get(context, TelemetryIngester);
  const runs = Context.get(context, RunRepo);
  const workspaces = Context.get(context, WorkspaceRepo);
  const instances = Context.get(context, WorkspaceRuntimeInstanceRepo);

  const started = new Map<string, Fiber.Fiber<void, unknown>>();

  const resolveTarget = (workspaceId: string) =>
    Effect.gen(function* () {
      const workspace = yield* workspaces.getWorkspaceById(workspaceId);
      if (workspace === undefined || workspace.latestRunId === null) {
        return undefined;
      }
      const instance = yield* instances.getRuntimeInstanceByRunId(workspace.latestRunId);
      if (instance === undefined || instance.adapter !== "docker" || instance.status !== "ready") {
        return undefined;
      }
      return sealantTargetForRuntimeInstance(instance);
    });

  const poll = async () => {
    const running = await Effect.runPromise(runs.listRuns({ statuses: ["running"] }));
    const interactive = running.filter((run) => run.mode === "interactive");
    const activeIds = new Set(interactive.map((run) => run.id));

    // Reap: a run that left `running` (finalized by the gateway) releases its connection + epoch.
    for (const [runId, fiber] of started) {
      if (!activeIds.has(runId)) {
        started.delete(runId);
        Effect.runFork(Fiber.interrupt(fiber));
      }
    }

    for (const run of interactive) {
      if (started.has(run.id)) {
        continue;
      }
      const target = await Effect.runPromise(resolveTarget(run.workspaceId));
      if (target === undefined) {
        continue;
      }
      const fiber = Effect.runFork(
        Effect.scoped(ingester.run(run.id, target)).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              // Release the run so the next poll retries (e.g. socket not yet ready).
              started.delete(run.id);
              if (!Cause.hasInterruptsOnly(cause)) {
                console.error("Telemetry ingest ended", {
                  runId: run.id,
                  cause: Cause.pretty(cause),
                });
              }
            }),
          ),
        ),
      );
      started.set(run.id, fiber);
    }
  };

  await poll();
  const interval = setInterval(() => {
    void poll().catch((error) => {
      console.error("Telemetry poll failed", { error });
    });
  }, POLL_INTERVAL_MS);

  return {
    stop: async () => {
      clearInterval(interval);
      for (const [, fiber] of started) {
        Effect.runFork(Fiber.interrupt(fiber));
      }
      started.clear();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
};
