/**
 * The exec recorder sends each command once. Connecting is retried while a daemon comes up; once
 * an exec is sent, a lost answer leaves whether the process started unknown, so it is never sent
 * again, and the run fails saying so. Driven against a fake daemon session, sink and run repository.
 */
import { RunRepo, type RunRepoService } from "@sealant/db";
import {
  SealantControlError,
  SealantRuntime,
  type SealantExecOptions,
  type SealantSession,
  type SealantTarget,
  TransportError,
} from "@sealant/workspaces";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { produceExecRun } from "./exec-run.js";
import { TelemetrySink, type TelemetrySinkService } from "./sink.js";

const RUN = "run_send_once";
const TARGET: SealantTarget = { kind: "docker-exec", containerId: "c1", socketPath: "/s" };

const lost = new TransportError({ operation: "exec", message: "bridge closed", cause: undefined });

const world = (options: {
  readonly healthFailures?: number;
  readonly execFails: TransportError | SealantControlError;
}) => {
  const sent: SealantExecOptions[] = [];
  const outcomes: Array<Record<string, unknown>> = [];
  let healthReads = 0;
  const session = {
    health: Effect.suspend(() => {
      healthReads += 1;
      return healthReads <= (options.healthFailures ?? 0)
        ? Effect.fail(new TransportError({ operation: "health", message: "not up", cause: 0 }))
        : Effect.succeed({ runtimeId: "rt_1" });
    }),
    capabilities: Effect.succeed({ supports: [] }),
    exec: (exec: SealantExecOptions) =>
      Effect.suspend(() => {
        sent.push(exec);
        return Effect.fail(options.execFails);
      }),
    events: Stream.empty,
  } as unknown as SealantSession;
  const layer = Layer.mergeAll(
    Layer.succeed(SealantRuntime, {
      connect: () => Effect.succeed(session),
      openForwardConnection: () => Effect.die("forwards are unused here"),
    }),
    Layer.succeed(TelemetrySink, {} as TelemetrySinkService),
    Layer.succeed(RunRepo, {
      markRunCompleted: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          outcomes.push({ status: "completed", ...input });
          return null;
        }),
      markRunFailed: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          outcomes.push({ status: "failed", ...input });
          return null;
        }),
    } as unknown as RunRepoService),
  );
  const run = () =>
    Effect.runPromise(
      produceExecRun(RUN, TARGET, [
        { executable: "make", args: ["migrate"] },
        { executable: "make", args: ["check"] },
      ]).pipe(Effect.provide(layer)),
    );
  return { run, sent, outcomes, healthReads: () => healthReads };
};

describe("an exec whose answer is lost after it was sent", () => {
  it("is sent once, the commands after it are not sent, and the run fails saying why", async () => {
    const w = world({ healthFailures: 2, execFails: lost });
    await w.run();
    // Connecting was retried until the daemon answered; the exec was not.
    expect(w.healthReads()).toBe(3);
    expect(w.sent.map((exec) => exec.args)).toEqual([["migrate"]]);
    expect(w.outcomes).toEqual([
      {
        status: "failed",
        id: RUN,
        errorMessage: `Run ${RUN}: command 1/2 was sent to the workspace and its answer was lost, so whether it started is unknown; it may still be running. It was not sent again.`,
      },
    ]);
  });

  it("is sent once when the daemon refuses it, and the run says nothing started", async () => {
    const refused = new SealantControlError({
      operation: "exec",
      code: 3,
      message: "no such file",
    });
    const w = world({ execFails: refused });
    await w.run();
    expect(w.sent).toHaveLength(1);
    expect(w.outcomes).toEqual([
      {
        status: "failed",
        id: RUN,
        errorMessage: `Run ${RUN}: the workspace refused to start command 1/2 (daemon error 3); nothing was started.`,
      },
    ]);
  });
});
