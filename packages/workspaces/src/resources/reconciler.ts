/**
 * Keeps Docker at what the rows say for resource instances: the Docker adapter's executor hooks
 * (attach on launch, detach on removal) and a tick (every 30 s in the worker) that restarts an
 * instance that ended on its own, stops one asked to stop, touches the last reach of every
 * instance a live executor reaches, stops one nobody reached for its idle time, and converges
 * every reach network. Each step reads what exists, so a tick after a crash finds what is left.
 */
import type { ResourceInstanceRepoService, ResourceInstanceRecord } from "@sealant/db";
import { Effect } from "effect";

import type { DockerExecutorNetworkHooks } from "../runtime/docker-runtime-adapter.js";
import type { ResourceRuntime } from "./docker-resource-runtime.js";
import { desiredAttachments, idleVerdict, reaches } from "./reach.js";

/** A start that failed is not tried again until this long after it was recorded. */
const FAILED_START_BACKOFF_MS = 5 * 60_000;

export interface ResourceTickReport {
  readonly restarted: ReadonlyArray<string>;
  readonly stopped: ReadonlyArray<string>;
  readonly idleStopped: ReadonlyArray<string>;
  readonly reached: number;
  /** What went wrong, by step and instance key or executor; never an argv. */
  readonly problems: ReadonlyArray<string>;
}

export interface ResourceReconciler {
  readonly hooks: DockerExecutorNetworkHooks;
  readonly tick: (now?: Date) => Promise<ResourceTickReport>;
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const message = (error: unknown) =>
  error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);

export const makeResourceReconciler = (input: {
  readonly repo: ResourceInstanceRepoService;
  readonly runtime: ResourceRuntime;
}): ResourceReconciler => {
  const { repo, runtime } = input;

  /** Start one instance and record what the runtime saw. */
  const start = async (instance: ResourceInstanceRecord) => {
    const executors = await run(repo.linkedExecutors(instance.resourceDomainId));
    const result = await runtime.up(instance, desiredAttachments(executors, [instance]));
    await run(
      repo.recordObserved(instance.id, result.state, {
        ...(result.startedAt === undefined ? {} : { startedAt: result.startedAt }),
        ...(result.volumes === undefined ? {} : { volumes: result.volumes }),
      }),
    );
    return result.state;
  };

  const hooks: DockerExecutorNetworkHooks = {
    launched: async ({ runId, executor }) => {
      if (runId === undefined) return;
      const link = await run(repo.linkOfRun(runId));
      if (link === undefined) return;
      const instances = await run(repo.list(link.resourceDomainId, { archived: false }));
      await runtime.attachExecutor(
        executor,
        desiredAttachments([{ ...link, executor }], instances),
      );
    },
    removed: (executor) => runtime.detachExecutor(executor),
  };

  const tick = async (now = new Date()): Promise<ResourceTickReport> => {
    const problems: Array<string> = [];
    const restarted: Array<string> = [];
    const stopped: Array<string> = [];
    const idleStopped: Array<string> = [];
    const attempt = async (what: string, step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (error) {
        problems.push(`${what}: ${message(error)}`);
      }
    };

    const [instances, executors, observed] = await Promise.all([
      run(repo.listLive()),
      run(repo.linkedExecutors()),
      runtime.observe(),
    ]);
    const running: Array<ResourceInstanceRecord> = [];
    for (const instance of instances) {
      const container = observed.get(instance.id);
      if (instance.desired === "running") {
        if (container?.running === true) {
          running.push(instance);
          continue;
        }
        const backingOff =
          instance.observed.kind === "failed" &&
          now.getTime() - instance.observedAt.getTime() < FAILED_START_BACKOFF_MS;
        if (backingOff) continue;
        // Ended on its own (or never started): start it again, with the guard put back.
        await attempt(`restart ${instance.key}`, async () => {
          if (container !== undefined) {
            await run(
              repo.recordObserved(instance.id, {
                kind: "exited",
                at: now.toISOString(),
                exitCode: container.exitCode,
              }),
            );
          }
          const state = await start(instance);
          restarted.push(instance.key);
          if (state.kind === "running") running.push({ ...instance, startedAt: now });
        });
      } else if (container?.running === true) {
        await attempt(`stop ${instance.key}`, async () => {
          await runtime.stop(instance);
          stopped.push(instance.key);
        });
      }
    }

    const reached = running.filter((instance) =>
      executors.some((executor) => reaches(executor, instance)),
    );
    await attempt("touch reached", () =>
      run(
        repo.touchReached(
          reached.map(({ id }) => id),
          now,
        ),
      ),
    );

    const stillRunning: Array<ResourceInstanceRecord> = [];
    for (const instance of running) {
      if (reached.includes(instance) || idleVerdict(instance, false, now).kind !== "stop") {
        stillRunning.push(instance);
        continue;
      }
      await attempt(`idle stop ${instance.key}`, async () => {
        const reason = { kind: "idle" } as const;
        await run(repo.setDesired(instance.id, { kind: "stop", reason }));
        await runtime.stop(instance);
        await run(
          repo.recordObserved(instance.id, { kind: "stopped", at: now.toISOString(), reason }),
        );
        idleStopped.push(instance.key);
      });
    }

    await attempt("converge reach", async () => {
      const known = await run(repo.networks("reach"));
      await runtime.converge({
        desired: desiredAttachments(executors, stillRunning),
        liveExecutors: [...new Set(executors.map(({ executor }) => executor))],
        knownExecutors: known.map(({ owner }) => owner),
      });
    });
    return { restarted, stopped, idleStopped, reached: reached.length, problems };
  };

  return { hooks, tick };
};
