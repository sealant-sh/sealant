/**
 * Workspace port forwarding as a WebSocket — `GET /v1/workspaces/:workspaceId/forward?port=N`.
 * `?protocol=udp` opens a connected-UDP forward instead of TCP: one WS binary
 * frame is exactly one datagram, both directions — the daemon conduit is
 * message-framed, so nothing on this path re-chunks.
 *
 * The DATA PLANE for reaching a server that listens inside a workspace (a dev
 * server, a database) from outside it. Authenticates ONCE at the upgrade,
 * opens ONE daemon control connection for the socket's lifetime, opens the
 * daemon's TCP forward to `127.0.0.1:port` INSIDE the workspace — BEFORE the
 * upgrade, so nothing listening is a real HTTP 502, not a WS close code — and
 * pumps raw bytes both ways until either side closes. The payload is never
 * inspected and never recorded: a byte pipe, not evidence.
 *
 * Wire protocol:
 *   server → client   binary frame = bytes from the workspace port
 *   server → client   text frame   = JSON `{"t":"end"}` then close (remote closed)
 *   client → server   binary frame = bytes to the workspace port
 *   client → server   text frame   = JSON `{"t":"eof"}` — half-close: no more
 *                     outbound bytes, keep reading. WebSocket has no native
 *                     half-close, and TCP protocols that shutdown(WR) need one.
 *
 * Auth: `Authorization: Bearer` when the client can set headers, else
 * `?token=` (browser WebSocket cannot). Scope: `workspace:exec` — a forward
 * reaches arbitrary in-workspace servers, the same trust as exec. The target
 * host is a CLOSED set: `127.0.0.1` (default) or `docker`, the
 * workspace-scoped dind sidecar's network alias, where inner `docker compose`
 * publishes its ports. Never caller-arbitrary — that would be an
 * in-container SSRF primitive reaching anything the workspace can route to.
 * Registered as a RAW route (HttpApi cannot express an upgrade).
 */
import { SealantRuntime } from "@sealant/workspaces";
import { Effect, Fiber } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";

import { resolveDaemonTarget } from "../sessions/sessions.module.js";
import { checkForward, type ForwardCheck, type ForwardCheckFailed } from "./forward-checks.js";

const STATUS: Record<ForwardCheck, number> = {
  "invalid-target": 400,
  unauthorized: 401,
  forbidden: 403,
  "owner-required": 400,
  "not-found": 404,
  "workspace-unreadable": 404,
  internal: 500,
};

const refusal = (failure: ForwardCheckFailed, workspaceId: string) =>
  HttpServerResponse.text(
    failure.check === "workspace-unreadable"
      ? `Workspace not found: ${workspaceId}`
      : failure.message,
    { status: STATUS[failure.check] },
  );

export const WorkspaceForwardRoute = HttpRouter.add(
  "GET",
  "/v1/workspaces/:workspaceId/forward",
  (request) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const workspaceId = params["workspaceId"];
      if (workspaceId === undefined) {
        return HttpServerResponse.text("missing workspaceId", { status: 400 });
      }
      const checked = yield* checkForward({
        authorization: request.headers["authorization"],
        url: new URL(request.url, "http://localhost"),
        workspaceId,
      }).pipe(Effect.catch((failure) => Effect.succeed(refusal(failure, workspaceId))));
      if (HttpServerResponse.isHttpServerResponse(checked)) return checked;
      const { port, host, protocol } = checked.target;

      const target = yield* resolveDaemonTarget(workspaceId).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (target === undefined) {
        return HttpServerResponse.text("The workspace runtime is not available.", {
          status: 409,
        });
      }

      const runtime = yield* SealantRuntime;

      // Everything below is scoped to this handler fiber: the client closing
      // the socket interrupts it, and unwinding the scope tears down the
      // daemon connection and with it the forward's socket and pumps.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const daemon = yield* runtime
            .connect(target)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (daemon === undefined) {
            return HttpServerResponse.text("The workspace runtime is not available.", {
              status: 409,
            });
          }
          // Connect INSIDE the workspace before upgrading, like the SSH
          // gateway connects before accepting the channel: a refused connect
          // is an HTTP failure the client can read, not a cryptic WS close.
          const forward = yield* daemon
            .openForward(port, host, protocol)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (forward === undefined) {
            // For UDP there is no handshake to refuse — a 502 here means the
            // daemon could not bind/resolve, not that nothing listens.
            return HttpServerResponse.text(
              `Nothing accepted the connection to ${host}:${port} inside the workspace.`,
              { status: 502 },
            );
          }

          const socket = yield* request.upgrade;
          const { write } = yield* socket.writer;

          // Workspace → client: drain the channel into binary WS frames.
          // Drain-before-close is load-bearing: `channel.closed` can resolve
          // before the inbound tail is consumed; only iterator completion
          // proves the remote's last bytes were delivered.
          const iterator = forward.channel[Symbol.asyncIterator]();
          const pumpOutput = Effect.gen(function* () {
            for (;;) {
              const next = yield* Effect.promise(() => iterator.next());
              if (next.done === true) {
                break;
              }
              yield* write(next.value);
            }
            yield* write(JSON.stringify({ t: "end" }));
            yield* write(new Socket.CloseEvent(1000, "remote closed"));
          }).pipe(Effect.ignore);
          const outputFiber = yield* Effect.forkScoped(pumpOutput);

          // Client → workspace: binary = bytes to the port; text = control
          // JSON ({"t":"eof"} half-closes outbound, inbound keeps flowing).
          const { pull } = yield* socket.reader;
          const onFrame = (data: string | Uint8Array): Effect.Effect<void> => {
            if (typeof data !== "string") {
              forward.channel.write(data);
              return Effect.void;
            }
            try {
              const frame = JSON.parse(data) as { readonly t?: string };
              if (frame.t === "eof") {
                forward.channel.end();
              }
            } catch {
              // Unknown text frame — ignored, not fatal.
            }
            return Effect.void;
          };
          // Every close, clean or not, fails the pull, which ends the loop.
          yield* pull.pipe(
            Effect.flatMap((frames) => Effect.forEach(frames, onFrame, { discard: true })),
            Effect.forever,
            Effect.ignore,
          );
          yield* Fiber.interrupt(outputFiber);
          // Clean client close: reap the forward now instead of waiting for
          // the connection teardown to do it.
          yield* daemon.closeForward(forward.channelId).pipe(Effect.ignore);
          return HttpServerResponse.empty();
        }),
      );
    }),
);
