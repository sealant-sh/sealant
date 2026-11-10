import http from "node:http";
import type { AddressInfo } from "node:net";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { SealantRuntime, SealantRuntimeControlLive } from "../../sealantd/runtime.js";
import { BoatReadinessError } from "../../worker/boat-readiness.js";
import { BoatSecret } from "./config.js";
import { BoatExecutionError, createBoatGuestTransport } from "./execution.js";
import { boatLaunchDiagnostic } from "./launch-diagnostics.js";

const secret = (value: string) => {
  const parsed = BoatSecret.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const unused = async (): Promise<never> => {
  throw new Error("the probe must not contact the provider");
};

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
});

/** A control frontend: refuses the upgrade with `refusal`, or accepts it and closes on first data. */
const frontend = async (refusal?: { readonly status: number; readonly body: string }) => {
  const server = http.createServer();
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (refusal !== undefined) {
      socket.end(
        `HTTP/1.1 ${String(refusal.status)} Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: ${String(Buffer.byteLength(refusal.body))}\r\nConnection: close\r\n\r\n${refusal.body}`,
      );
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      websocket.once("message", () => websocket.terminate());
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
};

const probeFailure = (origin: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* SealantRuntime;
      const transport = createBoatGuestTransport(
        { get: unused, execute: unused, hostControl: unused },
        runtime,
      );
      return yield* Effect.promise(() =>
        transport
          .probe({ origin, cookie: secret("local-cookie-only") }, secret("a".repeat(64)))
          .then(
            () => undefined,
            (error: unknown) => error,
          ),
      );
    }).pipe(Effect.provide(SealantRuntimeControlLive)),
  );

describe("Boat control probe failure", () => {
  it.each([
    {
      name: "a refused upgrade's status and classified reason",
      refusal: { status: 503, body: JSON.stringify({ error: "control-unavailable" }) },
      control: { operation: "open", status: 503, reason: "control-unavailable" },
    },
    {
      name: "a refused upgrade's status, never its free text",
      refusal: { status: 503, body: JSON.stringify({ error: "The Daemon Said No" }) },
      control: { operation: "open", status: 503 },
    },
    {
      name: "the operation a daemon closed on",
      refusal: undefined,
      control: { operation: "health" },
    },
  ])("keeps $name in the readiness diagnostic", async ({ refusal, control }) => {
    const failure = await probeFailure(await frontend(refusal));
    expect(failure).toBeInstanceOf(BoatExecutionError);
    const diagnostic = boatLaunchDiagnostic(failure, "readiness");
    expect(diagnostic).toEqual({
      step: "readiness",
      errorClass: "TransportError",
      code: "transport-unavailable",
      control,
    });
    // The readiness boundary's message is what the runtime row keeps.
    expect(new BoatReadinessError("unavailable", diagnostic).message).toContain(
      JSON.stringify(control),
    );
  });
});
