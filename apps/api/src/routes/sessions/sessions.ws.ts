/**
 * Live session terminal as a WebSocket — `GET /v1/sessions/:sessionId/attach`.
 *
 * The DATA PLANE for interactive terminals. The request/response verbs (input,
 * resize, signal) each pay auth + DB + a short-lived daemon connection per
 * call — correct for control-plane actions, hopeless for keystrokes. This
 * route authenticates ONCE at the upgrade, opens ONE daemon control connection
 * for the socket's lifetime, attaches the daemon's reliable output channel
 * (`attachSession`: byte-exact replay from `?from=`, then live output), and
 * pumps frames both ways until either side closes. No per-event auth, no
 * per-event connections, no journal polling.
 *
 * Wire protocol (subprotocol `sealant.attach.v1`):
 *   server → client   binary frame = PTY output bytes (replay, then live)
 *   server → client   text frame   = JSON `{"t":"end","status":...,"exitCode":...}` then close
 *   client → server   binary frame = PTY input bytes (written to the held connection)
 *   client → server   text frame   = JSON `{"t":"resize","cols":n,"rows":n}` | `{"t":"signal","signal":n}`
 *
 * Auth: `Authorization: Bearer` when the client can set headers, else
 * `?token=` (browser `WebSocket` cannot send headers). Scope: `session:input`
 * — the socket accepts input, so it carries the stricter of the two session
 * scopes. Registered as a RAW route (HttpApi cannot express an upgrade).
 */
import {
  SessionBadRequestError,
  SessionForbiddenError,
  SessionNotFoundError,
  SessionUnauthorizedError,
} from "@sealant/api-contracts";
import { SealantRuntime } from "@sealant/workspaces";
import { Effect, Fiber } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import { authorize, requireSession, resolveDaemonTarget } from "./sessions.module.js";

/** Client → server control frames (text). Unknown shapes are ignored, not fatal. */
interface ControlFrame {
  readonly t?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly signal?: number;
}

export const SessionAttachRoute = HttpRouter.add(
  "GET",
  "/v1/sessions/:sessionId/attach",
  (request) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const sessionId = params["sessionId"];
      if (sessionId === undefined) {
        return HttpServerResponse.text("missing sessionId", { status: 400 });
      }
      const url = new URL(request.url, "http://localhost");
      const fromRaw = url.searchParams.get("from") ?? undefined;
      const ownerUserId = url.searchParams.get("ownerUserId") ?? undefined;
      let from: bigint;
      try {
        from = fromRaw === undefined ? 0n : BigInt(fromRaw);
      } catch {
        return HttpServerResponse.text("from must be a decimal integer", { status: 400 });
      }

      // Browser WebSocket clients cannot set headers; accept the bearer via query.
      const headerAuth = request.headers["authorization"];
      const queryToken = url.searchParams.get("token");
      const authorization =
        headerAuth ?? (queryToken === null ? undefined : `Bearer ${queryToken}`);
      const outcome = yield* authorize({
        headers: authorization === undefined ? {} : { authorization },
        requiredScope: "session:input",
        assertedOwnerUserId: ownerUserId,
      }).pipe(
        Effect.flatMap((principal) => requireSession(sessionId, principal)),
        Effect.map((session) => ({ ok: true as const, session })),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            status:
              error instanceof SessionUnauthorizedError
                ? 401
                : error instanceof SessionForbiddenError
                  ? 403
                  : error instanceof SessionNotFoundError
                    ? 404
                    : error instanceof SessionBadRequestError
                      ? 400
                      : 500,
            message: error.message,
          }),
        ),
      );
      if (!outcome.ok) {
        return HttpServerResponse.text(outcome.message, { status: outcome.status });
      }
      // Daemon verbs address the DAEMON's session id, not the control plane's.
      const daemonSessionId = outcome.session.daemonSessionId;
      if (outcome.session.status !== "running" || daemonSessionId === null) {
        return HttpServerResponse.text(
          `Session ${sessionId} is not running (status: ${outcome.session.status}).`,
          { status: 409 },
        );
      }

      const target = yield* resolveDaemonTarget(outcome.session.workspaceId).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (target === undefined) {
        return HttpServerResponse.text("The workspace runtime is not available.", {
          status: 409,
        });
      }

      const runtime = yield* SealantRuntime;

      // Everything below is scoped to this handler fiber: the client closing
      // the socket interrupts it (NodeHttpServer wires that), and unwinding
      // the scope tears down the daemon connection + its attach channel.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* request.upgrade;
          const daemon = yield* runtime.connect(target);
          const channel = yield* daemon.attachSession(daemonSessionId, { fromSequence: from });
          const write = yield* socket.writer;

          // Daemon → client: drain the reliable channel into binary WS frames.
          // On channel end (session settled or daemon gone) send the terminal
          // text frame and close the socket, which completes `runRaw` below.
          const iterator = channel[Symbol.asyncIterator]();
          const pumpOutput = Effect.gen(function* () {
            for (;;) {
              const next = yield* Effect.promise(() => iterator.next());
              if (next.done === true) {
                break;
              }
              yield* write(next.value);
            }
            yield* write(JSON.stringify({ t: "end" }));
            yield* write(new Socket.CloseEvent(1000, "session settled"));
          }).pipe(Effect.ignore);
          const outputFiber = yield* Effect.forkScoped(pumpOutput);

          // Client → server: binary = PTY input on the HELD connection; text =
          // control JSON. Completes when either side closes the socket.
          yield* socket
            .runRaw((data) => {
              if (typeof data !== "string") {
                return daemon.writeSessionInput(daemonSessionId, data).pipe(Effect.ignore);
              }
              let frame: ControlFrame;
              try {
                frame = JSON.parse(data) as ControlFrame;
              } catch {
                return Effect.void;
              }
              if (
                frame.t === "resize" &&
                typeof frame.cols === "number" &&
                typeof frame.rows === "number"
              ) {
                return daemon
                  .resizePty(daemonSessionId, frame.cols, frame.rows)
                  .pipe(Effect.ignore);
              }
              return Effect.void;
            })
            .pipe(Effect.ignore);
          yield* Fiber.interrupt(outputFiber);
        }),
      );

      return HttpServerResponse.empty();
    }),
);
