/**
 * Unit test for the P5 `SealantRuntime` Effect service. Docker-free and fast: instead of the
 * docker-exec bridge, it provides a `LocalSocketTransport` test layer that spawns the REAL local
 * sealantd binary on a temp Unix socket and yields a `net.Socket` (a `Duplex`) connected to it. This
 * still exercises the full service stack — `SealantTransport` -> `SealantRuntime.connect` ->
 * `SealantClient.fromStream` over genuine length-prefixed protobuf frames — proving the Effect
 * wrapper drives the same request/response/event machinery as the production docker path, without
 * mocking the wire protocol.
 *
 * The debug sealantd binary built for the dev host runs natively here (macOS/arm64), and we connect
 * as the same uid that launched it, so the daemon's `SO_PEERCRED` check admits us. If the binary is
 * absent the suite is skipped rather than failed (CI without a prebuilt daemon).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import { StreamKind, RuntimeState } from "@sealant/runtime-client";
import type { EventEnvelope } from "@sealant/runtime-protocol";
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  SealantControlError,
  SealantRuntime,
  SealantRuntimeLive,
  SealantTransport,
  TransportError,
  type SealantTransportService,
} from "./runtime.js";

/** Absolute path of the dev-host sealantd debug binary (sibling `sealantd` checkout). */
const SEALANTD_BIN = fileURLToPath(
  new URL("../../../../../sealantd/target/debug/sealantd", import.meta.url),
);

const hasBinary = existsSync(SEALANTD_BIN);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Tracks spawned daemons + temp dirs so the suite can tear them down between cases. */
const spawned: Array<{ child: ChildProcess; dir: string }> = [];

afterEach(() => {
  for (const { child, dir } of spawned.splice(0)) {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Test transport: spawns a real local sealantd on a temp Unix socket and connects a `net.Socket`.
 * The acquire/release shape mirrors `DockerExecTransport` — the Scope finalizer destroys the socket
 * and SIGKILLs the daemon — so the service exercises the identical resource-safety contract.
 */
const localSocketTransport: SealantTransportService = {
  open: () =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const dir = mkdtempSync(`${tmpdir()}/sealantd-unit-`);
          const socketPath = `${dir}/control.sock`;
          const child = spawn(
            SEALANTD_BIN,
            ["--socket", socketPath, "--workspace", dir, "--log-level", "warn"],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          spawned.push({ child, dir });

          for (let attempt = 0; attempt < 200 && !existsSync(socketPath); attempt++) {
            await delay(25);
          }
          if (!existsSync(socketPath)) {
            throw new Error("sealantd never created its control socket");
          }

          const socket = connect(socketPath);
          await new Promise<void>((resolve, reject) => {
            socket.once("connect", () => resolve());
            socket.once("error", reject);
          });

          return { socket, child, dir };
        },
        catch: (cause) =>
          new TransportError({
            operation: "open",
            message: cause instanceof Error ? cause.message : "local sealant transport failed",
            cause,
          }),
      }),
      ({ socket, child, dir }) =>
        Effect.sync(() => {
          socket.destroy();
          child.kill("SIGKILL");
          rmSync(dir, { recursive: true, force: true });
        }),
    ).pipe(Effect.map(({ socket }) => socket)),
};

const LocalSocketTransportLive = Layer.succeed(SealantTransport, localSocketTransport);

/** The runtime service wired to the local-socket test transport. */
const TestLayer = SealantRuntimeLive.pipe(Layer.provide(LocalSocketTransportLive));

const TARGET = { kind: "docker-exec" as const, containerId: "unused", socketPath: "unused" };

describe.skipIf(!hasBinary)("SealantRuntime service (local sealantd, docker-free)", () => {
  it("connect -> health round-trips a HEALTHY control channel", async () => {
    const health = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SealantRuntime;
          const session = yield* runtime.connect(TARGET);
          return yield* session.health;
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    expect(health.state).toBe(RuntimeState.HEALTHY);
    expect(health.runtimeId).toMatch(/^rt_/);
  });

  it("connect -> exec -> events Stream yields processStarted + STDOUT + processExited(0)", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SealantRuntime;
          const session = yield* runtime.connect(TARGET);

          const accepted = yield* session.exec({
            executable: "/bin/sh",
            args: ["-c", "echo hi"],
            stdin: false,
          });

          // Drain the telemetry Stream until this process exits, collecting the triad we assert on.
          const events = yield* session.events.pipe(
            Stream.filter(
              (event: EventEnvelope) =>
                event.processId === undefined || event.processId === accepted.processId,
            ),
            Stream.takeUntil((event: EventEnvelope) => event.payload.case === "processExited"),
            Stream.runCollect,
          );

          return { accepted, events };
        }),
      ).pipe(Effect.provide(TestLayer)),
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
  });

  it("maps the SDK's SealantError onto the typed SealantControlError channel", async () => {
    // A non-existent executable makes the daemon return a typed control error; the service must
    // surface it as a tagged `SealantControlError` (with the daemon's numeric code), not a throw.
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SealantRuntime;
          const session = yield* runtime.connect(TARGET);
          return yield* session.exec({
            executable: "/definitely/not/here",
            args: [],
            stdin: false,
          });
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(SealantControlError);
      expect((error as SealantControlError).operation).toBe("exec");
      expect(typeof (error as SealantControlError).code).toBe("number");
    }
  });

  it("releases the transport Duplex when the scope finalizes (Scope finalizer ran)", async () => {
    // Spy transport: wraps the local-socket transport and records the Duplex it yielded so we can
    // assert, AFTER the scope closes, that it was destroyed. `connect`'s acquireRelease closes the
    // SealantClient and the transport's own finalizer then tears the socket down — i.e. the chain of
    // finalizers ran. While the scope is OPEN the socket is live; once closed it must be destroyed.
    let openedDuplex: Duplex | undefined;
    const spyTransport: SealantTransportService = {
      open: (target) =>
        localSocketTransport.open(target).pipe(
          Effect.map((duplex) => {
            openedDuplex = duplex;
            return duplex;
          }),
        ),
    };
    const spyLayer = SealantRuntimeLive.pipe(
      Layer.provide(Layer.succeed(SealantTransport, spyTransport)),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SealantRuntime;
          const session = yield* runtime.connect(TARGET);
          yield* session.health;
          // Inside the scope the transport is live (not yet destroyed).
          expect(openedDuplex?.destroyed).toBe(false);
        }),
      ).pipe(Effect.provide(spyLayer)),
    );

    // Scope has closed: the finalizer chain (client.close() + transport release) destroyed the Duplex.
    expect(openedDuplex).toBeDefined();
    expect(openedDuplex?.destroyed).toBe(true);
  });
});
