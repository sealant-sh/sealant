/**
 * Telemetry worker-kind: a dedicated supervisor that drives the @sealant/telemetry ingester for
 * every running docker sandbox. It polls `sandbox_runtime_instances` for `running` docker rows,
 * derives a `SealantTarget` from each (the same pure seam process-sandbox-build-job.ts persists),
 * and forks one ingester fiber per run on its OWN second control connection — never disrupting the
 * gateway or execInSandbox.
 *
 * The layer stack is assembled here at the boundary (DB connection config lives ONLY here). A failed
 * ingest (e.g. the control socket isn't up yet) is logged and the run is released so the next poll
 * retries — self-healing without an explicit readiness probe.
 */
import {
  SandboxRuntimeInstanceRepo,
  SandboxRuntimeInstanceRepoLive,
  makeSealantDBLayer,
} from "@sealant/db";
import { SealantRuntimeDockerExecLive, sealantTargetForRuntimeInstance } from "@sealant/sandboxes";
import {
  InlineByteaArtifactStoreLive,
  PostgresTelemetrySinkLive,
  TelemetryIngester,
  TelemetryIngesterLive,
} from "@sealant/telemetry";
import type { WorkerEnv } from "@sealant/validators/env";
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect";

const POLL_INTERVAL_MS = 5000;

/**
 * Starts the telemetry worker loop and returns a graceful shutdown handle. Mirrors
 * `startSandboxWorker`'s shape so `startWorkers` can compose it.
 */
export const startTelemetryWorker = async (env: WorkerEnv) => {
  const dbLayer = makeSealantDBLayer(env.DATABASE_URL);
  const artifactLayer = InlineByteaArtifactStoreLive.pipe(Layer.provide(dbLayer));
  const sinkLayer = PostgresTelemetrySinkLive.pipe(
    Layer.provide(Layer.mergeAll(dbLayer, artifactLayer)),
  );
  const ingesterLayer = TelemetryIngesterLive.pipe(
    Layer.provide(Layer.mergeAll(SealantRuntimeDockerExecLive, sinkLayer)),
  );
  const repoLayer = SandboxRuntimeInstanceRepoLive.pipe(Layer.provide(dbLayer));
  const appLayer = Layer.mergeAll(ingesterLayer, repoLayer);

  // Build the layer stack into a process-lifetime scope (the DB pool + connections live until stop()).
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(appLayer, scope));
  const ingester = Context.get(context, TelemetryIngester);
  const repo = Context.get(context, SandboxRuntimeInstanceRepo);

  const started = new Set<string>();

  const poll = async () => {
    const instances = await Effect.runPromise(repo.listRunningDockerInstances());
    for (const instance of instances) {
      if (started.has(instance.runId)) {
        continue;
      }
      const target = sealantTargetForRuntimeInstance(instance);
      if (target === undefined) {
        continue;
      }
      started.add(instance.runId);
      Effect.runFork(
        Effect.scoped(ingester.run(instance.runId, target)).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              // Release the run so the next poll retries (e.g. socket not yet ready).
              started.delete(instance.runId);
              if (!Cause.hasInterruptsOnly(cause)) {
                console.error("Telemetry ingest ended", {
                  runId: instance.runId,
                  cause: Cause.pretty(cause),
                });
              }
            }),
          ),
        ),
      );
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
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
};
