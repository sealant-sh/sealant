/**
 * End-to-end proof that the P5 `SealantRuntime` Effect service works on the REAL production path:
 * the docker-exec/socat `DockerExecTransport` bridging into a booted baked image. This is the same
 * assertion surface as P3's `proof.e2e.ts` (healthy control channel + `/bin/echo hi` telemetry
 * triad), but driven entirely THROUGH the Effect service — `SealantRuntime.connect` ->
 * `SealantSession.exec` -> `SealantSession.events` Stream — rather than the raw `SealantClient`.
 *
 * Requires Docker and the prebuilt image. Excluded from the default unit run (`*.test.ts`); runs via
 * `pnpm --filter @sealant/sandboxes test:e2e`. Skips gracefully when the image is absent.
 */
import { StreamKind, RuntimeState } from "@sealant/runtime-client";
import type { EventEnvelope } from "@sealant/runtime-protocol";
import { Chunk, Effect, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootSealantdContainer, isImagePresent, type BootedSealantd } from "./boot.js";
import { SealantRuntime, SealantRuntimeDockerExecLive, type SealantTarget } from "./runtime.js";

const imageAvailable = await isImagePresent();

describe.skipIf(!imageAvailable)("SealantRuntime service over DockerExecTransport (real image)", () => {
  let booted: BootedSealantd | undefined;
  let target: SealantTarget;

  beforeAll(async () => {
    booted = await bootSealantdContainer();
    target = {
      kind: "docker-exec",
      containerId: booted.containerId,
      socketPath: booted.socketPath,
    };
  }, 90_000);

  afterAll(async () => {
    await booted?.teardown();
  });

  it("connect -> health reports a HEALTHY control channel through the service", async () => {
    const health = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SealantRuntime;
          const session = yield* runtime.connect(target);
          return yield* session.health;
        }),
      ).pipe(Effect.provide(SealantRuntimeDockerExecLive)),
    );

    expect(health.state).toBe(RuntimeState.HEALTHY);
    expect(health.runtimeId).toMatch(/^rt_/);
  }, 30_000);

  it("connect -> exec -> events Stream yields processStarted + STDOUT 'hi\\n' + processExited(0)", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SealantRuntime;
          const session = yield* runtime.connect(target);

          const accepted = yield* session.exec({
            executable: "/bin/echo",
            args: ["hi"],
            stdin: false,
          });

          const events = yield* session.events.pipe(
            Stream.filter(
              (event: EventEnvelope) =>
                event.processId === undefined || event.processId === accepted.processId,
            ),
            Stream.takeUntil((event: EventEnvelope) => event.payload.case === "processExited"),
            Stream.runCollect,
          );

          return { accepted, events: Chunk.toReadonlyArray(events) };
        }),
      ).pipe(Effect.provide(SealantRuntimeDockerExecLive)),
    );

    expect(result.accepted.processId).toMatch(/^proc_/);

    let sawProcessStarted = false;
    let stdout = "";
    let exitCode: number | undefined;
    for (const event of result.events) {
      const payload = event.payload;
      if (payload.case === "processStarted") {
        sawProcessStarted = true;
      } else if (
        payload.case === "ioChunk" &&
        payload.value.stream === StreamKind.STDOUT &&
        payload.value.content !== undefined
      ) {
        stdout += Buffer.from(payload.value.content).toString("utf8");
      } else if (payload.case === "processExited") {
        exitCode = payload.value.exitCode;
      }
    }

    expect(sawProcessStarted).toBe(true);
    expect(stdout).toBe("hi\n");
    expect(exitCode).toBe(0);
  }, 30_000);
});
